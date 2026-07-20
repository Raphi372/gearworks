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
function createPostgresStore(config) {
  const { DATABASE_URL, log } = config;
  if (!DATABASE_URL) throw new Error('STORAGE=postgres requires DATABASE_URL');

  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); }
  catch (e) {
    throw new Error('STORAGE=postgres requires the @prisma/client package. Run `npm install` and `npm run db:generate`.');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

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
        await prisma.world.upsert({
          where: { code },
          create: { code, name: data.meta.name, snapshot: data.snapshot, savedAt: new Date(), ownerId },
          update: { name: data.meta.name, snapshot: data.snapshot, savedAt: new Date(), ownerId },
        }).catch((e) => log.error(`pg save failed for room ${code}: ${e.message}`));
      }
    } finally { draining = false; }
  }

  // map a Prisma Account row to the backend-neutral account shape used by auth
  function toAcct(a) {
    return a && { id: a.id, username: a.username, color: a.color,
      passwordHash: a.passwordHash, guest: a.isGuest, createdAt: +a.createdAt };
  }

  return {
    kind: 'postgres',
    accountsEnabled: true,
    ready: async () => { await prisma.$queryRaw`SELECT 1`; },
    saveRoom(code, data) { pending.set(code, data); drain(); return true; },     // fire-and-forget
    async loadRoom(code) {
      const w = await prisma.world.findUnique({ where: { code } }).catch(() => null);
      return w ? { meta: { name: w.name, code: w.code, ownerId: w.ownerId }, snapshot: w.snapshot } : null;
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
    flush: () => drain(),
    async close() { await drain(); await prisma.$disconnect(); },

    /* ---- accounts ---- */
    async getAccountByName(name) {
      return toAcct(await prisma.account.findUnique({ where: { username: String(name).toLowerCase() } }).catch(() => null));
    },
    async getAccount(id) { return toAcct(await prisma.account.findUnique({ where: { id } }).catch(() => null)); },
    async createAccount(acct) {
      try {
        const a = await prisma.account.create({ data: {
          id: acct.id, username: acct.username.toLowerCase(), displayName: acct.username,
          color: acct.color, passwordHash: acct.passwordHash || null, isGuest: !!acct.guest } });
        return toAcct(a);
      } catch (e) { return null; }   // unique violation = username taken
    },
    async updateAccount(id, patch) {
      const data = {};
      if (patch.color) data.color = patch.color;
      if (patch.lastSeenAt) data.lastSeenAt = new Date(patch.lastSeenAt);
      return toAcct(await prisma.account.update({ where: { id }, data }).catch(() => null));
    },
    prisma,   // exposed for progression/stats queries later
  };
}

module.exports = { createPostgresStore };
