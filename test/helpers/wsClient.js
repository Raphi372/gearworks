'use strict';
/* ==========================================================================
   test/helpers/wsClient.js — a minimal, zero-dependency WebSocket client for
   the integration tests. It speaks the same RFC 6455 wire the server
   implements (server/network/websocket.js): performs the HTTP upgrade, sends
   MASKED text frames (clients must mask), parses server frames, and exchanges
   JSON application messages.

   Messages are delivered into a MAILBOX so a message that arrives before a
   matcher is awaited is not lost. `next(pred)` returns the first buffered or
   subsequently-arriving message matching a type string or predicate, with a
   timeout so a stuck test fails fast instead of hanging.
   ========================================================================== */
const net = require('net');
const crypto = require('crypto');

// client -> server frames MUST be masked (RFC 6455 §5.3)
function encode(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    let handshook = false;
    let closed = false;
    const mailbox = [];
    const waiters = [];          // { pred, resolve, timer }
    let onCloseCb = null;

    function deliver(msg) {
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          return w.resolve(msg);
        }
      }
      mailbox.push(msg);
    }

    function parseFrames() {
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.slice(off + maskLen, off + maskLen + len);
        if (masked) {
          const m = buf.slice(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
        }
        buf = buf.slice(off + maskLen + len);
        if (opcode === 0x8) { api.close(); return; }            // close
        if (opcode === 0x9) { try { sock.write(encode(payload, 0xA)); } catch (e) {} continue; } // ping -> pong
        if (opcode === 0xA) continue;                            // pong
        // text/binary/continuation — the server always sends single fin frames
        try { deliver(JSON.parse(payload.toString('utf8'))); } catch (e) { /* ignore non-JSON */ }
      }
    }

    const api = {
      send(obj) { if (!closed) { try { sock.write(encode(JSON.stringify(obj))); } catch (e) {} } return api; },

      // Await the first message matching `pred` (a 't' string or a function),
      // checking already-buffered messages first. Rejects after `timeout` ms.
      next(pred, timeout = 3000) {
        const p = typeof pred === 'function' ? pred : (m) => m.t === pred;
        for (let i = 0; i < mailbox.length; i++) {
          if (p(mailbox[i])) return Promise.resolve(mailbox.splice(i, 1)[0]);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.timer === timer);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error('timeout after ' + timeout + 'ms waiting for ' +
              (typeof pred === 'function' ? 'predicate' : "'" + pred + "'")));
          }, timeout);
          waiters.push({ pred: p, resolve: res, timer });
        });
      },

      // Assert that NO message matching `pred` arrives within `window` ms.
      expectNone(pred, window = 400) {
        const p = typeof pred === 'function' ? pred : (m) => m.t === pred;
        for (const m of mailbox) if (p(m)) return Promise.reject(new Error('unexpected buffered message'));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.timer === timer);
            if (idx >= 0) waiters.splice(idx, 1);
            res();
          }, window);
          waiters.push({ pred: p, resolve: () => { clearTimeout(timer); rej(new Error('received a message that should not have arrived')); }, timer });
        });
      },

      onClose(fn) { onCloseCb = fn; return api; },
      get closed() { return closed; },
      close() {
        if (closed) return;
        closed = true;
        try { sock.write(encode(Buffer.alloc(0), 0x8)); } catch (e) {}
        try { sock.destroy(); } catch (e) {}
        if (onCloseCb) onCloseCb();
      },
    };

    sock.on('data', (d) => {
      if (!handshook) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('utf8');
        if (!/ 101 /.test(head.split('\r\n')[0] + ' ')) {
          sock.destroy();
          return reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
        }
        handshook = true;
        buf = buf.slice(i + 4);
        resolve(api);
        parseFrames();
        return;
      }
      buf = Buffer.concat([buf, d]);
      parseFrames();
    });
    sock.on('error', (e) => { if (!handshook) reject(e); else api.close(); });
    sock.on('close', () => { if (!closed) { closed = true; if (onCloseCb) onCloseCb(); } });
    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\n' +
        'Host: ' + host + ':' + port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });
  });
}

module.exports = { connect };
