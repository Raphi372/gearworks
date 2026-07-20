#!/usr/bin/env node
/* ==========================================================================
   GEARWORKS DEDICATED SERVER — authoritative multiplayer host
   --------------------------------------------------------------------------
   Zero dependencies: plain Node (>=16). Serves the client files over HTTP
   and hosts game rooms over WebSocket (RFC 6455 implemented inline).

   Authority model (deterministic lockstep):
     • The server runs the shared simulation core (shared/core.js) for every
       room at a fixed 20 Hz, drift-corrected.
     • Clients submit COMMANDS, never state. Each command is validated
       against the SERVER's state (funds, tech gates, occupancy, terrain,
       role permissions, rate limits). Only accepted commands enter the
       ordered tick stream that is broadcast to all clients.
     • NPC company decisions are made HERE only (core.aiThink) and travel
       to clients as ordered 'ai' commands.
     • Clients report a state hash every 100 ticks; on mismatch the server
       force-resyncs them with an authoritative snapshot (gzip'd).
     • Saves are server-side: autosave + manual + rotating backups.

   Run:      node server/server.js [--port 8080] [--save-dir saves]
   Resume:   node server/server.js --load saves/<room>.json
   ========================================================================== */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Core = require('../shared/core.js');

/* ---------------------------- config ---------------------------------- */
const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const PORT = parseInt(argVal('--port', process.env.PORT || '8080'), 10);
const SAVE_DIR = path.resolve(__dirname, '..', argVal('--save-dir', 'saves'));
const LOAD_FILE = argVal('--load', null);
const ROOT = path.resolve(__dirname, '..');

const TICK_MS = 1000 / Core.Config.SIM_HZ;   // 50ms
const MAX_ROOMS = 32;
const MAX_MSG_BYTES = 512 * 1024;
const CMD_RATE_LIMIT = 100;                  // commands/sec/client
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;    // keep empty rooms 10 min (then save & close)
const HASH_INTERVAL = 100;                   // ticks between client hash audits

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

/* ====================================================================== */
/*  Minimal RFC 6455 WebSocket implementation                              */
/* ====================================================================== */
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
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.sock.write(wsFrame(Buffer.alloc(0), 0x8)); } catch (e) {}
    try { this.sock.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }
}

/* ====================================================================== */
/*  Rooms                                                                  */
/* ====================================================================== */
const rooms = new Map();      // code -> Room
const sessions = new Map();   // token -> {roomCode, player} for reconnect

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)]; } while (rooms.has(c));
  return c;
}

let nextPlayerId = 1;

class Room {
  constructor(opts) {
    this.code = opts.code || makeCode();
    this.name = String(opts.name || 'Gearworks World').slice(0, 40);
    this.public = !!opts.public;
    this.maxPlayers = Math.min(16, Math.max(2, opts.maxPlayers | 0 || 16));
    this.autosaveSec = Math.min(600, Math.max(15, opts.autosaveSec | 0 || 60));
    this.game = Core.createGame({ seed: opts.seed });
    if (opts.snapshot) this.game.Snapshot.restore(opts.snapshot);
    this.clients = new Map();     // playerId -> client record
    this.queue = [];              // commands awaiting the next tick
    this.created = Date.now();
    this.lastActive = Date.now();
    this.lastSave = Date.now();
    this.saveSeq = 0;
    // drift-corrected fixed-rate loop
    this.simStart = Date.now();
    this.simTicks = 0;
    this.timer = setInterval(() => this.pump(), TICK_MS / 2);
    this.cursorTimer = setInterval(() => this.broadcastCursors(), 100);
    log(`room ${this.code} "${this.name}" created (seed ${this.game.seed})`);
  }

  /* ------- fixed timestep with catch-up (server is the metronome) ----- */
  pump() {
    const due = Math.floor((Date.now() - this.simStart) / TICK_MS);
    let n = 0;
    while (this.simTicks < due && n < 10) { this.tickOnce(); this.simTicks++; n++; }
    if (due - this.simTicks > 40) {           // fell far behind (host lag)
      this.simStart = Date.now() - this.simTicks * TICK_MS;
    }
  }

