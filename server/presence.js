'use strict';
/* ==========================================================================
   server/presence.js — ephemeral player presence (online / in-game) for the
   social layer (docs/FUTURE_ARCHITECTURE.md §2.2/§2.3).

   Presence is high-churn and disposable, so it stays OUT of the relational
   store: 'local' (an in-memory map — the single-instance default) or 'file' (a
   small file per account in a shared dir, so instances see each other's users;
   the Redis backend slots in here later, behind the same contract). Entries
   carry a heartbeat and expire to 'offline' after PRESENCE_TTL_MS, so a crashed
   instance's users don't appear online forever.

   Whichever instance holds a player's connection updates their presence; friends
   read it when they fetch their graph. No sim, no gameplay — just status.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

function memoryBackend() {
  const m = new Map();
  return { put: (id, v) => m.set(id, v), get: (id) => m.get(id) || null, del: (id) => m.delete(id) };
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
  const mode = config.PRESENCE === 'file' ? 'file' : 'local';
  const TTL = config.PRESENCE_TTL_MS | 0 || 60000;
  const region = config.REGION;
  const dir = config.PRESENCE_DIR || path.join(config.SAVE_DIR || 'saves', 'presence');
  const backend = mode === 'file' ? fileBackend(dir, config.log) : memoryBackend();
  const fresh = (p) => !!p && (Date.now() - (p.updatedAt || 0) < TTL);

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
  };
}

module.exports = { createPresence };
