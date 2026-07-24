'use strict';
/* ==========================================================================
   server/presence.js — ephemeral player presence (online / in-game) for the
   social layer (docs/FUTURE_ARCHITECTURE.md §2.2/§2.3).

   Presence is high-churn and disposable, so it stays OUT of the relational
   store: 'local' (an in-memory map — the single-instance default), 'file' (a
   small file per account in a shared dir, so instances see each other's users),
   or 'redis' (a shared cache — the scale option). Entries carry a heartbeat and
   expire to 'offline' after PRESENCE_TTL_MS, so a crashed instance's users don't
   appear online forever.

   All three backends keep the SAME synchronous {put,get,del} contract (the lobby
   reads presence synchronously while enriching a friends list). Redis I/O is
   async, so the redis backend is a WRITE-THROUGH local cache: writes update the
   cache immediately (this instance's own users are always fresh) and replicate
   to Redis in the background; a periodic refresh pulls the whole cluster's
   presence back into the cache, so other instances' users become visible within
   one refresh interval — well under the presence TTL.

   Whichever instance holds a player's connection updates their presence; friends
   read it when they fetch their graph. No sim, no gameplay — just status.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { createRedisCache } = require('./redisCache');

function memoryBackend() {
  const m = new Map();
  return { put: (id, v) => m.set(id, v), get: (id) => m.get(id) || null, del: (id) => m.delete(id) };
}
// shared cache backend: the write-through Redis mirror (see server/redisCache.js)
// keeps the synchronous contract while sharing presence across instances.
function redisBackend(config) {
  return createRedisCache(config, { prefix: 'gw:presence:', ttlMs: config.PRESENCE_TTL_MS, refreshMs: config.PRESENCE_REFRESH_MS });
}
function fileBackend(dir, log) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* lazy */ }
  const file = (id) => path.join(dir, `${encodeURIComponent(id)}.pres.json`);
  return {
    put(id, v) { try { fs.writeFileSync(file(id), JSON.stringify(v)); } catch (e) { log.error(`presence write ${id}: ${e.message}`); } },
    get(id) { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (e) { return null; } },
    del(id) { try { fs.unlinkSync(file(id)); } catch (e) { /* gone */ } },
  };
}

function createPresence(config) {
  const mode = ['file', 'redis'].includes(config.PRESENCE) ? config.PRESENCE : 'local';
  const TTL = config.PRESENCE_TTL_MS | 0 || 60000;
  const region = config.REGION;
  const dir = config.PRESENCE_DIR || path.join(config.SAVE_DIR || 'saves', 'presence');
  const backend = mode === 'redis' ? redisBackend(config)
    : mode === 'file' ? fileBackend(dir, config.log) : memoryBackend();
  const fresh = (p) => !!p && (Date.now() - (p.updatedAt || 0) < TTL);
  if (mode === 'redis') config.log('presence: redis backend (shared cache)');

  return {
    mode,
    // status: 'online' (in the lobby) | 'ingame' (in a room)
    set(accountId, info) {
      if (!accountId) return;
      backend.put(accountId, { status: (info && info.status) || 'online', region,
        roomCode: (info && info.roomCode) || null, updatedAt: Date.now() });
    },
    clear(accountId) { if (accountId) backend.del(accountId); },
    get(accountId) {
      const p = backend.get(accountId);
      if (!fresh(p)) return { status: 'offline', online: false };
      return { status: p.status, online: true, roomCode: p.roomCode || null, region: p.region };
    },
    refresh() { return backend.refresh ? backend.refresh() : Promise.resolve(); },
    close() { if (backend.close) backend.close(); },
  };
}

module.exports = { createPresence };