  tickOnce() {
    const g = this.game;
    // 1. NPC decisions — server only, once per sim second
    if (g.S.tick % Core.Config.SIM_HZ === 0) {
      const ops = g.aiThink();
      if (ops.length) this.queue.push({ t: 'ai', ops });
    }
    // 2. validate queued commands against CURRENT server state, in order
    const accepted = [];
    for (const q of this.queue) {
      const err = g.Commands.validate(q);
      if (err) {
        if (q._c) q._c.conn.send({ t: 'rej', q: q._q, reason: err });
        continue;
      }
      const wire = Object.assign({}, q);
      delete wire._c;
      accepted.push(wire);
      // apply immediately so later commands this tick validate against
      // the updated state (two builds on one tile -> second rejected)
      g.Commands.apply(wire);
    }
    this.queue.length = 0;
    // 3. advance simulation
    g.Sim.tick();
    // 4. broadcast the tick. Empty ticks are batched via heartbeats every
    //    5 ticks — the dominant bandwidth optimization (nothing happening
    //    costs ~4 msgs/sec regardless of factory size).
    if (accepted.length) this.broadcast({ t: 'tk', n: g.S.tick, c: accepted });
    else if (g.S.tick % 5 === 0) this.broadcast({ t: 'tks', n: g.S.tick });
    // 5. periodic authoritative hash so clients can self-audit
    if (g.S.tick % HASH_INTERVAL === 0) {
      this.serverHash = { tick: g.S.tick, hash: g.stateHash() };
      this.broadcast({ t: 'hash', n: g.S.tick, h: this.serverHash.hash });
    }
    // 6. autosave
    if (Date.now() - this.lastSave > this.autosaveSec * 1000) this.save('auto');
    // 7. empty-room lifecycle
    if (this.clients.size === 0 && Date.now() - this.lastActive > EMPTY_ROOM_TTL_MS) this.destroy('idle');
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const c of this.clients.values()) {
      if (c === except) continue;
      try { c.conn.sock.write(wsFrame(s)); } catch (e) {}
    }
  }

  /* --------------------------- players -------------------------------- */
  addPlayer(conn, info, role, token) {
    const id = nextPlayerId++;
    const c = {
      id, conn,
      name: String(info.name || 'Engineer').slice(0, 20) || 'Engineer',
      color: /^#[0-9a-fA-F]{6}$/.test(info.color || '') ? info.color : '#4aa3ff',
      role,                       // host | admin | player | spectator
      gzOK: info.gz !== false,
      token: token || crypto.randomBytes(12).toString('hex'),
      cursor: null, view: null,   // interest management inputs
      cmdWindow: [],              // rate limiting
      lastHash: null,
    };
    this.clients.set(id, c);
    sessions.set(c.token, { roomCode: this.code, playerId: id, name: c.name, color: c.color, role });
    this.lastActive = Date.now();
    // full authoritative snapshot -> the joining client
    this.sendSnapshot(c, 'join');
    conn.send({ t: 'welcome', id, token: c.token, code: this.code, name: this.name,
      role, tick: this.game.S.tick, autosaveSec: this.autosaveSec,
      players: this.playerList() });
    this.broadcast({ t: 'pjoin', p: this.publicInfo(c) }, c);
    log(`room ${this.code}: ${c.name} joined as ${role} (${this.clients.size} online)`);
    return c;
  }

  sendSnapshot(c, why) {
    const snap = this.game.Snapshot.capture();
    // gzip + base64: snapshots are the only large payloads in the protocol.
    // Clients without DecompressionStream negotiate raw JSON via hello.gz.
    if (c.gzOK) {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snap), 'utf8')).toString('base64');
      c.conn.send({ t: 'snap', why, tick: snap.tick, gz });
    } else {
      c.conn.send({ t: 'snap', why, tick: snap.tick, raw: snap });
    }
  }

  publicInfo(c) { return { id: c.id, name: c.name, color: c.color, role: c.role }; }
  playerList() { return Array.from(this.clients.values()).map((c) => this.publicInfo(c)); }

  removePlayer(c, why) {
    if (!this.clients.has(c.id)) return;
    this.clients.delete(c.id);
    this.lastActive = Date.now();
    this.broadcast({ t: 'pleave', id: c.id, why });
    log(`room ${this.code}: ${c.name} left (${why})`);
    // host migration: promote the longest-connected remaining player
    if (c.role === 'host' && this.clients.size) {
      const heir = this.clients.values().next().value;
      heir.role = 'host';
      const sess = sessions.get(heir.token); if (sess) sess.role = 'host';
      this.broadcast({ t: 'prole', id: heir.id, role: 'host' });
      log(`room ${this.code}: host migrated to ${heir.name}`);
    }
  }

  /* --------------------------- messages ------------------------------- */
  onMessage(c, m) {
    switch (m.t) {
      case 'cmd': {
        if (typeof m.cmd !== 'object' || !m.cmd) return;
        // permission gate
        const need = this.game.Commands.PERMS[m.cmd.t];
        if (need === 'server') return c.conn.send({ t: 'rej', q: m.q, reason: 'server-only' });
        if (c.role === 'spectator') return c.conn.send({ t: 'rej', q: m.q, reason: 'spectators cannot act' });
        if (need === 'admin' && c.role !== 'admin' && c.role !== 'host')
          return c.conn.send({ t: 'rej', q: m.q, reason: 'admin only' });
        // rate limit
        const now = Date.now();
        c.cmdWindow = c.cmdWindow.filter((t) => now - t < 1000);
        if (c.cmdWindow.length >= CMD_RATE_LIMIT) return c.conn.send({ t: 'rej', q: m.q, reason: 'rate limited' });
        c.cmdWindow.push(now);
        // stamp identity server-side (clients cannot spoof issuer)
        const cmd = Object.assign({}, m.cmd, { _p: c.id, _q: m.q, _c: c });
        this.queue.push(cmd);
        this.lastActive = now;
        break;
      }
      case 'cur': {   // lossy cursor channel
        if (isFinite(m.x) && isFinite(m.y)) c.cursor = { x: +m.x, y: +m.y, t: Date.now() };
        break;
      }
      case 'view': {  // camera rect for interest management
        if (Array.isArray(m.r) && m.r.length === 4 && m.r.every(isFinite)) c.view = m.r.map(Number);
        break;
      }
      case 'ping': c.conn.sendLossy({ t: 'pong', ts: m.ts, tick: this.game.S.tick }); break;
      case 'hashReport': {
        // divergence audit: compare with the server hash for that tick
        if (this.serverHash && m.n === this.serverHash.tick && m.h !== this.serverHash.hash) {
          log(`room ${this.code}: DIVERGENCE from ${c.name} @tick ${m.n} — resyncing`);
          this.sendSnapshot(c, 'desync');
        }
        break;
      }
      case 'resync': this.sendSnapshot(c, 'requested'); break;
      case 'save': {
        if (c.role !== 'host' && c.role !== 'admin') return;
        this.save('manual');
        this.broadcast({ t: 'saved', by: c.name });
        break;
      }
      case 'adm': {
        if (c.role !== 'host' && !(c.role === 'admin' && m.op !== 'role')) {
          if (c.role !== 'admin') return; // players can't administrate
        }
        const target = this.clients.get(m.id | 0);
        if (!target || target.role === 'host') return;
        if (m.op === 'kick') { target.conn.send({ t: 'kicked' }); target.conn.close(); }
        else if (m.op === 'role' && c.role === 'host' &&
                 ['admin', 'player', 'spectator'].includes(m.role)) {
          target.role = m.role;
          const sess = sessions.get(target.token); if (sess) sess.role = m.role;
          this.broadcast({ t: 'prole', id: target.id, role: m.role });
        }
        break;
      }
      case 'setAutosave': {
        if (c.role !== 'host' && c.role !== 'admin') return;
        this.autosaveSec = Math.min(600, Math.max(15, m.v | 0));
        this.broadcast({ t: 'roomcfg', autosaveSec: this.autosaveSec });
        break;
      }
    }
  }

  /* ---------------- cursor relay with interest management -------------- */
  broadcastCursors() {
    if (!this.clients.size) return;
    const now = Date.now();
    for (const viewer of this.clients.values()) {
      const list = [];
      for (const other of this.clients.values()) {
        if (other === viewer || !other.cursor || now - other.cursor.t > 4000) continue;
        // only relay cursors inside (a margin around) the viewer's camera
        if (viewer.view) {
          const [x0, y0, x1, y1] = viewer.view;
          const mx = (x1 - x0), my = (y1 - y0);
          if (other.cursor.x < x0 - mx || other.cursor.x > x1 + mx ||
              other.cursor.y < y0 - my || other.cursor.y > y1 + my) continue;
        }
        list.push([other.id, Math.round(other.cursor.x), Math.round(other.cursor.y)]);
      }
      if (list.length) viewer.conn.sendLossy({ t: 'cur', p: list });
    }
  }

  /* --------------------------- persistence ----------------------------- */
  savePath() { return path.join(SAVE_DIR, `${this.code}.json`); }
  save(kind) {
    try {
      const file = this.savePath();
      // rotate backups: .json -> .bak1 -> .bak2 ... (5 kept)
      for (let i = 4; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.bak${i - 1}`;
        const to = `${file}.bak${i}`;
        if (fs.existsSync(from) && i > 1) fs.renameSync(from, to);
        else if (i === 1 && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak1`);
      }
      const data = {
        meta: { name: this.name, code: this.code, saved: Date.now(), kind, seq: ++this.saveSeq },
        snapshot: this.game.Snapshot.capture(),
      };
      fs.writeFileSync(file, JSON.stringify(data));
      this.lastSave = Date.now();
      if (kind !== 'auto') log(`room ${this.code}: ${kind} save -> ${file}`);
    } catch (e) { log(`room ${this.code}: SAVE FAILED: ${e.message}`); }
  }

  destroy(why) {
    this.save('final');
    clearInterval(this.timer);
    clearInterval(this.cursorTimer);
    for (const c of this.clients.values()) c.conn.close();
    rooms.delete(this.code);
    log(`room ${this.code} closed (${why})`);
  }
}

