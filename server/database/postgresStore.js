'use strict';
/* ==========================================================================
   database/postgresStore.js — production persistence backend (optional).

   Activated with STORAGE=postgres + DATABASE_URL. Uses Prisma (an optional
   dependency — only installed for production images), so the default
   zero-install file backend is never burdened by it. The Prisma schema lives
   in prisma/schema.prisma; see docs/DATABASE.md.

   Room snapshots are written asynchronously (queued, drained on flush()) so
   the authoritative game loop never blocks on the database. Account/world/
   progression/stats live in relational tables for the persistent metagame.
   ========================================================================== */
const Progression = require('../../shared/progression.js');
const { createRouting } = require('./replica');

function createPostgresStore(config, snapshots) {
  const { DATABASE_URL, log } = config;
  if (!DATABASE_URL) throw new Error('STORAGE=postgres requires DATABASE_URL');
  const STAT_KEEP = config.STAT_KEEP || 168;
  snapshots = snapshots || { external: false };   // snapshot blob store (inline by default)

  let PrismaClient, Prisma;
  try { ({ PrismaClient, Prisma } = require('@prisma/client')); }
  catch (e) {
    throw new Error('STORAGE=postgres requires the @prisma/client package. Run `npm install` and `npm run db:generate`.');
  }
  // when snapshots live externally the JSONB column holds SQL NULL and a
  // snapshotRef points at the blob; else the snapshot is stored inline as before.
  // The blob store may be async (s3), so both helpers are async and awaited.
  async function splitSnapshot(code, snapshot) {
    if (!snapshots.external) return { snapshot, snapshotRef: null };
    return { snapshot: Prisma ? Prisma.DbNull : null, snapshotRef: await snapshots.put(code, snapshot) };
  }
  async function hydrate(w) {
    if (!w) return null;
    const snapshot = (w.snapshotRef && w.snapshot == null) ? await snapshots.get(w.snapshotRef) : w.snapshot;
    return { w, snapshot };
  }

  // an ACCEPTED friendship is stored as a row in both directions
  async function acceptPair(me, other) {
    await prisma.$transaction([
      prisma.friendship.upsert({ where: { accountId_otherId: { accountId: me, otherId: other } }, create: { accountId: me, otherId: other, status: 'ACCEPTED' }, update: { status: 'ACCEPTED' } }),
      prisma.friendship.upsert({ where: { accountId_otherId: { accountId: other, otherId: me } }, create: { accountId: other, otherId: me, status: 'ACCEPTED' }, update: { status: 'ACCEPTED' } }),
    ]).catch((e) => log.error(`pg friend accept failed: ${e.message}`));
    return { ok: true };
  }
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  // optional read replica: lag-tolerant reads route here, writes + authz reads
  // stay on the primary ([DB-9]). `db.read` is the replica when configured.
  const replica = config.DATABASE_REPLICA_URL
    ? new PrismaClient({ datasources: { db: { url: config.DATABASE_REPLICA_URL } } })
    : null;
  const db = createRouting(prisma, replica);
  if (db.hasReplica) log('persistence: read replica active (listing/leaderboard/stats reads)');

  // app role (lowercase) -> Prisma Role enum
  function roleEnum(r) { const R = String(r || '').toUpperCase(); return ['HOST', 'ADMIN', 'PLAYER', 'SPECTATOR'].includes(R) ? R : 'PLAYER'; }

  // async write queue so Room.save() (called from the sim loop) never awaits
  const pending = new Map();   // code -> latest data (coalesced)
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.size) {
        const [code, data] = pending.entries().next().value;
        pending.delete(code);
        const ownerId = data.meta.ownerId || null;
        const isPublic = !!data.meta.public;
        const { snapshot, snapshotRef } = await splitSnapshot(code, data.snapshot);
        const w = await prisma.world.upsert({
          where: { code },
          create: { code, name: data.meta.name, snapshot, snapshotRef, savedAt: new Date(), ownerId, isPublic },
          update: { name: data.meta.name, snapshot, snapshotRef, savedAt: new Date(), ownerId, isPublic },
        }).catch((e) => { log.error(`pg save failed for room ${code}: ${e.message}`); return null; });
        // derived leaderboard projection (one row per world)
        const p = w && data.meta.projection;
        if (p) {
          const techIds = Array.isArray(p.techIds) ? p.techIds : [];
          await prisma.factory.upsert({
            where: { worldId: w.id },
            create: { worldId: w.id, entityCount: p.entities | 0, money: p.money | 0, techTier: p.tech | 0, techIds },
            update: { entityCount: p.entities | 0, money: p.money | 0, techTier: p.tech | 0, techIds },
          }).catch((e) => log.error(`pg factory save failed for ${code}: ${e.message}`));
        }
        // persistent membership (upsert per member; existing rows are never
        // dropped, so members accumulate across saves)
        const members = w && Array.isArray(data.meta.members) ? data.meta.members : [];
        for (const mem of members) {
          if (!mem || !mem.aid) continue;
          await prisma.worldMember.upsert({
            where: { accountId_worldId: { accountId: mem.aid, worldId: w.id } },
            create: { accountId: mem.aid, worldId: w.id, role: roleEnum(mem.role) },
            update: { role: roleEnum(mem.role) },
          }).catch((e) => log.error(`pg member save failed for ${code}: ${e.message}`));
        }
      }
    } finally { draining = false; }
  }

  // map a Prisma Account row to the backend-neutral account shape used by auth
  function toAcct(a) {
    return a && { id: a.id, username: a.username, color: a.color,
      passwordHash: a.passwordHash, guest: a.isGuest, createdAt: +a.createdAt,
      email: a.email || null, emailVerified: !!a.emailVerified, tokenVersion: a.tokenVersion || 0 };
  }

  return {
    kind: 'postgres',
    accountsEnabled: true,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;   // the primary must be up; boot fails otherwise
      // a replica outage is non-fatal — reads degrade to empty and can be pointed
      // back at the primary by clearing DATABASE_REPLICA_URL; just warn.
      if (replica) await replica.$queryRaw`SELECT 1`.catch((e) => log.warn(`read replica not reachable: ${e.message}`));
    },
    saveRoom(code, data) { pending.set(code, data); drain(); return true; },     // fire-and-forget
    async loadRoom(code) {
      const w = await prisma.world.findUnique({ where: { code } }).catch(() => null);
      if (!w) return null;
      const h = await hydrate(w);
      return { meta: { name: w.name, code: w.code, ownerId: w.ownerId }, snapshot: h.snapshot };
    },
    loadFile: () => Promise.resolve(null),        // not applicable to the DB backend
    async listRoomCodes() {
      const rows = await prisma.world.findMany({ select: { code: true } }).catch(() => []);
      return rows.map((r) => r.code);
    },
    async worldsByOwner(ownerId) {   // "my worlds" listing — lag-tolerant → replica
      const rows = await db.read.world.findMany({
        where: { ownerId }, select: { code: true, name: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }).catch(() => []);
      return rows.map((r) => ({ code: r.code, name: r.name, savedAt: +r.savedAt }));
    },
    async worldsByMember(accountId) {   // "my worlds" listing — lag-tolerant → replica
      const rows = await db.read.worldMember.findMany({
        where: { accountId },
        include: { world: { select: { code: true, name: true, ownerId: true, savedAt: true } } },
        orderBy: { world: { savedAt: 'desc' } },
      }).catch(() => []);
      return rows.map((m) => ({ code: m.world.code, name: m.world.name, ownerId: m.world.ownerId,
        role: String(m.role).toLowerCase(), savedAt: +m.world.savedAt }));
    },
    async membership(accountId, code) {   // AUTHZ read — always primary ([DB-9])
      const w = await prisma.world.findUnique({ where: { code }, select: { id: true } }).catch(() => null);
      if (!w) return null;
      const m = await prisma.worldMember.findUnique({ where: { accountId_worldId: { accountId, worldId: w.id } } }).catch(() => null);
      return m ? { role: String(m.role).toLowerCase() } : null;
    },
    // cross-world progression: aggregate the account's worlds' Factory
    // projections into level/xp/unlockedTech, persist the derived Progression
    // row (the modelled table stays live for future queries), and return it.
    async progression(accountId) {
      const [owned, memberships] = await Promise.all([
        prisma.world.findMany({ where: { ownerId: accountId }, include: { factories: true } }).catch(() => []),
        prisma.worldMember.findMany({ where: { accountId }, include: { world: { include: { factories: true } } } }).catch(() => []),
      ]);
      const byId = new Map();
      owned.forEach((w) => byId.set(w.id, w));
      memberships.forEach((m) => { if (m.world) byId.set(m.world.id, m.world); });
      const worlds = Array.from(byId.values()).map((w) => {
        const f = w.factories && w.factories[0];
        return { projection: f ? { money: f.money, entities: f.entityCount, tech: f.techTier, techIds: f.techIds || [] } : {} };
      });
      const summary = Progression.summarize(worlds);
      await prisma.progression.upsert({
        where: { accountId },
        create: { accountId, level: summary.level, xp: summary.xp, unlockedTech: summary.unlockedTech },
        update: { level: summary.level, xp: summary.xp, unlockedTech: summary.unlockedTech },
      }).catch((e) => log.error(`pg progression save failed for ${accountId}: ${e.message}`));
      return summary;
    },
    // append one time-series point per metric, then prune each metric to the
    // newest STAT_KEEP rows so the table stays bounded.
    async recordStats(accountId, samples, at) {
      if (!accountId || !samples) return;
      const recordedAt = at ? new Date(at) : new Date();
      for (const key of Object.keys(samples)) {
        const value = BigInt(Math.trunc(Number(samples[key]) || 0));
        await prisma.stat.create({ data: { accountId, key, value, recordedAt } })
          .catch((e) => log.error(`pg stat save failed for ${accountId}/${key}: ${e.message}`));
        const stale = await prisma.stat.findMany({
          where: { accountId, key }, orderBy: { recordedAt: 'desc' }, skip: STAT_KEEP, select: { id: true },
        }).catch(() => []);
        if (stale.length) await prisma.stat.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } }).catch(() => {});
      }
    },
    async statsFor(accountId) {   // stats history display — lag-tolerant → replica
      const rows = await db.read.stat.findMany({ where: { accountId }, orderBy: { recordedAt: 'asc' } }).catch(() => []);
      const out = {};
      rows.forEach((r) => { (out[r.key] || (out[r.key] = [])).push({ t: +r.recordedAt, v: Number(r.value) }); });
      return out;
    },

    /* ---- social graph ---- */
    async friendGraph(accountId) {
      const mine = await prisma.friendship.findMany({ where: { accountId }, include: { other: { select: { id: true, username: true } } } }).catch(() => []);
      const incoming = await prisma.friendship.findMany({ where: { otherId: accountId, status: 'PENDING' }, include: { account: { select: { id: true, username: true } } } }).catch(() => []);
      const pick = (r) => ({ id: r.other.id, username: r.other.username });
      return {
        friends: mine.filter((r) => r.status === 'ACCEPTED').map(pick),
        outgoing: mine.filter((r) => r.status === 'PENDING').map(pick),
        blocked: mine.filter((r) => r.status === 'BLOCKED').map(pick),
        incoming: incoming.map((r) => ({ id: r.account.id, username: r.account.username })),
      };
    },
    async friendRequest(from, to) {
      if (!from || !to || from === to) return { error: 'invalid target' };
      const blocks = await prisma.friendship.findMany({ where: { status: 'BLOCKED', OR: [{ accountId: from, otherId: to }, { accountId: to, otherId: from }] } }).catch(() => []);
      if (blocks.length) return { error: 'unavailable' };
      const mine = await prisma.friendship.findUnique({ where: { accountId_otherId: { accountId: from, otherId: to } } }).catch(() => null);
      if (mine && mine.status === 'ACCEPTED') return { ok: true };
      const reverse = await prisma.friendship.findUnique({ where: { accountId_otherId: { accountId: to, otherId: from } } }).catch(() => null);
      if (reverse && reverse.status === 'PENDING') return acceptPair(from, to);   // they already asked
      await prisma.friendship.upsert({ where: { accountId_otherId: { accountId: from, otherId: to } }, create: { accountId: from, otherId: to, status: 'PENDING' }, update: { status: 'PENDING' } }).catch((e) => log.error(`pg friend req failed: ${e.message}`));
      return { ok: true };
    },
    async friendRespond(me, other, accept) {
      const req = await prisma.friendship.findUnique({ where: { accountId_otherId: { accountId: other, otherId: me } } }).catch(() => null);
      if (!req || req.status !== 'PENDING') return { error: 'no pending request' };
      if (accept) return acceptPair(me, other);
      await prisma.friendship.deleteMany({ where: { accountId: other, otherId: me, status: 'PENDING' } }).catch(() => {});
      return { ok: true };
    },
    async friendRemove(me, other) {
      await prisma.friendship.deleteMany({ where: { status: { in: ['ACCEPTED', 'PENDING'] }, OR: [{ accountId: me, otherId: other }, { accountId: other, otherId: me }] } }).catch(() => {});
      return { ok: true };
    },
    async friendBlock(me, other, blocked) {
      if (!other || me === other) return { error: 'invalid target' };
      if (blocked) {
        await prisma.friendship.deleteMany({ where: { status: { in: ['ACCEPTED', 'PENDING'] }, OR: [{ accountId: me, otherId: other }, { accountId: other, otherId: me }] } }).catch(() => {});
        await prisma.friendship.upsert({ where: { accountId_otherId: { accountId: me, otherId: other } }, create: { accountId: me, otherId: other, status: 'BLOCKED' }, update: { status: 'BLOCKED' } }).catch(() => {});
      } else {
        await prisma.friendship.deleteMany({ where: { accountId: me, otherId: other, status: 'BLOCKED' } }).catch(() => {});
      }
      return { ok: true };
    },
    /* ---- profiles: bio + equipped cosmetic loadout (ownership is derived) ---- */
    async getProfile(id) {
      const p = await prisma.profile.findUnique({ where: { accountId: id } }).catch(() => null);
      return { bio: (p && p.bio) || '', equipped: (p && p.equipped) || {} };
    },
    async setProfile(id, patch) {
      const create = { accountId: id, bio: patch.bio || '', equipped: patch.equipped || {} };
      const update = {};
      if (patch.bio !== undefined) update.bio = patch.bio;
      if (patch.equipped !== undefined) update.equipped = patch.equipped;
      await prisma.profile.upsert({ where: { accountId: id }, create, update })
        .catch((e) => log.error(`pg profile save failed for ${id}: ${e.message}`));
      return this.getProfile(id);
    },
    /* ---- moderation: account bans ---- */
    async banAccount(id, ban) {
      const until = ban.until ? new Date(ban.until) : null;
      await prisma.ban.upsert({
        where: { accountId: id },
        create: { accountId: id, reason: ban.reason || '', by: ban.by || '', until },
        update: { reason: ban.reason || '', by: ban.by || '', until },
      }).catch((e) => log.error(`pg ban failed for ${id}: ${e.message}`));
      return { ok: true };
    },
    async unbanAccount(id) {
      await prisma.ban.deleteMany({ where: { accountId: id } }).catch(() => {});
      return { ok: true };
    },
    async getBan(id) {
      const b = await prisma.ban.findUnique({ where: { accountId: id } }).catch(() => null);
      if (!b) return null;
      if (b.until && +b.until <= Date.now()) { await this.unbanAccount(id); return null; }   // lapsed
      return { reason: b.reason, by: b.by, at: +b.createdAt, until: b.until ? +b.until : 0 };
    },
    async listBans() {
      const rows = await prisma.ban.findMany({
        where: { OR: [{ until: null }, { until: { gt: new Date() } }] },
        include: { account: { select: { username: true } } }, orderBy: { createdAt: 'desc' },
      }).catch(() => []);
      return rows.map((b) => ({ id: b.accountId, username: b.account ? b.account.username : null,
        reason: b.reason, by: b.by, at: +b.createdAt, until: b.until ? +b.until : 0 }));
    },
    // one report per (reporter, target): re-reporting reopens/updates the row
    async createReport(r) {
      const reason = String(r.reason || '').slice(0, 300);
      await prisma.report.upsert({
        where: { reporterId_targetId: { reporterId: r.reporterId, targetId: r.targetId } },
        create: { reporterId: r.reporterId, targetId: r.targetId, reason, status: 'OPEN' },
        update: { reason, status: 'OPEN', createdAt: new Date() },
      }).catch((e) => log.error(`pg report failed: ${e.message}`));
      return { ok: true };
    },
    async listReports() {
      const rows = await prisma.report.findMany({
        where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' },
        include: { reporter: { select: { username: true } }, target: { select: { username: true } } },
      }).catch(() => []);
      return rows.map((r) => ({ id: r.id, reporterId: r.reporterId, reporter: r.reporter ? r.reporter.username : null,
        targetId: r.targetId, target: r.target ? r.target.username : null, reason: r.reason, at: +r.createdAt }));
    },
    async resolveReport(id, status) {
      await prisma.report.update({ where: { id }, data: { status: status === 'resolved' ? 'RESOLVED' : 'DISMISSED' } }).catch(() => {});
      return { ok: true };
    },
    // one flag row per account; latest reason/score/room win, count increments
    async recordFlag(f) {
      const replay = Array.isArray(f.replay) ? f.replay : [];
      await prisma.flag.upsert({
        where: { accountId: f.accountId },
        create: { accountId: f.accountId, reason: f.reason || '', score: f.score | 0, roomCode: f.roomCode || null, count: 1, replay },
        update: { reason: f.reason || '', score: f.score | 0, roomCode: f.roomCode || null, count: { increment: 1 }, replay },
      }).catch((e) => log.error(`pg flag failed for ${f.accountId}: ${e.message}`));
      return { ok: true };
    },
    async listFlags() {
      const rows = await prisma.flag.findMany({
        orderBy: { updatedAt: 'desc' }, include: { account: { select: { username: true } } },
      }).catch(() => []);
      return rows.map((f) => ({ id: f.accountId, name: f.account ? f.account.username : null,
        roomCode: f.roomCode, reason: f.reason, score: f.score, count: f.count, at: +f.updatedAt,
        replay: Array.isArray(f.replay) ? f.replay : [] }));
    },
    async clearFlag(id) {
      await prisma.flag.deleteMany({ where: { accountId: id } }).catch(() => {});
      return { ok: true };
    },
    // record the currently-unlocked achievement keys; return the newly-recorded
    // ones ("new" to announce). Ownership stays derived — this is just a ledger.
    async markAchievements(accountId, keys) {
      if (!accountId || !keys || !keys.length) return [];
      const existing = await prisma.achievementUnlock.findMany({
        where: { accountId, key: { in: keys } }, select: { key: true },
      }).catch(() => []);
      const seen = new Set(existing.map((r) => r.key));
      const fresh = keys.filter((k) => !seen.has(k));
      if (fresh.length) {
        await prisma.achievementUnlock.createMany({
          data: fresh.map((key) => ({ accountId, key })), skipDuplicates: true,
        }).catch((e) => log.error(`pg achievement mark failed for ${accountId}: ${e.message}`));
      }
      return fresh;
    },
    async topFactories(limit, ownerIds) {   // leaderboard — lag-tolerant → replica
      const where = (ownerIds && ownerIds.length) ? { world: { ownerId: { in: ownerIds } } } : {};
      const rows = await db.read.factory.findMany({
        where, orderBy: { money: 'desc' }, take: limit || 20,
        include: { world: { select: { code: true, name: true, ownerId: true, savedAt: true, owner: { select: { username: true } } } } },
      }).catch(() => []);
      return rows.map((f) => ({
        code: f.world.code, name: f.world.name, ownerId: f.world.ownerId,
        ownerName: f.world.owner ? f.world.owner.username : null,
        money: f.money, tech: f.techTier, entities: f.entityCount, savedAt: +f.world.savedAt,
      }));
    },
    async recentRooms(sinceMs) {
      const rows = await prisma.world.findMany({
        where: { savedAt: { gte: new Date(sinceMs) } },
        orderBy: { savedAt: 'desc' },
      }).catch(() => []);
      return Promise.all(rows.map(async (w) => ({ code: w.code, name: w.name, ownerId: w.ownerId,
        public: w.isPublic, snapshot: (await hydrate(w)).snapshot, savedAt: +w.savedAt })));
    },
    flush: () => drain(),
    async close() { await drain(); await prisma.$disconnect(); if (replica) await replica.$disconnect().catch(() => {}); },

    /* ---- accounts ---- */
    async getAccountByName(name) {
      return toAcct(await prisma.account.findUnique({ where: { username: String(name).toLowerCase() } }).catch(() => null));
    },
    async getAccountByEmail(email) {
      return toAcct(await prisma.account.findUnique({ where: { email: String(email).toLowerCase() } }).catch(() => null));
    },
    async getAccount(id) { return toAcct(await prisma.account.findUnique({ where: { id } }).catch(() => null)); },
    async createAccount(acct) {
      try {
        const a = await prisma.account.create({ data: {
          id: acct.id, username: acct.username.toLowerCase(), displayName: acct.username,
          color: acct.color, passwordHash: acct.passwordHash || null, isGuest: !!acct.guest,
          email: acct.email ? String(acct.email).toLowerCase() : null } });
        return toAcct(a);
      } catch (e) { return null; }   // unique violation = username/email taken
    },
    async updateAccount(id, patch) {
      const data = {};
      if (patch.color) data.color = patch.color;
      if (patch.lastSeenAt) data.lastSeenAt = new Date(patch.lastSeenAt);
      if (patch.passwordHash) data.passwordHash = patch.passwordHash;
      if (patch.email !== undefined) data.email = patch.email ? String(patch.email).toLowerCase() : null;
      if (patch.emailVerified !== undefined) data.emailVerified = !!patch.emailVerified;
      if (patch.tokenVersion !== undefined) data.tokenVersion = patch.tokenVersion | 0;
      return toAcct(await prisma.account.update({ where: { id }, data }).catch(() => null));
    },
    prisma,   // exposed for progression/stats queries later
  };
}

module.exports = { createPostgresStore };
