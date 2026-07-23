/* ==========================================================================
   GEARWORKS CLIENT — multiplayer lobby, accounts, worlds, leaderboard, progression, stats
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
/* ============================ LOBBY ================================= */
var Lobby = (function () {
  var COLORS = ['#4aa3ff', '#7CFC9E', '#ffd873', '#ff7a7a', '#d76fb0', '#9fd8e0', '#e0a074', '#b39ddb'];
  var color = COLORS[0];
  var browserSess = null;     // lobby connection (auth + room browser)
  var browserAddr = null;     // address browserSess connected to (reconnect if it changes)
  var account = null;         // { id, username, color, guest } or null
  var authToken = null;       // persisted session token
  var authTab = 'guest';      // guest | login | register
  var forgotOpen = false;     // password-reset sub-form visible
  var resetPrefill = null;    // reset token from an emailed link (?reset=)
  var pendingVerify = null;   // verify token from an emailed link (?verify=)
  var resuming = false;       // rejoining a live game from a stored reconnect token

  function el(id) { return document.getElementById(id); }
  function esc(s) { return UI.esc(s); }

  /* ---------------------- server auto-discovery --------------------- */
  // Optional: fetch a small pointer (GEARWORKS_DISCOVERY_URL) that holds the
  // CURRENT game-server address, so a rotating quick-tunnel URL never needs
  // re-typing on any device. The pointer contents are kept up to date by the
  // tunnel script (scripts/tunnel-up.sh); the URL itself is stable.
  var discUrl = (typeof window.GEARWORKS_DISCOVERY_URL === 'string' && window.GEARWORKS_DISCOVERY_URL) || '';
  function parseDiscovery(txt) {
    txt = String(txt || '').trim();
    if (!txt) return '';
    try { var j = JSON.parse(txt); if (j && j.server) txt = String(j.server).trim(); } catch (e) {}
    var m = txt.match(/\b(wss?|https?):\/\/[^\s"']+/);
    if (!m) return '';
    return m[0].replace(/^http(s?):/i, 'ws$1:');   // normalize http(s) -> ws(s)
  }
  function applyDiscovery(cb) {
    cb = cb || function () {};
    if (!discUrl || typeof fetch === 'undefined') return cb();
    var done = false;
    var finish = function () { if (!done) { done = true; cb(); } };
    var timer = setTimeout(finish, 2500);   // never block the lobby on a slow pointer
    var url = discUrl + (discUrl.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 30000);
    fetch(url, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (txt) {
      var addr = parseDiscovery(txt);
      if (addr) { el('lb-server').value = addr; savePrefs(); }
    }).catch(function () {}).then(function () { clearTimeout(timer); finish(); });
  }

  function init() {
    var sw = el('lb-colors');
    COLORS.forEach(function (c, i) {
      var d = document.createElement('div');
      d.className = 'swatch' + (i === 0 ? ' sel' : ''); d.style.background = c;
      d.onclick = function () {
        sw.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('sel'); });
        d.classList.add('sel'); color = c; savePrefs();
      };
      sw.appendChild(d);
    });
    try {
      var prefs = JSON.parse(localStorage.getItem('gearworks_prefs') || '{}');
      if (prefs.name) el('lb-name').value = prefs.name;
      if (prefs.color && COLORS.includes(prefs.color)) {
        color = prefs.color;
        sw.querySelectorAll('.swatch').forEach(function (x, i) { x.classList.toggle('sel', COLORS[i] === color); });
      }
      if (prefs.server) el('lb-server').value = prefs.server;
      authToken = localStorage.getItem('gearworks_token') || null;
    } catch (e) {}
    // emailed recovery links land back here as ?reset=<code> / ?verify=<code>
    try {
      var qs = new URLSearchParams(location.search || '');
      if (qs.get('reset')) { resetPrefill = qs.get('reset'); forgotOpen = true; authTab = 'login'; }
      if (qs.get('verify')) pendingVerify = qs.get('verify');
    } catch (e) {}
    if (!el('lb-server').value) {
      // Priority: a build-injected backend (Cloudflare Pages → your tunnel),
      // then the current origin (single-box self-host), then localhost.
      var injected = (typeof window.GEARWORKS_DEFAULT_SERVER === 'string' && window.GEARWORKS_DEFAULT_SERVER) || '';
      el('lb-server').value = injected ||
        (location.protocol.startsWith('http')
          ? location.origin.replace(/^http/, 'ws') : 'ws://localhost:8080');
    }
    el('lb-back').onclick = function () { hide(); el('mainmenu').classList.remove('hidden'); };
    el('lb-refresh').onclick = function () { applyDiscovery(reconnectBrowser); };
    el('lb-lb-refresh').onclick = function () { if (browserSess) browserSess.requestLeaderboard(); };
    el('lb-create').onclick = function () {
      go({ kind: 'create', roomName: el('lb-roomname').value || 'Factory World',
        public: el('lb-public').checked, maxPlayers: +el('lb-max').value || 8,
        spectate: el('lb-spectate').checked });
    };
    el('lb-join').onclick = function () {
      var code = el('lb-code').value.trim().toUpperCase();
      if (code.length !== 6) { err('Enter a 6-character invite code'); return; }
      go({ kind: 'join', code: code, spectate: el('lb-spectate').checked });
    };
    el('lb-rooms').addEventListener('click', function (e) {
      var b = e.target.closest('[data-roomcode]');
      if (b) go({ kind: 'join', code: b.dataset.roomcode, spectate: el('lb-spectate').checked });
    });
    el('lb-myworlds').addEventListener('click', function (e) {
      var b = e.target.closest('[data-resume]');
      if (b) go({ kind: 'resume', code: b.dataset.resume, public: false });
    });
    el('reconn-leave').onclick = function () { location.reload(); };
    renderAccount();
    applyDiscovery();   // pre-warm the current server address before Multiplayer is opened
  }

  function savePrefs() {
    try {
      localStorage.setItem('gearworks_prefs', JSON.stringify({
        name: el('lb-name').value, color: color, server: el('lb-server').value }));
    } catch (e) {}
  }

  function show() {
    el('mainmenu').classList.add('hidden');
    el('lobby').classList.remove('hidden');
    err('');
    applyDiscovery(reconnectBrowser);
  }
  function hide() {
    el('lobby').classList.add('hidden');
    if (browserSess) { browserSess.leave(); browserSess = null; }
  }
  function err(s) { el('lb-err').textContent = s || ''; }
  function setDot(cls) { var d = el('lb-conndot'); if (d) d.className = 'netdot ' + cls; }

  /* --------------------------- account UI --------------------------- */
  function renderAccount() {
    var host = el('lb-account');
    if (account) {
      var eh = '';
      if (!account.guest) {
        eh = '<div class="acc-email">' +
          (account.email
            ? 'Email: <b>' + esc(account.email) + '</b> ' + (account.emailVerified
                ? '<span style="color:#7CFC9E">✓ verified</span>'
                : '<span style="color:#ffd873">unverified</span>')
            : '<span style="color:#8aa">Add an email so you can recover your password.</span>') +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<input class="txt" id="acc-email" placeholder="you@example.com" style="flex:1;margin:0" maxlength="200" autocomplete="email">' +
            '<button class="btn gray" id="acc-email-save">' + (account.email ? 'Change' : 'Add') + '</button></div>' +
          (account.email && !account.emailVerified
            ? '<div style="display:flex;gap:6px;margin-top:6px">' +
                '<input class="txt" id="acc-verify" placeholder="verification code from email" style="flex:1;margin:0">' +
                '<button class="btn gray" id="acc-verify-go">Verify</button></div>'
            : '') +
          '<div class="acc-err" id="acc-err"></div></div>';
      }
      host.innerHTML = '<div class="acc-signed"><span class="avatar" style="background:' + account.color + '">' +
        esc((account.username || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span style="flex:1">Signed in as <b>' + esc(account.username) + '</b>' + (account.guest ? ' <span style="color:#8aa">(guest)</span>' : '') + '</span>' +
        '<button class="btn gray" id="acc-logout">Log out</button></div>' +
        '<div class="acc-guest">Your worlds are saved to this account and appear below.</div>' + eh;
      el('acc-logout').onclick = logout;
      var es = el('acc-email-save'); if (es) es.onclick = doSetEmail;
      var vg = el('acc-verify-go'); if (vg) vg.onclick = doVerify;
      // identity comes from the account now
      el('lb-name').value = account.username; el('lb-name').disabled = true;
    } else {
      el('lb-name').disabled = false;
      var t = authTab;
      var h = '<div class="acc-tabs">' +
        '<div class="acc-tab ' + (t === 'guest' ? 'sel' : '') + '" data-atab="guest">Guest</div>' +
        '<div class="acc-tab ' + (t === 'login' ? 'sel' : '') + '" data-atab="login">Log in</div>' +
        '<div class="acc-tab ' + (t === 'register' ? 'sel' : '') + '" data-atab="register">Register</div></div>';
      if (t === 'guest') {
        h += '<div class="acc-guest">Play instantly. Sign up to keep your worlds across devices.</div>' +
          '<button class="btn" id="acc-go" style="width:100%;margin-top:6px">Continue as Guest</button>';
      } else {
        h += '<input class="txt" id="acc-user" placeholder="username" maxlength="20" autocomplete="username">' +
          '<input class="txt" id="acc-pass" type="password" placeholder="password (8+ chars)" maxlength="200" autocomplete="' + (t === 'register' ? 'new-password' : 'current-password') + '">' +
          '<button class="btn" id="acc-go" style="width:100%;margin-top:4px">' + (t === 'register' ? 'Create account' : 'Log in') + '</button>' +
          (t === 'login' ? '<div class="acc-forgot" style="text-align:center;margin-top:6px"><a href="#" id="acc-forgot" style="color:#8aa;font-size:12px">Forgot password?</a></div>' : '');
      }
      if (forgotOpen || resetPrefill) {
        h += '<div class="acc-reset" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)">' +
          '<div style="font-size:11px;color:#8aa;margin-bottom:4px">Reset your password</div>' +
          '<input class="txt" id="acc-rid" placeholder="your email or username">' +
          '<button class="btn gray" id="acc-sendreset" style="width:100%;margin-bottom:8px">Email me a reset code</button>' +
          '<input class="txt" id="acc-rtoken" placeholder="reset code from email"' + (resetPrefill ? ' value="' + esc(resetPrefill) + '"' : '') + '>' +
          '<input class="txt" id="acc-rpass" type="password" placeholder="new password (8+ chars)" maxlength="200">' +
          '<button class="btn" id="acc-doreset" style="width:100%">Set new password</button></div>';
      }
      h += '<div class="acc-err" id="acc-err"></div>';
      host.innerHTML = h;
      host.querySelectorAll('[data-atab]').forEach(function (x) {
        x.onclick = function () { authTab = x.dataset.atab; renderAccount(); };
      });
      el('acc-go').onclick = doAuth;
      var pass = el('acc-pass'); if (pass) pass.onkeydown = function (e) { if (e.key === 'Enter') doAuth(); };
      var fl = el('acc-forgot'); if (fl) fl.onclick = function (e) { e.preventDefault(); forgotOpen = !forgotOpen; renderAccount(); };
      var sr = el('acc-sendreset'); if (sr) sr.onclick = doSendReset;
      var dr = el('acc-doreset'); if (dr) dr.onclick = doReset;
    }
  }

  function accErr(s) { var e = el('acc-err'); if (e) e.textContent = s || ''; }

  function doAuth() {
    if (!browserSess) { reconnectBrowser(); }
    if (!browserSess) { accErr('Not connected to a server'); return; }
    if (authTab === 'guest') {
      browserSess.sendAuth('guest', { username: el('lb-name').value || 'Guest', color: color });
    } else {
      var u = (el('acc-user').value || '').trim(), p = el('acc-pass').value || '';
      if (!u || !p) { accErr('Enter a username and password'); return; }
      accErr('…');
      browserSess.sendAuth(authTab, { username: u, password: p, color: color });
    }
  }

  function doSendReset() {
    if (!browserSess) reconnectBrowser();
    if (!browserSess) { accErr('Not connected to a server'); return; }
    var id = (el('acc-rid').value || '').trim();
    if (!id) { accErr('Enter your email or username'); return; }
    browserSess.sendAuth('requestReset', { emailOrUsername: id });
    accErr('If that account has a verified email, a reset code is on its way.');
  }
  function doReset() {
    if (!browserSess) { accErr('Not connected to a server'); return; }
    var tok = (el('acc-rtoken').value || '').trim(), p = el('acc-rpass').value || '';
    if (!tok || !p) { accErr('Enter the reset code and a new password'); return; }
    browserSess.sendAuth('resetPassword', { token: tok, password: p });
  }
  function doSetEmail() {
    if (!browserSess) { accErr('Not connected to a server'); return; }
    var e = (el('acc-email').value || '').trim();
    if (!e) { accErr('Enter an email address'); return; }
    browserSess.sendSetEmail(e);
  }
  function doVerify() {
    if (!browserSess) { accErr('Not connected to a server'); return; }
    var t = (el('acc-verify').value || '').trim();
    if (!t) { accErr('Enter the verification code'); return; }
    browserSess.sendVerifyEmail(t);
  }

  function onAuth(m) {
    if (m.mode === 'requestReset') { accErr('If that account has a verified email, a reset code is on its way.'); return; }
    if (m.mode === 'resetPassword') {
      if (!m.ok) { accErr(m.error || 'reset failed'); return; }
      forgotOpen = false; resetPrefill = null; authTab = 'login'; renderAccount();
      err('Password reset — you can now log in.');
      return;
    }
    if (!m.ok) { accErr(m.error || 'failed'); return; }
    account = m.account;
    authToken = m.token;
    try { localStorage.setItem('gearworks_token', authToken); } catch (e) {}
    renderAccount();
    if (browserSess) { browserSess.requestMyWorlds(); browserSess.requestProgression(); browserSess.requestStats(); }
  }

  function onAccount(m) {
    if (!m.ok) { accErr(m.error || 'could not update email'); return; }
    if (m.account) account = m.account;
    renderAccount();
    accErr(account && account.emailVerified ? 'Email verified ✓' : 'Check your email for a verification code.');
  }

  function logout() {
    account = null; authToken = null;
    try { localStorage.removeItem('gearworks_token'); } catch (e) {}
    if (browserSess) browserSess.sendLogout();
    renderAccount();
    el('lb-myworlds').innerHTML = '';
    el('lb-progress').innerHTML = '';
    el('lb-stats').innerHTML = '';
  }

  // an inline-SVG sparkline (CSP-safe: no external libs, no inline handlers)
  function sparkline(points) {
    var n = points.length;
    if (n < 2) return '';
    var W = 100, H = 24, pad = 2;
    var min = Infinity, max = -Infinity;
    points.forEach(function (v) { if (v < min) min = v; if (v > max) max = v; });
    var range = max - min || 1;
    var d = points.map(function (v, i) {
      var x = pad + i / (n - 1) * (W - 2 * pad);
      var y = H - pad - (v - min) / range * (H - 2 * pad);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="none" stroke="#4aa3ff" stroke-width="1.5" ' +
      'stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function onStats(series) {
    var host = el('lb-stats');
    if (!host) return;
    if (!account || !series) { host.innerHTML = ''; return; }
    // show the two most telling metrics as sparklines over time
    var cards = [{ key: 'net_worth', label: 'Net worth', money: true }, { key: 'xp', label: 'XP', money: false }];
    var any = false;
    var h = '<div class="spark-grid">';
    cards.forEach(function (c) {
      var pts = (series[c.key] || []).map(function (p) { return p.v | 0; });
      if (!pts.length) return;
      any = true;
      var last = pts[pts.length - 1];
      h += '<div class="spark"><div class="sk-top"><span class="sk-label">' + esc(c.label) + '</span>' +
        '<span class="sk-val">' + (c.money ? '$' + fmtMoney(last) : fmtMoney(last)) + '</span></div>' +
        sparkline(pts) + '</div>';
    });
    h += '</div>';
    host.innerHTML = any ? h : '';
  }

  function onProgression(p) {
    var host = el('lb-progress');
    if (!host) return;
    if (!account || !p) { host.innerHTML = ''; return; }
    var span = Math.max(1, (p.xpNextLevel | 0) - (p.xpThisLevel | 0));
    var into = Math.max(0, (p.xp | 0) - (p.xpThisLevel | 0));
    var pct = Math.max(0, Math.min(100, Math.round(into / span * 100)));
    var techLine = p.unlockedTech && p.unlockedTech.length
      ? p.unlockedTech.length + ' tech unlocked across your worlds'
      : 'Research tech in your worlds to unlock more';
    host.innerHTML =
      '<div class="lvl-row"><div class="lvl-badge">' + (p.level | 0) + '</div>' +
      '<div class="lvl-meta"><div class="lvl-top"><span>Level ' + (p.level | 0) + '</span>' +
        '<span>' + fmtMoney(into) + ' / ' + fmtMoney(span) + ' XP</span></div>' +
        '<div class="lvl-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="lvl-tech">' + esc(techLine) + '</div></div></div>';
  }

  function onMyWorlds(worlds) {
    var host = el('lb-myworlds');
    if (!account || !worlds || !worlds.length) { host.innerHTML = ''; return; }
    var h = '<div class="divider"></div><b style="font-size:13px">Your worlds</b>';
    worlds.forEach(function (w) {
      var when = w.savedAt ? new Date(w.savedAt).toLocaleString() : '';
      // owner sees "Owner" + Resume; a member (played but doesn't own it) sees
      // their role + Rejoin. The server enforces access either way.
      var badge = w.owner
        ? '<span class="wbadge own">Owner</span>'
        : '<span class="wbadge mem">' + esc(w.role || 'player') + '</span>';
      h += '<div class="world-row"><div><div class="wn">' + esc(w.name) + badge + '</div>' +
        '<div class="wd">' + esc(w.code) + (when ? ' • ' + esc(when) : '') + '</div></div>' +
        '<button class="btn" data-resume="' + esc(w.code) + '">' + (w.owner ? 'Resume' : 'Rejoin') + '</button></div>';
    });
    host.innerHTML = h;
  }

  function fmtMoney(n) {
    n = n | 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }
  function onLeaderboard(rows) {
    var host = el('lb-leaderboard');
    if (!rows || !rows.length) { host.innerHTML = '<p style="color:#667;font-size:12px">No factories yet — be the first!</p>'; return; }
    var mine = account ? account.id : null;
    var h = '';
    rows.forEach(function (r, i) {
      var you = !!(r.ownerId && r.ownerId === mine);
      h += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)' + (you ? ';background:rgba(74,163,255,.08)' : '') + '">' +
        '<span style="width:22px;text-align:center;color:#8aa;font-weight:600">' + (i + 1) + '</span>' +
        '<div style="flex:1;min-width:0"><div class="wn">' + esc(r.name || 'World') + (you ? ' <span style="color:#4aa3ff">(you)</span>' : '') + '</div>' +
        '<div class="wd">' + esc(r.ownerName || 'anonymous') + ' • $' + fmtMoney(r.money) + ' • ' + (r.entities | 0) + ' bld • ' + (r.tech | 0) + ' tech</div></div></div>';
    });
    host.innerHTML = h;
  }

  /* --------------------------- room browser ------------------------- */
  function reconnectBrowser() {
    // reuse the existing connection only if it targets the same address;
    // discovery/refresh can change the address and must reconnect.
    if (browserSess && browserAddr === el('lb-server').value) { browserSess.listRooms(); if (account) { browserSess.requestMyWorlds(); browserSess.requestProgression(); browserSess.requestStats(); } return; }
    if (browserSess) { browserSess.leave(); browserSess = null; }
    savePrefs();
    setDot('warn');
    browserAddr = el('lb-server').value;
    browserSess = NetSession(null, el('lb-server').value, {
      ensureGame: function () { return null; },
      game: function () { return null; },
      lobby: function (rooms, m) {
        setDot('on');
        if (m && m.maintenance) el('lb-maint').classList.remove('hidden'); else el('lb-maint').classList.add('hidden');
        if (m && m.account) { account = m.account; renderAccount(); browserSess.requestMyWorlds(); browserSess.requestProgression(); browserSess.requestStats(); }
        if (pendingVerify) { browserSess.sendVerifyEmail(pendingVerify); pendingVerify = null; }
        browserSess.requestLeaderboard();
        onRooms(rooms);
      },
      auth: function (m) { onAuth(m); },
      account: function (m) { onAccount(m); },
      myWorlds: function (worlds) { onMyWorlds(worlds); },
      leaderboard: function (rows) { onLeaderboard(rows); },
      progression: function (p) { onProgression(p); },
      stats: function (series) { onStats(series); },
      fail: function (reason) { setDot('off'); onFail(reason); browserSess = null; },
      status: function (s) { if (s === 'offline') setDot('off'); },
    });
    // auto-login with a stored token so returning players are signed in
    browserSess.begin({ kind: 'browse', name: el('lb-name').value || 'Engineer', color: color, authToken: authToken });
  }

  function onRooms(rooms) {
    var host = el('lb-rooms');
    if (!rooms || !rooms.length) { host.innerHTML = '<p style="color:#667;font-size:12px">No public games yet — host one below!</p>'; return; }
    var h = '';
    rooms.forEach(function (r) {
      var cap = r.maxPlayers ? (r.players + '/' + r.maxPlayers + ' players') : (r.players + ' online');
      var reg = (r.region && r.region !== 'local') ? ' • ' + esc(r.region) : '';
      h += '<div class="roomrow"><div><div class="rn">' + esc(r.name) + '</div>' +
        '<div class="rd">' + cap + (r.spectators ? ' +' + r.spectators + ' 👁' : '') + ' • code ' + esc(r.code) + reg + '</div></div>' +
        '<button class="btn" data-roomcode="' + esc(r.code) + '">Join</button></div>';
    });
    host.innerHTML = h;
  }
  // Rejoin a still-live game after a full page reload, using the stored token.
  // Resolve discovery first so we rejoin on the current server address.
  function resume(token) {
    applyDiscovery(function () {
      var prefs = {}; try { prefs = JSON.parse(localStorage.getItem('gearworks_prefs') || '{}'); } catch (e) {}
      var srv = (el('lb-server') && el('lb-server').value) || prefs.server || '';
      if (!srv) return;
      resuming = true;
      el('mainmenu').classList.add('hidden');
      var rc = document.getElementById('reconn');
      if (rc) { rc.classList.remove('hidden'); var rm = document.getElementById('reconn-msg'); if (rm) rm.textContent = 'Rejoining your game…'; }
      Game.startNet(srv, { kind: 'rejoin', token: token, name: prefs.name || 'Engineer', color: color, authToken: authToken });
    });
  }
  function resumed() { resuming = false; }

  // A first-connect failure is expected on a static host whose origin isn't a
  // game server — show a neutral hint, not an alarming "Connection failed".
  function onFail(reason) {
    if (resuming) {   // the browser-refresh rejoin failed → the seat is gone; drop to the menu
      resuming = false;
      try { localStorage.removeItem('gearworks_reconnect'); } catch (e) {}
      var rc = document.getElementById('reconn'); if (rc) rc.classList.add('hidden');
      el('mainmenu').classList.remove('hidden');
      return;
    }
    err(reason && reason !== 'connection failed' ? reason : 'Not connected — check the server address, then Refresh.');
  }

  function go(intent) {
    savePrefs();
    intent.name = account ? account.username : (el('lb-name').value || 'Engineer');
    intent.color = color;
    intent.authToken = authToken;
    err('Connecting…');
    // For a coded join/resume, ask the connected lobby to resolve the room to
    // its owning instance and hand us a signed connect token (§4.3). Single
    // instance → self:true with our own address, so the flow is unchanged. If
    // there's no lobby socket or resolve times out, fall straight through.
    var canResolve = browserSess && (intent.kind === 'join' || intent.kind === 'resume') && intent.code;
    if (canResolve) {
      browserSess.resolve(intent.code, function (res) {
        if (browserSess) { browserSess.leave(); browserSess = null; }
        if (res && res.connectToken) intent.connectToken = res.connectToken;
        Game.startNet((res && res.url) || el('lb-server').value, intent);
      });
      return;
    }
    if (browserSess) { browserSess.leave(); browserSess = null; }
    Game.startNet(el('lb-server').value, intent);
  }

  return { init: init, show: show, hide: hide, onRooms: onRooms, onFail: onFail, resume: resume, resumed: resumed };
})();
