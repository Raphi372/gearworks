'use strict';
/* ==========================================================================
   world/directory.js — the room router: invite code → owning game instance.

   This is the foundation of horizontal scale (see docs/FUTURE_ARCHITECTURE.md
   §5). A room is a self-contained authoritative unit that lives on exactly one
   instance; the directory is the shared map that lets any instance (or the
   control plane) answer "which instance owns room ABC123, and how do I reach
   it?" — without touching the simulation.

   It is PURE ROUTING METADATA: no gameplay, no sim, no rules ([DB-1], [A-2]).

   Two backends, one contract ([DB-3]):
     • 'local' (default)  — an in-memory map for the single-process deployment.
       Resolves only this instance's rooms; behaves exactly like today. The $0
       self-host path never leaves this mode.
     • 'file'             — one small JSON file per room in DIRECTORY_DIR, which
       co-located instances share. Each instance writes/removes only the routes
       for the rooms it owns, so there is no cross-process write contention. This
       is the seam a Postgres/Redis backend slots into later (regional scale).

   Routes carry a heartbeat; a route not refreshed within DIRECTORY_STALE_MS is
   treated as dead (its instance crashed) so resolve() fails closed rather than
   handing a client to a corpse.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

/* ---- backends: the minimal { put, get, del, all } storage contract -------- */

function memoryBackend() {
  const m = new Map();
  return {
    put(code, route) { m.set(code, route); },
    putExclusive(code, route) { if (m.has(code)) return false; m.set(code, route); return true; },   // atomic create
    get(code) { return m.get(code) || null; },
    del(code) { m.delete(code); },
    all() { return Array.from(m.values()); },
  };
}

function fileBackend(dir, log) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* created lazily */ }
  const file = (code) => path.join(dir, `${code}.route.json`);
  return {
    put(code, route) {
      try { fs.writeFileSync(file(code), JSON.stringify(route)); }
      catch (e) { log.error(`directory write failed for ${code}: ${e.message}`); }
    },
    // atomic create (O_EXCL): only one instance wins a first claim of a code.
    putExclusive(code, route) {
      try { fs.writeFileSync(file(code), JSON.stringify(route), { flag: 'wx' }); return true; }
      catch (e) { return false; }
    },
    get(code) {
      try { return JSON.parse(fs.readFileSync(file(code), 'utf8')); }
      catch (e) { return null; }
    },
    del(code) { try { fs.unlinkSync(file(code)); } catch (e) { /* already gone */ } },
    all() {
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.route.json')); } catch (e) { return []; }
      const out = [];
      for (const n of names) {
        try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch (e) { /* skip */ }
      }
      return out;
    },
  };
}

function createDirectory(config) {
  const log = config.log;
  const instanceId = config.INSTANCE_ID;
  const region = config.REGION;
  const url = config.PUBLIC_URL || '';          // this instance's reachable ws(s):// URL
  const mode = config.DIRECTORY === 'file' ? 'file' : 'local';
  const STALE_MS = config.DIRECTORY_STALE_MS | 0;   // 0 = routes never expire

  const dir = config.DIRECTORY_DIR || path.join(config.SAVE_DIR || 'saves', 'directory');
  const backend = mode === 'file' ? fileBackend(dir, log) : memoryBackend();
  const fresh = (r) => !!r && (STALE_MS <= 0 || (Date.now() - (r.updatedAt || 0)) < STALE_MS);

  // register / refresh the route for a room WE own
  function register(code, meta) {
    backend.put(code, {
      code, instanceId, region, url,
      name: (meta && meta.name) || code,
      public: !!(meta && meta.public),
      players: (meta && meta.players) | 0,
      updatedAt: Date.now(),
    });
  }
  function deregister(code) { backend.del(code); }

  // Compare-and-set placement (split-brain guard): claim ownership of a code
  // for THIS instance. Succeeds if the code is unclaimed, already ours, or held
  // by a dead (stale) instance; fails if a live OTHER instance owns it. The
  // exclusive create makes the first claim atomic across processes.
  function claim(code, meta) {
    const route = { code, instanceId, region, url,
      name: (meta && meta.name) || code, public: !!(meta && meta.public),
      players: (meta && meta.players) | 0, updatedAt: Date.now() };
    if (backend.putExclusive(code, route)) return true;
    const existing = backend.get(code);
    if (fresh(existing) && existing.instanceId !== instanceId) return false;   // owned by a live peer
    backend.put(code, route);                                                  // stale or already ours
    return true;
  }
  // is this code owned by a live instance OTHER than us? (for code generation)
  function ownedElsewhere(code) { const r = backend.get(code); return fresh(r) && r.instanceId !== instanceId; }

  // resolve a code → { instanceId, region, url, players, self } or null (unknown/stale)
  function resolve(code) {
    const r = backend.get(code);
    if (!fresh(r)) return null;
    return { instanceId: r.instanceId, region: r.region, url: r.url, players: r.players | 0,
      public: !!r.public, self: r.instanceId === instanceId };
  }

  // fresh routes, optionally filtered — the seed of an aggregated public listing
  function list(filter) {
    filter = filter || {};
    return backend.all().filter((r) => fresh(r)
      && (filter.public === undefined || !!r.public === !!filter.public)
      && (filter.region === undefined || r.region === filter.region))
      .map((r) => ({ code: r.code, name: r.name || r.code, region: r.region, url: r.url,
        players: r.players | 0, public: !!r.public, self: r.instanceId === instanceId }));
  }

  return { mode, instanceId, region, url, register, deregister, resolve, list, claim, ownedElsewhere };
}

module.exports = { createDirectory };
