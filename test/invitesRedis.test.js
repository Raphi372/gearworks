'use strict';
/* The redis (shared write-through cache) backend for world invites (Phase 3),
   built on the same server/redisCache.js as presence. Exercised against an
   in-process mock RESP server: an invite created on one instance is visible to
   the recipient on another after a cache refresh, and expiry/removal propagate. */
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createInvites } = require('../server/invites');

const quiet = () => { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; };

// minimal RESP server: PING/AUTH/SET(+PX)/GET/DEL/KEYS/MGET (same as redis.test.js)
function mockRedis() {
  const store = new Map();
  const alive = (e) => !e || e.exp === 0 || e.exp > Date.now();
  function reply(v) {
    if (v === null) return '$-1\r\n';
    if (typeof v === 'number') return `:${v}\r\n`;
    if (Array.isArray(v)) return `*${v.length}\r\n` + v.map(reply).join('');
    if (v && v.simple) return `+${v.simple}\r\n`;
    return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
  }
  function handle(a) {
    const cmd = String(a[0]).toUpperCase();
    if (cmd === 'PING') return { simple: 'PONG' };
    if (cmd === 'AUTH') return { simple: 'OK' };
    if (cmd === 'SET') { let exp = 0; const px = a.indexOf('PX'); if (px > 0) exp = Date.now() + Number(a[px + 1]); store.set(a[1], { val: a[2], exp }); return { simple: 'OK' }; }
    if (cmd === 'GET') { const e = store.get(a[1]); return e && alive(e) ? e.val : null; }
    if (cmd === 'DEL') { let n = 0; for (let i = 1; i < a.length; i++) if (store.delete(a[i])) n++; return n; }
    if (cmd === 'KEYS') { const pre = String(a[1]).replace(/\*$/, ''); return [...store.keys()].filter((k) => k.startsWith(pre) && alive(store.get(k))); }
    if (cmd === 'MGET') return a.slice(1).map((k) => { const e = store.get(k); return e && alive(e) ? e.val : null; });
    return { simple: 'OK' };
  }
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf[0] !== 0x2a) break;
        const nl = buf.indexOf('\r\n'); if (nl < 0) break;
        const n = Number(buf.toString('utf8', 1, nl));
        let off = nl + 2; const args = []; let ok = true;
        for (let i = 0; i < n; i++) {
          const l2 = buf.indexOf('\r\n', off); if (l2 < 0) { ok = false; break; }
          const len = Number(buf.toString('utf8', off + 1, l2));
          const start = l2 + 2, end = start + len;
          if (buf.length < end + 2) { ok = false; break; }
          args.push(buf.toString('utf8', start, end)); off = end + 2;
        }
        if (!ok) break;
        buf = buf.slice(off);
        sock.write(reply(handle(args)));
      }
    });
    sock.on('error', () => {});
  });
  return { server, store };
}

test('redis world invites are shared across instances via the cache', async () => {
  const m = mockRedis();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const url = `redis://127.0.0.1:${m.server.address().port}`;
  const cfg = { log: quiet(), INVITES: 'redis', REDIS_URL: url, INVITE_TTL_MS: 3600000, INVITE_REFRESH_MS: 30, SAVE_DIR: require('os').tmpdir() };
  const instA = createInvites(cfg);   // host's instance
  const instB = createInvites(cfg);   // recipient's instance
  try {
    // A creates an invite from 'host' to 'guest' for world ABC123
    const inv = instA.create('host', 'Host', 'guest', 'ABC123', 'Cool World');
    assert.ok(inv && inv.id);
    assert.strictEqual(instA.get(inv.id).code, 'ABC123', 'A sees its own invite immediately');

    // B (where the recipient is connected) sees it addressed to them after a refresh
    await instB.refresh();
    const forGuest = instB.listFor('guest');
    assert.strictEqual(forGuest.length, 1, 'the recipient sees the invite cluster-wide');
    assert.strictEqual(forGuest[0].code, 'ABC123');
    assert.strictEqual(forGuest[0].fromName, 'Host');
    assert.deepStrictEqual(instB.listFor('someone-else'), [], 'only the addressed recipient sees it');

    // accepting/declining removes it everywhere on the next refresh
    instB.remove(inv.id);
    await instA.refresh();
    assert.strictEqual(instA.get(inv.id), null, 'removal propagates across instances');

    assert.strictEqual(instA.mode, 'redis');
  } finally { instA.close(); instB.close(); await new Promise((r) => m.server.close(r)); }
});
