'use strict';
/* ==========================================================================
   network/websocket.js — minimal RFC 6455 WebSocket transport.

   Extracted verbatim from the original server. Zero dependencies: we speak
   the WebSocket wire protocol directly over the raw TCP socket, so the server
   installs no npm packages for its hot path. Behaviour is transport-only —
   it knows nothing about game logic, rooms, or players.
   ========================================================================== */
const crypto = require('crypto');
const { MAX_MSG_BYTES } = require('../config');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// frame builder (server->client frames are unmasked)
function wsFrame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | (opcode === undefined ? 0x1 : opcode);
  return Buffer.concat([header, payload]);
}

class WSConn {
  constructor(socket) {
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;          // continuation buffer
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    // heartbeat: ping every 30s; if the previous ping went unanswered, drop
    this.pingTimer = setInterval(() => {
      if (!this.alive) return this.close();
      this.alive = false;
      try { this.sock.write(wsFrame(Buffer.alloc(0), 0x9)); } catch (e) { this.close(); }
    }, 30000);
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_MSG_BYTES * 2) return this.close(); // flood guard
    for (;;) {
      const f = this._parseFrame();
      if (!f) break;
      if (f.opcode === 0x8) { this.close(); return; }
      if (f.opcode === 0x9) { try { this.sock.write(wsFrame(f.payload, 0xA)); } catch (e) {} continue; }
      if (f.opcode === 0xA) { this.alive = true; continue; }
      if (f.opcode === 0x0) { // continuation
        if (this.frag) { this.frag.chunks.push(f.payload); if (f.fin) { this._deliver(Buffer.concat(this.frag.chunks)); this.frag = null; } }
        continue;
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        this.alive = true;
        if (f.fin) this._deliver(f.payload);
        else this.frag = { chunks: [f.payload] };
      }
    }
  }
  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80);
    const opcode = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MSG_BYTES) { this.close(); return null; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    let payload = b.slice(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = b.slice(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.slice(off + maskLen + len);
    return { fin, opcode, payload };
  }
  _deliver(payload) {
    if (this.onmessage) {
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); }
      catch (e) { return this.close(); }   // malformed JSON: drop the client
      this.onmessage(msg);
    }
  }
  send(obj) {
    if (this.sock.destroyed) return false;
    try { return this.sock.write(wsFrame(JSON.stringify(obj))); } catch (e) { this.close(); return false; }
  }
  // lossy channel: skip if the socket is backed up (stale data is useless)
  sendLossy(obj) {
    if (this.sock.destroyed || this.sock.writableLength > 64 * 1024) return false;
    return this.send(obj);
  }
  // write a pre-serialized frame buffer (used by Room.broadcast for fan-out)
  writeRaw(frameBuffer) {
    if (this.sock.destroyed) return false;
    try { return this.sock.write(frameBuffer); } catch (e) { this.close(); return false; }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.sock.write(wsFrame(Buffer.alloc(0), 0x8)); } catch (e) {}
    try { this.sock.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }
}

module.exports = { wsAccept, wsFrame, WSConn };
