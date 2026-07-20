/* ==========================================================================
   GEARWORKS CLIENT NETWORKING
   --------------------------------------------------------------------------
   Two interchangeable session drivers feed the deterministic core:

   • LocalSession — singleplayer. The client IS the server: commands are
     queued, validated and applied at the local 20 Hz loop, NPC decisions
     run locally. Identical semantics to multiplayer (placement lands on
     the next tick), so gameplay feel is the same in both modes.

   • NetSession — multiplayer. Commands go to the authoritative server;
     the sim advances ONLY on server tick messages (lockstep). Includes:
     prediction acks (ghosts are cleared when the server echoes/rejects),
     snapshot join/resync (gzip), state-hash self-audit, RTT measurement,
     a lossy cursor/view channel, and automatic reconnection.

   The game layer talks to a session through a tiny interface:
     submit(cmd) -> seq | pump(now) | role/myId/players/rtt/status
   All state changes surface through the core's hooks (applied/…).
   ========================================================================== */
'use strict';

/* ------------------------- LocalSession ------------------------------- */
function LocalSession(g, cb) {
  var queue = [];
  var seqN = 1;
  var acc = 0, last = 0;
  var TICK_MS = 1000 / Core.Config.SIM_HZ;

  function tickOnce() {
    if (g.S.tick % Core.Config.SIM_HZ === 0) {
      var ops = g.aiThink(Math.random);
      if (ops.length) queue.unshift({ t: 'ai', ops: ops, _p: 0 });
    }
    // mirror the server exactly: validate against evolving state, apply
    // accepted commands in order, then advance the sim one tick
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      var err = g.Commands.validate(q);
      if (err) { if (cb.reject) cb.reject(q._q, err, q); continue; }
      var res = g.Commands.apply(q);
      g.hooks.event && g.hooks.event('applied', { cmd: q, res: res });
    }
    queue.length = 0;
    g.Sim.tick();
  }

  return {
    mode: 'local', myId: 1, role: 'host', rtt: 0, status: 'local',
    players: function () { return [{ id: 1, name: 'You', color: '#4aa3ff', role: 'host' }]; },
    submit: function (cmd) {
      var q = Object.assign({}, cmd, { _p: 1, _q: seqN++ });
      queue.push(q);
      return q._q;
    },
    pump: function (now) {
      if (!last) last = now;
      acc += Math.min(250, now - last); last = now;
      var n = 0;
      while (acc >= TICK_MS && n < 10) { tickOnce(); acc -= TICK_MS; n++; }
      if (acc > TICK_MS * 40) acc = 0;
    },
    sendCursor: function () {}, sendView: function () {},
    saveNow: null, leave: function () {},
  };
}

