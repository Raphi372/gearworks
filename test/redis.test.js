'use strict';
/* Zero-dependency Redis (RESP) client + the redis presence backend (Phase 3),
   exercised against a tiny in-process mock RESP server. Proves the wire protocol
   round-trips and that presence written on one instance becomes visible on
   another via the shared cache. */
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createRedis } = require('../server/redis');
const { createPresence } = require('../server/presence');

const quiet = () => { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a minimal RESP server supporting PING/AUTH/SET(+PX)/GET/DEL/KEYS/MGET.
function mockRedis() {
  const store = new Map();   // key -> { val, exp }
  const alive = (e) => !e || e.exp === 0 || e.exp > Date.now();
  function reply(v) {
    if (v === null) return '$-1\r\n';
    if (typeof v === 'number') return `:${v}\r\n`;
    if (Array.isArray(v)) return `*${v.length}\r\n` + v.map(reply).join('');
    if (v && v.simple) return `+${v.simple}\r\n`;
    return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
  }
  function handle(args) {
    const cmd = String(args[0]).toUpperCase();
    if (cmd === 'PING') return { simple: 'PONG' };
    if (cmd === 'AUTH') return { simple: 'OK' };
    if (cmd === 'SET') {
      let exp = 0;
      const px = args.indexOf('PX');
      if (px > 0) exp = Date.now() + Number(args[px + 1]);
      store.set(args[1], { val: args[2], exp });
      return { simple: 'OK' };
    }
    if (cmd === 'GET') { const e = store.get(args[1]); return e && alive(e) ? e.val : null; }
    if (cmd === 'DEL') { let n = 0; for (let i = 1; i < args.length; i++) if (store.delete(args[i])) n++; return n; }
    if (cmd === 'KEYS') {
      const pre = String(args[1]).replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(pre) && alive(store.get(k)));
    }
    if (cmd === 'MGET') return args.slice(1).map((k) => { const e = store.get(k); return e && alive(e) ? e.val : null; });
    return { simple: 'OK' };
  }
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // parse complete `*n $len arg...` command frames
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

test('the RESP client round-trips SET/GET/DEL/KEYS/MGET/PING', async () => {
  const m = mockRedis();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const redis = createRedis(`redis://127.0.0.1:${m.server.address().port}`, quiet());
  try {
    assert.strictEqual(await redis.ping(), 'PONG');
    assert.strictEqual(await redis.set('gw:a', 'one'), 'OK');
    await redis.set('gw:b', 'two');
    assert.strictEqual(await redis.get('gw:a'), 'one');
    assert.strictEqual(await redis.get('gw:missing'), null);
    assert.deepStrictEqual((await redis.keys('gw:*')).sort(), ['gw:a', 'gw:b']);
    assert.deepStrictEqual(await redis.mget(['gw:a', 'gw:b', 'gw:missing']), ['one', 'two', null]);
    assert.strictEqual(await redis.del('gw:a'), 1);
    assert.strictEqual(await redis.get('gw:a'), null);
  } finally { redis.close(); await new Promise((r) => m.server.close(r)); }
});

test('redis presence is shared across instances via the cache', async () => {
  const m = mockRedis();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const url = `redis://127.0.0.1:${m.server.address().port}`;
  const cfg = { log: quiet(), PRESENCE: 'redis', REDIS_URL: url, REGION: 'eu', PRESENCE_TTL_MS: 60000, PRESENCE_REFRESH_MS: 30 };
  const instA = createPresence(cfg);
  const instB = createPresence(cfg);
  try {
    // instance A marks a player in-game; its own read is immediately fresh
    instA.set('acc1', { status: 'ingame', roomCode: 'ABC123' });
    const a = instA.get('acc1');
    assert.strictEqual(a.online, true);
    assert.strictEqual(a.status, 'ingame');
    assert.strictEqual(a.roomCode, 'ABC123');

    // instance B doesn't have it locally yet, but sees it after a cache refresh
    await instB.refresh();
    const b = instB.get('acc1');
    assert.strictEqual(b.online, true, 'B sees A\'s player after refreshing from redis');
    assert.strictEqual(b.status, 'ingame');
    assert.strictEqual(b.region, 'eu');

    // clearing on A propagates to B on the next refresh
    instA.clear('acc1');
    await instB.refresh();
    assert.strictEqual(instB.get('acc1').online, false, 'cleared presence goes offline cluster-wide');
  } finally { instA.close(); instB.close(); await new Promise((r) => m.server.close(r)); }
});
