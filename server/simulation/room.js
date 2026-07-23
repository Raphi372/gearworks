'use strict';
/* ==========================================================================
   simulation/room.js — one authoritative game instance.

   THE server-authority boundary. Each room owns a deterministic simulation
   (shared/core.js) advanced on a drift-corrected fixed 20 Hz clock. Clients
   submit COMMANDS; the room validates each against its own state (funds, tech
   gates, occupancy, terrain, role, rate limits) before admitting it to the
   ordered tick stream broadcast to every client. NPC decisions are made here
   only. Clients self-audit against periodic state hashes and are snapshot-
   resynced on divergence. Nothing a client sends is trusted as state.

   Dependencies (store, sessions, id allocation, close callback) are injected
   so this module has no cycle with the room registry.
   ========================================================================== */
const crypto = require('crypto');
const zlib = require('zlib');
const Core = require('../../shared/core.js');
const { wsFrame } = require('../network/websocket');

class Room {
  constructor(opts, deps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.tokens = deps.tokens;           // shared HMAC signer for reconnect tokens
    this.newPlayerId = deps.newPlayerId;
    this.onClose = deps.onClose;         // (code) => void, removes us from the registry
    this.metrics = deps.metrics || null; // observability recorder (optional)
    this.presence = deps.presence || null;   // ephemeral online/in-game status (optional)

    this.code = opts.code;
    this.name = String(opts.name || 'Gearworks World').slice(0, 40);
    this.public = !!opts.public;
    this.ownerId = opts.ownerId || null;      // account that owns this saved world
    // persistent membership (accountId -> {role,name}); carried forward from a
    // saved world so a resume/restart never drops previously-recorded members.
    this.members = new Map((opts.members || []).map((mm) => [mm.aid, { role: mm.role, name: mm.name }]));
    this.maxPlayers = Math.min(this.cfg.MAX_PLAYERS_PER_ROOM, Math.max(2, opts.maxPlayers | 0 || this.cfg.MAX_PLAYERS_PER_ROOM));
    this.autosaveSec = Math.min(600, Math.max(15, opts.autosaveSec | 0 || 60));
    this.game = Core.createGame({ seed: opts.seed });
    if (opts.snapshot) this.game.Snapshot.restore(opts.snapshot);
    this.clients = new Map();     // playerId -> client record
    this.queue = [];              // commands awaiting the next tick
    this.chatHistory = [];        // recent chat, replayed to joiners (ephemeral)
    this.created = Date.now();
    this.lastActive = Date.now();
    this.lastSave = Date.now();
    this.saveSeq = 0;
    // drift-corrected fixed-rate loop
    this.simStart = Date.now();
    this.simTicks = 0;
    this.timer = setInterval(() => this.pump(), this.cfg.TICK_MS / 2);
    this.cursorTimer = setInterval(() => this.broadcastCursors(), 100);
    this.cfg.log(`room ${this.code} "${this.name}" created`, { seed: this.game.seed });
  }

  /* ------- fixed timestep with catch-up (server is the metronome) ----- */
  pump() {
    const TICK_MS = this.cfg.TICK_MS;
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
    if (this.metrics) { this.metrics.recordTick(); if (accepted.length) this.metrics.recordCommands(accepted.length); }
    // 3. advance simulation
    g.Sim.tick();
    // 4. broadcast the tick. Empty ticks are batched via heartbeats every
    //    5 ticks — the dominant bandwidth optimization (nothing happening
    //    costs ~4 msgs/sec regardless of factory size).
    if (accepted.length) this.broadcast({ t: 'tk', n: g.S.tick, c: accepted });
    else if (g.S.tick % 5 === 0) this.broadcast({ t: 'tks', n: g.S.tick });
    // 5. periodic authoritative hash so clients can self-audit
    if (g.S.tick % this.cfg.HASH_INTERVAL === 0) {
      this.serverHash = { tick: g.S.tick, hash: g.stateHash() };
      this.broadcast({ t: 'hash', n: g.S.tick, h: this.serverHash.hash });
    }
    // 6. autosave
    if (Date.now() - this.lastSave > this.autosaveSec * 1000) this.save('auto');
    // 7. empty-room lifecycle
    if (this.clients.size === 0 && Date.now() - this.lastActive > this.cfg.EMPTY_ROOM_TTL_MS) this.destroy('idle');
  }

  broadcast(obj, except) {
    const frame = wsFrame(JSON.stringify(obj));   // build once, fan out
    for (const c of this.clients.values()) {
      if (c === except) continue;
      c.conn.writeRaw(frame);
    }
  }

  /* --------------------------- players -------------------------------- */
  addPlayer(conn, info, role, sessionId) {
    const id = this.newPlayerId();
    const c = {
      id,
      sid: sessionId || crypto.randomUUID(),   // stable seat identity across reconnects
      conn,
      name: String(info.name || 'Engineer').slice(0, 20) || 'Engineer',
      color: /^#[0-9a-fA-F]{6}$/.test(info.color || '') ? info.color : '#4aa3ff',
      role,                       // host | admin | player | spectator
      aid: info.aid || null,      // account id (authenticated players) -> membership
      gzOK: info.gz !== false,
      cursor: null, view: null,   // interest management inputs
      cmdWindow: [],              // rate limiting
      chatWindow: [],
    };
    this.clients.set(id, c);
    // record persistent membership for authenticated players (spectators too:
    // they've "been here"); role updates on promotion (see setRole)
    if (c.aid) this.members.set(c.aid, { role, name: c.name });
    if (this.presence && c.aid) this.presence.set(c.aid, { status: 'ingame', roomCode: this.code });
    this.lastActive = Date.now();
    // full authoritative snapshot -> the joining client
    this.sendSnapshot(c, 'join');
    conn.send({ t: 'welcome', id, token: this.reconnectToken(c), code: this.code, name: this.name,
      role, tick: this.game.S.tick, autosaveSec: this.autosaveSec,
      players: this.playerList(), chat: this.chatHistory });
    this.broadcast({ t: 'pjoin', p: this.publicInfo(c) }, c);
    this.cfg.log(`room ${this.code}: ${c.name} joined as ${role} (${this.clients.size} online)`);
    return c;
  }