/* ====================================================================== */
/*  Connection state machine (lobby -> room)                               */
/* ====================================================================== */
function handleConn(conn) {
  let client = null;   // set once inside a room
  let room = null;
  let hello = null;

  conn.onmessage = (m) => {
    if (!m || typeof m.t !== 'string') return;
    // lobby-scope messages
    switch (m.t) {
      case 'hello':
        hello = { name: m.name, color: m.color, gz: m.gz };
        if (m.proto !== Core.PROTO) conn.send({ t: 'err', reason: 'protocol version mismatch — refresh the page' });
        else conn.send({ t: 'lobby', proto: Core.PROTO, rooms: publicRooms() });
        return;
      case 'listRooms':
        conn.send({ t: 'lobby', proto: Core.PROTO, rooms: publicRooms() });
        return;
      case 'create': {
        if (room) return;
        if (rooms.size >= MAX_ROOMS) return conn.send({ t: 'err', reason: 'server full (rooms)' });
        const r = new Room({ name: m.roomName, public: m.public, maxPlayers: m.maxPlayers,
          seed: (m.seed !== undefined && isFinite(m.seed)) ? m.seed : undefined });
        rooms.set(r.code, r);
        room = r;
        client = r.addPlayer(conn, hello || m, m.spectate ? 'spectator' : 'host');
        wire();
        return;
      }
      case 'join': {
        if (room) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return conn.send({ t: 'err', reason: 'room not found' });
        const nonSpec = Array.from(r.clients.values()).filter((c) => c.role !== 'spectator').length;
        const asSpec = !!m.spectate;
        if (!asSpec && nonSpec >= r.maxPlayers) return conn.send({ t: 'err', reason: 'room full' });
        room = r;
        client = r.addPlayer(conn, hello || m, asSpec ? 'spectator' : 'player');
        wire();
        return;
      }
      case 'rejoin': {   // reconnect with session token
        if (room) return;
        const sess = sessions.get(String(m.token || ''));
        if (!sess || !rooms.has(sess.roomCode)) return conn.send({ t: 'err', reason: 'session expired' });
        const r = rooms.get(sess.roomCode);
        room = r;
        client = r.addPlayer(conn, { name: sess.name, color: sess.color }, sess.role, m.token);
        wire();
        return;
      }
    }
    // room-scope messages
    if (room && client) room.onMessage(client, m);
  };

  function wire() {
    conn.onclose = () => { if (room && client) room.removePlayer(client, 'disconnected'); };
  }
  conn.onclose = () => {};
}

