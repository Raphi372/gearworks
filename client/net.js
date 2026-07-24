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
    chatHistory: [],
  };
  var seqN = 1;
  var ready = false;             // snapshot restored; tick stream may apply
  var early = [];                // messages that arrived before the snapshot
  var pingTimer = null, curTimer = null;
  var reconnectInfo = null;      // {token} once joined
  var attempts = 0;
  var intent = null;             // what to send once socket opens
  var closedByUser = false;
  var redirecting = false;       // rejoin is being routed to a different instance
  var pendingResolve = null;     // one-shot callback for a 'resolved' reply

  function setStatus(s) { self.status = s; cb.status && cb.status(s); }

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function clearReconnect() { try { localStorage.removeItem('gearworks_reconnect'); } catch (e) {} }

  function connect() {
    setStatus(attempts ? 'reconnecting' : 'connecting');
    try { ws = new WebSocket(url); } catch (e) { return fail('bad server address'); }
    ws.onopen = function () {
      attempts = 0;
      send({ t: 'hello', proto: Core.PROTO, name: intent.name, color: intent.color,
        authToken: intent.authToken || null,
        gz: typeof DecompressionStream !== 'undefined' });
      if (intent.kind === 'rejoin') send({ t: 'rejoin', token: intent.token });
      // create/join are sent after the lobby list arrives (see onmessage)
    };
    ws.onmessage = function (ev) { onMsg(JSON.parse(ev.data)); };
    ws.onclose = function () {
      stopTimers();
      if (redirecting) { redirecting = false; connect(); return; }   // rejoin moved to another instance
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
    pingTimer = setInterval(function () { send({ t: 'ping', ts: performance.now(), rtt: self.rtt }); }, 2000);
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
        cb.lobby && cb.lobby(m.rooms, m);      // m carries account + maintenance
        if (intent.kind === 'create') send({ t: 'create', roomName: intent.roomName, public: intent.public,
          maxPlayers: intent.maxPlayers, spectate: intent.spectate, seed: intent.seed });
        else if (intent.kind === 'join') send({ t: 'join', code: intent.code, spectate: intent.spectate, connectToken: intent.connectToken || null });
        else if (intent.kind === 'resume') send({ t: 'resume', code: intent.code, public: intent.public, connectToken: intent.connectToken || null });
        else if (intent.kind === 'browse') setStatus('lobby');
        return;
      case 'auth': cb.auth && cb.auth(m); return;
      case 'account': cb.account && cb.account(m); return;   // email set/verify result
      case 'token':                                          // server re-issued our reconnect token (role changed)
        self.token = m.token;
        if (reconnectInfo) { reconnectInfo.token = m.token; try { localStorage.setItem('gearworks_reconnect', m.token); } catch (e) {} }
        return;
      case 'myWorlds': cb.myWorlds && cb.myWorlds(m.worlds || []); return;
      case 'leaderboard': cb.leaderboard && cb.leaderboard(m.rows || [], m.scope || 'global'); return;
      case 'progression': cb.progression && cb.progression(m.progression || null); return;
      case 'stats': cb.stats && cb.stats(m.series || null); return;
      case 'achievements': cb.achievements && cb.achievements(m.achievements || null, m.fresh || []); return;
      case 'profile': cb.profile && cb.profile(m.profile || null, !!m.mine); return;
      case 'mod': cb.mod && cb.mod(m.bans || null, m.reports || null, m.flags || null, m.error || null); return;
      case 'reported': cb.reported && cb.reported(m); return;
      case 'friends': cb.friends && cb.friends(m); return;
      case 'invites': cb.invites && cb.invites(m.invites || []); return;
      case 'invited': cb.invited && cb.invited(m); return;
      case 'inviteAccepted': cb.inviteAccepted && cb.inviteAccepted(m); return;
      case 'quickplay': cb.quickplay && cb.quickplay(m); return;
      case 'resolved': { var rf = pendingResolve; pendingResolve = null; if (rf) rf(m); return; }
      case 'redirect':               // the room lives on another instance now — reconnect there
        if (m.url) { url = m.url; redirecting = true; try { ws.close(); } catch (e) {} }
        return;
      case 'welcome':
        self.myId = m.id; self.token = m.token; self.code = m.code; self.roomName = m.name;
        self.role = m.role; self.autosaveSec = m.autosaveSec;
        self.playersMap.clear();
        m.players.forEach(function (p) { self.playersMap.set(p.id, p); });
        self.chatHistory = m.chat || [];      // replayed to the log after join completes
        reconnectInfo = { token: m.token };
        // persist the reconnect token so a browser refresh / tab reload can
        // rejoin the still-live world, not just an in-session socket drop
        try { localStorage.setItem('gearworks_reconnect', m.token); } catch (e) {}
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
      case 'chat': cb.chat && cb.chat(m); return;
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
      case 'kicked': closedByUser = true; clearReconnect(); cb.kicked && cb.kicked(); return;
      case 'err': if (reconnectInfo) clearReconnect(); fail(m.reason); return;
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
  self.sendChat = function (text) { send({ t: 'chat', text: text }); };
  self.sendAuth = function (mode, data) { send(Object.assign({ t: 'auth', mode: mode }, data || {})); };
  self.sendSetEmail = function (email) { send({ t: 'setEmail', email: email }); };
  self.sendVerifyEmail = function (token) { send({ t: 'verifyEmail', token: token }); };
  self.sendLogout = function () { send({ t: 'logout' }); };
  self.requestMyWorlds = function () { send({ t: 'myWorlds' }); };
  self.requestLeaderboard = function (scope) { send({ t: 'leaderboard', scope: scope || 'global' }); };
  self.requestProgression = function () { send({ t: 'progression' }); };
  self.requestStats = function () { send({ t: 'stats' }); };
  self.requestAchievements = function () { send({ t: 'achievements' }); };
  self.requestProfile = function (username) { send(username ? { t: 'profile', username: username } : { t: 'profile' }); };
  self.sendSetProfile = function (patch) { send(Object.assign({ t: 'setProfile' }, patch || {})); };
  self.requestBans = function () { send({ t: 'mod' }); };
  self.sendBan = function (username, reason, days) { send({ t: 'ban', username: username, reason: reason, days: days || 0 }); };
  self.sendUnban = function (username) { send({ t: 'unban', username: username }); };
  self.sendReport = function (username, reason) { send({ t: 'report', username: username, reason: reason }); };
  self.sendReportResolve = function (id, action) { send({ t: 'reportResolve', id: id, action: action }); };
  self.sendFlagClear = function (id) { send({ t: 'flagClear', id: id }); };
  self.requestFriends = function () { send({ t: 'friends' }); };
  self.friendReq = function (username) { send({ t: 'friendReq', username: username }); };
  self.friendResp = function (id, accept) { send({ t: 'friendResp', id: id, accept: accept }); };
  self.friendRemove = function (id) { send({ t: 'friendRemove', id: id }); };
  self.friendBlock = function (id, blocked) { send({ t: 'friendBlock', id: id, blocked: blocked }); };
  self.quickplay = function (region) { send(region && region !== 'any' ? { t: 'quickplay', region: region } : { t: 'quickplay' }); };
  self.requestInvites = function () { send({ t: 'invites' }); };
  self.sendInvite = function (to, code) { send({ t: 'invite', to: to, code: code }); };
  self.inviteAccept = function (id) { send({ t: 'inviteAccept', id: id }); };
  self.inviteDecline = function (id) { send({ t: 'inviteDecline', id: id }); };
  // resolve a code → { url, connectToken, self } via the lobby socket, with a
  // timeout fallback so a slow/absent directory never blocks joining.
  self.resolve = function (code, cbk) {
    var done = false;
    function finish(m) { if (done) return; done = true; pendingResolve = null; cbk(m); }
    pendingResolve = finish;
    send({ t: 'resolve', code: code });
    setTimeout(function () { finish(null); }, 2000);
  };
  self.listRooms = function () { send({ t: 'listRooms' }); };
  self.requestResync = function () { send({ t: 'resync' }); };
  self.pump = function () {};   // sim advances on server messages only
  self.leave = function () { closedByUser = true; if (reconnectInfo) clearReconnect(); stopTimers(); try { ws && ws.close(); } catch (e) {} setStatus('offline'); };
  // test/debug: simulate an unexpected network drop (exercises reconnection)
  self._debugDrop = function () { try { ws && ws.close(); } catch (e) {} };
  return self;
}

/* expose */
window.LocalSession = LocalSession;
window.NetSession = NetSession;