  // Stateless, signed reconnect token: lets this seat rejoin the (possibly
  // restarted/restored) room with no server-side session storage.
  reconnectToken(c) {
    return this.tokens.sign('reconnect',
      { room: this.code, sid: c.sid, name: c.name, color: c.color, role: c.role },
      this.cfg.RECONNECT_TTL_MS);
  }

  hasHost() { for (const c of this.clients.values()) if (c.role === 'host') return true; return false; }
  // an account's persisted role in this world (carried forward across sessions), or null
  memberRole(aid) { const m = aid && this.members.get(aid); return m ? m.role : null; }

  // Change a seat's role, hand it a fresh reconnect token (so the token's
  // embedded role stays accurate), then announce the change.
  setRole(c, role) {
    c.role = role;
    if (c.aid && this.members.has(c.aid)) this.members.get(c.aid).role = role;   // persist the promotion
    c.conn.send({ t: 'token', token: this.reconnectToken(c) });
    this.broadcast({ t: 'prole', id: c.id, role });
  }

  sendSnapshot(c, why) {
    if (this.metrics && (why === 'desync' || why === 'requested')) this.metrics.recordResync();
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
  nonSpectators() { return Array.from(this.clients.values()).filter((c) => c.role !== 'spectator').length; }

  removePlayer(c, why) {
    if (!this.clients.has(c.id)) return;
    this.clients.delete(c.id);
    this.lastActive = Date.now();
    if (this.presence && c.aid) this.presence.clear(c.aid);   // left the game (TTL also covers crashes)
    this.broadcast({ t: 'pleave', id: c.id, why });
    this.cfg.log(`room ${this.code}: ${c.name} left (${why})`);
    // host migration: promote the longest-connected remaining player
    if (c.role === 'host' && this.clients.size) {
      const heir = this.clients.values().next().value;
      this.setRole(heir, 'host');
      this.cfg.log(`room ${this.code}: host migrated to ${heir.name}`);
    }
  }

  /* --------------------------- messages ------------------------------- */
  onMessage(c, m) {
    if (this.metrics) this.metrics.recordMessage();
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
        if (c.cmdWindow.length >= this.cfg.CMD_RATE_LIMIT) return c.conn.send({ t: 'rej', q: m.q, reason: 'rate limited' });
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
      case 'chat': {   // reliable text chat — not part of the deterministic sim
        if (typeof m.text !== 'string') return;
        // sanitize: strip control chars, trim, cap length (client escapes on render)
        const text = m.text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
        if (!text) return;
        const now = Date.now();
        c.chatWindow = (c.chatWindow || []).filter((t) => now - t < 5000);
        if (c.chatWindow.length >= this.cfg.CHAT_RATE_LIMIT) return;   // anti-spam: drop over-rate
        c.chatWindow.push(now);
        const msg = { t: 'chat', id: c.id, name: c.name, color: c.color, text };
        this.chatHistory.push({ id: c.id, name: c.name, color: c.color, text });
        if (this.chatHistory.length > 40) this.chatHistory.shift();
        this.lastActive = now;
        this.broadcast(msg);
        break;
      }
      case 'ping':
        if (this.metrics && m.rtt != null) this.metrics.recordRtt(m.rtt);   // client-measured round trip
        if (this.presence && c.aid) this.presence.set(c.aid, { status: 'ingame', roomCode: this.code });   // heartbeat in-game presence
        c.conn.sendLossy({ t: 'pong', ts: m.ts, tick: this.game.S.tick });
        break;
      case 'hashReport': {
        // divergence audit: compare with the server hash for that tick
        if (this.serverHash && m.n === this.serverHash.tick && m.h !== this.serverHash.hash) {
          this.cfg.log.warn(`room ${this.code}: DIVERGENCE from ${c.name} @tick ${m.n} — resyncing`);
          if (this.metrics) this.metrics.recordDivergence();
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
          this.setRole(target, m.role);
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
  // A cheap, DERIVED projection of the authoritative game for leaderboards and
  // stats — so those queries never deserialize snapshots. World.snapshot stays
  // the single source of truth (guidelines DB-6).
  projection() {
    const g = this.game;
    return {
      entities: g.Grid.entities.size,
      money: Math.max(0, Math.round(g.S.money)),
      tech: g.Research.done.size,
      techIds: Array.from(g.Research.done),   // for the cross-world progression union
      tick: g.S.tick,
    };
  }

  save(kind) {
    const data = {
      meta: { name: this.name, code: this.code, ownerId: this.ownerId, public: this.public,
        projection: this.projection(),
        members: Array.from(this.members, ([aid, v]) => ({ aid, role: v.role, name: v.name })),
        saved: Date.now(), kind, seq: ++this.saveSeq },
      snapshot: this.game.Snapshot.capture(),
    };
    const ok = this.store.saveRoom(this.code, data);
    this.lastSave = Date.now();
    if (ok && kind !== 'auto') this.cfg.log(`room ${this.code}: ${kind} save`);
  }

  destroy(why) {
    this.save('final');
    clearInterval(this.timer);
    clearInterval(this.cursorTimer);
    for (const c of this.clients.values()) c.conn.close();
    this.onClose(this.code);
    this.cfg.log(`room ${this.code} closed (${why})`);
  }
}

module.exports = { Room };