/* -------------------------- NetSession -------------------------------- */
// The core game instance is created lazily via cb.ensureGame(seed) once the
// first snapshot arrives (the room's seed isn't known before that).
function NetSession(_unused, url, cb) {
  var ws = null;
  var self = {
    mode: 'net', myId: 0, role: 'player', rtt: 0, status: 'connecting',
    token: null, code: null, roomName: '', autosaveSec: 60,
    playersMap: new Map(),
    cursors: new Map(),          // id -> {x,y, px,py, t} for interpolation
    players: function () { return Array.from(self.playersMap.values()); },
  };
  var seqN = 1;
  var ready = false;             // snapshot restored; tick stream may apply
  var early = [];                // messages that arrived before the snapshot
  var pingTimer = null, curTimer = null;
  var reconnectInfo = null;      // {token} once joined
  var attempts = 0;
  var intent = null;             // what to send once socket opens
  var closedByUser = false;

  function setStatus(s) { self.status = s; cb.status && cb.status(s); }

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect() {
    setStatus(attempts ? 'reconnecting' : 'connecting');
    try { ws = new WebSocket(url); } catch (e) { return fail('bad server address'); }
    ws.onopen = function () {
      attempts = 0;
      send({ t: 'hello', proto: Core.PROTO, name: intent.name, color: intent.color,
        gz: typeof DecompressionStream !== 'undefined' });
      if (intent.kind === 'rejoin') send({ t: 'rejoin', token: intent.token });
      // create/join are sent after the lobby list arrives (see onmessage)
    };
    ws.onmessage = function (ev) { onMsg(JSON.parse(ev.data)); };
    ws.onclose = function () {
      stopTimers();
      if (closedByUser) return;
      if (reconnectInfo) {
        // in-game drop: try to resume the session automatically
        intent = { kind: 'rejoin', token: reconnectInfo.token, name: intent.name, color: intent.color };
        attempts++;
        if (attempts > 10) return fail('connection lost');
        var delay = Math.min(10000, 1000 * Math.pow(2, attempts - 1));
        cb.reconnecting && cb.reconnecting(attempts, delay);
        setTimeout(connect, delay);
      } else fail('connection failed');
    };
    ws.onerror = function () {};
  }

  function fail(reason) { setStatus('offline'); cb.fail && cb.fail(reason); }
  function stopTimers() { clearInterval(pingTimer); clearInterval(curTimer); }

  function startTimers() {
    clearInterval(pingTimer); clearInterval(curTimer);
    pingTimer = setInterval(function () { send({ t: 'ping', ts: performance.now() }); }, 2000);
    curTimer = setInterval(function () { cb.pollCursor && cb.pollCursor(); }, 100);
  }

  function applyGunzip(b64, done) {
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    if (typeof DecompressionStream === 'undefined') { done(null); return; }
    var ds = new DecompressionStream('gzip');
    new Response(new Blob([bytes]).stream().pipeThrough(ds)).text()
      .then(function (txt) { done(JSON.parse(txt)); })
      .catch(function () { done(null); });
  }

  function onMsg(m) {
    switch (m.t) {
      case 'lobby':
        cb.lobby && cb.lobby(m.rooms);
        if (intent.kind === 'create') send({ t: 'create', roomName: intent.roomName, public: intent.public,
          maxPlayers: intent.maxPlayers, spectate: intent.spectate, seed: intent.seed });
        else if (intent.kind === 'join') send({ t: 'join', code: intent.code, spectate: intent.spectate });
        else if (intent.kind === 'browse') setStatus('lobby');
        return;
      case 'welcome':
        self.myId = m.id; self.token = m.token; self.code = m.code; self.roomName = m.name;
        self.role = m.role; self.autosaveSec = m.autosaveSec;
        self.playersMap.clear();
        m.players.forEach(function (p) { self.playersMap.set(p.id, p); });
        reconnectInfo = { token: m.token };
        startTimers();
        setStatus('online');
        cb.joined && cb.joined();
        return;
      case 'snap':
        ready = false;
        var finish = function (snap) {
          if (!snap) { send({ t: 'resync' }); return; }
          var gg = cb.ensureGame(snap.seed);
          gg.Snapshot.restore(snap);
          ready = true;
          var e2 = early; early = [];
          e2.forEach(onMsg);
          cb.snapshot && cb.snapshot(m.why);
        };
        if (m.raw) finish(m.raw); else applyGunzip(m.gz, finish);
        return;
      case 'tk': case 'tks': {
        // buffer ticks that race the async snapshot decompression — they
        // are replayed in order once the snapshot is restored
        if (!ready) { if (early.length < 4000) early.push(m); return; }
        var gt = cb.game(); if (!gt) return;
        if (m.n <= gt.S.tick) return;                    // already covered by snapshot
        while (gt.S.tick < m.n - 1) gt.tickOnce(null);   // catch up heartbeat gap
        gt.tickOnce(m.t === 'tk' ? m.c : null);
        cb.ticked && cb.ticked();
        return;
      }
      case 'hash': {
        var gh = cb.game(); if (!gh) return;
        if (!ready || gh.S.tick !== m.n) return;
        var h = gh.stateHash();
        send({ t: 'hashReport', n: m.n, h: h });
        if (h !== m.h) cb.desync && cb.desync(m.n);
        return;
      }
      case 'rej': cb.reject && cb.reject(m.q, m.reason); return;
      case 'pong':
        self.rtt = Math.round(self.rtt * 0.7 + (performance.now() - m.ts) * 0.3);
        cb.rtt && cb.rtt(self.rtt);
        return;
      case 'cur':
        m.p.forEach(function (c) {
          var prev = self.cursors.get(c[0]);
          self.cursors.set(c[0], { px: prev ? prev.x : c[1], py: prev ? prev.y : c[2],
            x: c[1], y: c[2], t: performance.now() });
        });
        return;
      case 'pjoin': self.playersMap.set(m.p.id, m.p); cb.players && cb.players('join', m.p); return;
      case 'pleave': {
        var p = self.playersMap.get(m.id);
        self.playersMap.delete(m.id); self.cursors.delete(m.id);
        cb.players && cb.players('leave', p);
        return;
      }
      case 'prole': {
        var pr = self.playersMap.get(m.id);
        if (pr) pr.role = m.role;
        if (m.id === self.myId) self.role = m.role;
        cb.players && cb.players('role', pr);
        return;
      }
      case 'roomcfg': self.autosaveSec = m.autosaveSec; cb.players && cb.players('cfg'); return;
      case 'saved': cb.saved && cb.saved(m.by); return;
      case 'kicked': closedByUser = true; cb.kicked && cb.kicked(); return;
      case 'err': fail(m.reason); return;
    }
  }

  self.begin = function (what) { intent = what; connect(); };
  self.submit = function (cmd) {
    var q = seqN++;
    send({ t: 'cmd', q: q, cmd: cmd });
    return q;
  };
  self.sendCursor = function (x, y) { send({ t: 'cur', x: x, y: y }); };
  self.sendView = function (r) { send({ t: 'view', r: r }); };
  self.saveNow = function () { send({ t: 'save' }); };
  self.setAutosave = function (v) { send({ t: 'setAutosave', v: v }); };
  self.admin = function (op, id, role) { send({ t: 'adm', op: op, id: id, role: role }); };
  self.listRooms = function () { send({ t: 'listRooms' }); };
  self.requestResync = function () { send({ t: 'resync' }); };
  self.pump = function () {};   // sim advances on server messages only
  self.leave = function () { closedByUser = true; stopTimers(); try { ws && ws.close(); } catch (e) {} setStatus('offline'); };
  // test/debug: simulate an unexpected network drop (exercises reconnection)
  self._debugDrop = function () { try { ws && ws.close(); } catch (e) {} };
  return self;
}

/* expose */
window.LocalSession = LocalSession;
window.NetSession = NetSession;
