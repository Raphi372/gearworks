'use strict';
/* ==========================================================================
   server/redisCache.js — a write-through local cache backed by Redis, the
   shared shape behind the scalable ephemeral stores (presence, invites, …).

   The ephemeral stores expose a SYNCHRONOUS { put, get, del, all } contract
   (the lobby reads them inline), but Redis I/O is async. This reconciles the two:

     • put/del  — update the local mirror immediately (this instance's own
       entries are always fresh) and replicate to Redis with a TTL in the
       background.
     • get/all  — read the local mirror (synchronous, fast).
     • refresh  — periodically pull the whole keyspace (KEYS + MGET) back into
       the mirror, so other instances' entries become visible within one
       interval — kept well under each store's own expiry.

   A Redis blip degrades the cache (reads keep the last snapshot; writes retry on
   reconnect), never the instance. Keys are namespaced by `prefix`.
   ========================================================================== */
const { createRedis } = require('./redis');

function createRedisCache(config, opts) {
  const ownsClient = !opts.redis;
  const redis = opts.redis || createRedis(config.REDIS_URL, config.log);
  const prefix = opts.prefix;
  const ttlMs = opts.ttlMs | 0 || 60000;
  const refreshMs = opts.refreshMs | 0 || 5000;
  const key = (id) => prefix + encodeURIComponent(id);
  const cache = new Map();

  async function refresh() {
    const keys = await redis.keys(prefix + '*').catch(() => null);
    if (!keys) return;                        // unreachable: keep the last snapshot
    const next = new Map();
    if (keys.length) {
      const vals = await redis.mget(keys).catch(() => []);
      keys.forEach((k, i) => { try { if (vals[i]) next.set(decodeURIComponent(k.slice(prefix.length)), JSON.parse(vals[i])); } catch (e) { /* skip */ } });
    }
    cache.clear();
    for (const [k, v] of next) cache.set(k, v);
  }
  const timer = setInterval(() => { refresh(); }, refreshMs);
  timer.unref();
  refresh();

  return {
    put(id, v) { cache.set(id, v); redis.set(key(id), JSON.stringify(v), ttlMs).catch(() => {}); },
    get(id) { return cache.get(id) || null; },
    del(id) { cache.delete(id); redis.del(key(id)).catch(() => {}); },
    all() { return Array.from(cache.values()); },
    refresh,                                  // exposed for deterministic tests
    close() { clearInterval(timer); if (ownsClient) redis.close(); },
  };
}

module.exports = { createRedisCache };