function publicRooms() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.public) continue;
    list.push({ code: r.code, name: r.name,
      players: Array.from(r.clients.values()).filter((c) => c.role !== 'spectator').length,
      spectators: Array.from(r.clients.values()).filter((c) => c.role === 'spectator').length,
      maxPlayers: r.maxPlayers, tick: r.game.S.tick });
  }
  return list;
}

/* ====================================================================== */
/*  HTTP static file server + WS upgrade                                   */
/* ====================================================================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.md': 'text/markdown' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }   // path traversal guard
  // only serve the game's own files
  const rel = path.relative(ROOT, file);
  if (!/^(index\.html|shared[\/\\]|client[\/\\]|docs[\/\\])/.test(rel)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
  socket.setNoDelay(true);
  handleConn(new WSConn(socket));
});

/* ---------------------------- boot ------------------------------------ */
function log(s) { console.log(`[${new Date().toISOString()}] ${s}`); }

if (LOAD_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(LOAD_FILE, 'utf8'));
    const r = new Room({ name: data.meta.name, public: true, snapshot: data.snapshot,
      code: data.meta.code && !rooms.has(data.meta.code) ? data.meta.code : undefined });
    rooms.set(r.code, r);
    log(`resumed save into room ${r.code} ("${r.name}") @tick ${r.game.S.tick}`);
  } catch (e) { log(`failed to load ${LOAD_FILE}: ${e.message}`); process.exit(1); }
}

process.on('SIGINT', () => {
  log('shutting down — saving all rooms');
  for (const r of rooms.values()) r.destroy('shutdown');
  process.exit(0);
});

server.listen(PORT, () => {
  log(`Gearworks server on http://localhost:${PORT} (protocol v${Core.PROTO})`);
  log(`saves -> ${SAVE_DIR}`);
});
