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
  function splitSnapshot(code, snapshot) {
    if (!snapshots.external) return { snapshot, snapshotRef: null };
    return { snapshot: Prisma ? Prisma.DbNull : null, snapshotRef: snapshots.put(code, snapshot) };
  }
  function hydrate(w) {
    if (!w) return null;
    const snapshot = (w.snapshotRef && w.snapshot == null) ? snapshots.get(w.snapshotRef) : w.snapshot;
    return { w, snapshot };
  }
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

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
        const { snapshot, snapshotRef } = splitSnapshot(code, data.snapshot);
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
    ready: async () => { await prisma.$queryRaw`SELECT 1`; },
    saveRoom(code, data) { pending.set(code, data); drain(); return true; },     // fire-and-forget
    async loadRoom(code) {
      const w = await prisma.world.findUnique({ where: { code } }).catch(() => null);
      if (!w) return null;
      const h = hydrate(w);
      return { meta: { name: w.name, code: w.code, ownerId: w.ownerId }, snapshot: h.snapshot };
    },
    loadFile: () => Promise.resolve(null),        // not applicable to the DB backend
    async listRoomCodes() {
      const rows = await prisma.world.findMany({ select: { code: true } }).catch(() => []);
      return rows.map((r) => r.code);
    },
    async worldsByOwner(ownerId) {
      const rows = await prisma.world.findMany({
        where: { ownerId }, select: { code: true, name: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }).catch(() => []);
      return rows.map((r) => ({ code: r.code, name: r.name, savedAt: +r.savedAt }));
    },
    async worldsByMember(accountId) {
      const rows = await prisma.worldMember.findMany({
        where: { accountId },
        include: { world: { select: { code: true, name: true, ownerId: true, savedAt: true } } },
        orderBy: { world: { savedAt: 'desc' } },
      }).catch(() => []);
      return rows.map((m) => ({ code: m.world.code, name: m.world.name, ownerId: m.world.ownerId,
        role: String(m.role).toLowerCase(), savedAt: +m.world.savedAt }));
    },
    async membership(accountId, code) {
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
    async statsFor(accountId) {
      const rows = await prisma.stat.findMany({ where: { accountId }, orderBy: { recordedAt: 'asc' } }).catch(() => []);
      const out = {};
      rows.forEach((r) => { (out[r.key] || (out[r.key] = [])).push({ t: +r.recordedAt, v: Number(r.value) }); });
      return out;
    },
    async topFactories(limit) {
      const rows = await prisma.factory.findMany({
        orderBy: { money: 'desc' }, take: limit || 20,
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
      return rows.map((w) => ({ code: w.code, name: w.name, ownerId: w.ownerId,
        public: w.isPublic, snapshot: hydrate(w).snapshot, savedAt: +w.savedAt }));
    },
    flush: () => drain(),
    async close() { await drain(); await prisma.$disconnect(); },

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
