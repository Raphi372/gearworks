'use strict';
/* ==========================================================================
   server/redis.js — a tiny, zero-dependency Redis (RESP) client.

   Only what the ephemeral stores need (SET/GET/DEL/KEYS/MGET/PING), spoken over
   a raw TCP socket with the RESP protocol — no `redis`/`ioredis` npm dependency,
   in keeping with the vanilla-Node ethos ([A-7]). Commands are pipelined: each
   send queues a resolver and replies come back in order. A dropped connection
   fails in-flight commands soft (→ null) and reconnects with backoff, so a Redis
   blip degrades the optional cache rather than taking the instance down.
   ========================================================================== */
const net = require('net');

function createRedis(url, log) {
  const u = new URL(url);
  const host = u.hostname;
  const port = +u.port || 6379;
  const password = u.password || (u.username === 'default' ? '' : u.username) || '';
  let sock = null, connected = false, closing = false, backoff = 100;
  const pending = [];        // resolvers awaiting replies, in order
  const outbox = [];         // commands issued before the socket is ready
  let buf = Buffer.alloc(0);

  function fail(err) {
    while (pending.length) pending.shift().reject(err || new Error('redis disconnected'));
  }
  function flush() {
    while (connected && outbox.length) {
      const { args, resolve, reject } = outbox.shift();
      pending.push({ resolve, reject });
      try { sock.write(encode(args)); } catch (e) { pending.pop(); reject(e); }
    }
  }
  function connect() {
    if (closing) return;
    sock = net.connect({ host, port }, () => {
      connected = true; backoff = 100;
      if (password) { pending.push({ resolve() {}, reject() {} }); sock.write(encode(['AUTH', password])); }
      flush();
    });
    sock.on('data', onData);
    sock.on('error', () => {});
    sock.on('close', () => {
      connected = false; fail(new Error('redis connection closed'));
      if (!closing) setTimeout(connect, (backoff = Math.min(backoff * 2, 5000)));
    });
    sock.unref();   // never keep the process alive on Redis alone
  }

  // incremental RESP parser: parse one reply from `buf` at `off`, or null if
  // more bytes are needed. Returns { val, next }.
  function parse(b, off) {
    if (off >= b.length) return null;
    const type = b[off];
    const eol = b.indexOf('\r\n', off);
    if (eol < 0) return null;
    const line = b.toString('utf8', off + 1, eol);
    if (type === 0x2b) return { val: line, next: eol + 2 };                 // +simple
    if (type === 0x2d) return { val: new Error(line), next: eol + 2 };      // -error
    if (type === 0x3a) return { val: Number(line), next: eol + 2 };         // :integer
    if (type === 0x24) {                                                    // $bulk
      const len = Number(line);
      if (len < 0) return { val: null, next: eol + 2 };
      const start = eol + 2, end = start + len;
      if (b.length < end + 2) return null;
      return { val: b.toString('utf8', start, end), next: end + 2 };
    }
    if (type === 0x2a) {                                                    // *array
      const n = Number(line);
      if (n < 0) return { val: null, next: eol + 2 };
      let next = eol + 2; const arr = [];
      for (let i = 0; i < n; i++) {
        const r = parse(b, next);
        if (!r) return null;
        arr.push(r.val); next = r.next;
      }
      return { val: arr, next };
    }
    return { val: null, next: eol + 2 };
  }

  function onData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      const r = parse(buf, off);
      if (!r) break;
      off = r.next;
      const p = pending.shift();
      if (p) { if (r.val instanceof Error) p.reject(r.val); else p.resolve(r.val); }
    }
    buf = off ? buf.slice(off) : buf;
  }

  function encode(args) {
    let out = `*${args.length}\r\n`;
    for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
    return out;
  }
  function send(args) {
    return new Promise((resolve, reject) => {
      if (!connected || !sock) { outbox.push({ args, resolve, reject }); return; }   // buffer until connected
      pending.push({ resolve, reject });
      sock.write(encode(args));
    });
  }

  connect();
  return {
    get connected() { return connected; },
    ping() { return send(['PING']); },
    set(key, val, pxMs) { return pxMs ? send(['SET', key, val, 'PX', String(pxMs)]) : send(['SET', key, val]); },
    get(key) { return send(['GET', key]); },
    del(key) { return send(['DEL', key]); },
    keys(pattern) { return send(['KEYS', pattern]); },
    mget(keys) { return keys.length ? send(['MGET'].concat(keys)) : Promise.resolve([]); },
    cmd(...args) { return send(args); },
    close() {
      closing = true;
      while (outbox.length) outbox.shift().reject(new Error('redis closed'));
      try { if (sock) sock.destroy(); } catch (e) { /* ignore */ }
    },
  };
}

module.exports = { createRedis };
