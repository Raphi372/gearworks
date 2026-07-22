'use strict';
/* ==========================================================================
   players/lobby.js — pre-room connection handling (identity + session entry).

   A freshly upgraded WebSocket starts in "lobby scope". It can authenticate
   (register / login / guest / token), browse public games, list its own saved
   worlds, and create / join / resume / rejoin a room. Once it belongs to a
   room, further messages route to that Room.

   Authentication is OPTIONAL and additive: anonymous play still works exactly
   as before (create/join with an inline name), so nothing that relied on the
   pre-accounts flow breaks. Authenticated players get a persistent identity
   and ownership of the worlds they create.
   ========================================================================== */
const Core = require('../../shared/core.js');

function createLobby(config, registry, auth, store, tokens) {
  return function handleConn(conn) {
    let client = null;    // set once inside a room
    let room = null;
    let account = null;   // authenticated identity, or null (anonymous)
    let hello = null;
    let entering = false; // guards the async create/join/resume window

    function wire() {
      conn.onclose = () => { if (room && client) room.removePlayer(client, 'disconnected'); };
    }
    conn.onclose = () => {};

    // identity used when joining: authenticated account (with id, for membership),
    // else the inline name
    function identity(m) {
      if (account) return { name: account.username, color: account.color, gz: (hello && hello.gz), aid: account.id };
      return { name: m.name || (hello && hello.name), color: m.color || (hello && hello.color), gz: (hello && hello.gz) };
    }
    // role a returning authed player gets in a live room: owner or a prior
    // admin/host member is restored to admin (never host — no host hijack).
    function restoredRole(r) {
      if (!account) return 'player';
      const mr = r.memberRole(account.id);
      return (account.id === r.ownerId || mr === 'admin' || mr === 'host') ? 'admin' : 'player';
    }

    async function enterRoom(fn) {
      if (room || entering) return;
      entering = true;
      try { await fn(); } finally { entering = false; }
    }

    conn.onmessage = async (m) => {
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'hello': {
          hello = { name: m.name, color: m.color, gz: m.gz };
          if (m.proto !== Core.PROTO) return conn.send({ t: 'err', reason: 'protocol version mismatch — refresh the page' });
          if (m.authToken) account = await auth.fromToken(m.authToken);   // silent auto-login
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms(),
            account: account || null, maintenance: config.MAINTENANCE });
          return;
        }
        case 'auth': {
          // recovery flows establish no session and are handled up front
          if (m.mode === 'requestReset') {
            await auth.requestReset({ emailOrUsername: m.emailOrUsername || m.email || m.username });
            return conn.send({ t: 'auth', ok: true, mode: 'requestReset' });   // always ok (no account enumeration)
          }
          if (m.mode === 'resetPassword') {
            const r = await auth.resetPassword({ token: m.token, password: m.password });
            return conn.send({ t: 'auth', ok: !r.error, mode: 'resetPassword', error: r.error });
          }
          let res;
          if (m.mode === 'register') res = await auth.register({ username: m.username, password: m.password, color: m.color });
          else if (m.mode === 'login') res = await auth.login({ username: m.username, password: m.password });
          else if (m.mode === 'guest') res = await auth.guest({ username: m.username, color: m.color });
          else if (m.mode === 'token') { const a = await auth.fromToken(m.token); res = a ? { account: a, token: m.token } : { error: 'session expired' }; }
          else res = { error: 'bad auth mode' };
          if (res.error) return conn.send({ t: 'auth', ok: false, error: res.error });
          account = res.account;
          conn.send({ t: 'auth', ok: true, account: res.account, token: res.token });
          return;
        }
        case 'logout': account = null; return;
        case 'setEmail': {
          const r = await auth.setEmail({ account, email: m.email });
          if (r.account) account = r.account;
          return conn.send({ t: 'account', ok: !r.error, error: r.error, account: account || null });
        }
        case 'verifyEmail': {
          const r = await auth.verifyEmail({ token: m.token });
          if (!r.error && account && r.account && r.account.id === account.id) account = r.account;
          return conn.send({ t: 'account', ok: !r.error, error: r.error, account: account || null });
        }
        case 'listRooms':
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms(), account: account || null, maintenance: config.MAINTENANCE });
          return;
        case 'myWorlds': {
          if (!account || !store.accountsEnabled) return conn.send({ t: 'myWorlds', worlds: [] });
          const [owned, joined] = await Promise.all([
            store.worldsByOwner(account.id).catch(() => []),
            store.worldsByMember ? store.worldsByMember(account.id).catch(() => []) : [],
          ]);
          const byCode = new Map();   // owned entries win over joined
          owned.forEach((w) => byCode.set(w.code, { code: w.code, name: w.name, savedAt: w.savedAt, owner: true, role: 'host' }));
          joined.forEach((w) => { if (!byCode.has(w.code)) byCode.set(w.code, { code: w.code, name: w.name, savedAt: w.savedAt, owner: false, role: w.role || 'player' }); });
          const worlds = Array.from(byCode.values()).sort((a, b) => b.savedAt - a.savedAt);
          return conn.send({ t: 'myWorlds', worlds });
        }
        case 'leaderboard': {   // public: top factories by net worth
          const rows = store.topFactories ? await store.topFactories(20).catch(() => []) : [];
          return conn.send({ t: 'leaderboard', rows });
        }
        case 'create':
          return enterRoom(async () => {
            if (config.MAINTENANCE) return conn.send({ t: 'err', reason: 'server is in maintenance — try again shortly' });
            const r = registry.create({
              name: m.roomName, public: m.public, maxPlayers: m.maxPlayers,
              ownerId: account ? account.id : null,
              seed: (m.seed !== undefined && isFinite(m.seed)) ? m.seed : undefined,
            });
            if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
            room = r;
            client = r.addPlayer(conn, identity(m), m.spectate ? 'spectator' : 'host');
            wire();
          });
        case 'join':
          return enterRoom(async () => {
            const r = registry.get(m.code);
            if (!r) return conn.send({ t: 'err', reason: 'room not found' });
            const asSpec = !!m.spectate;
            if (!asSpec && r.nonSpectators() >= r.maxPlayers) return conn.send({ t: 'err', reason: 'room full' });
            room = r;
            client = r.addPlayer(conn, identity(m), asSpec ? 'spectator' : restoredRole(r));
            wire();
          });
        case 'resume':
          // load a saved world back into a live room, then host it
          return enterRoom(async () => {
            if (config.MAINTENANCE) return conn.send({ t: 'err', reason: 'server is in maintenance — try again shortly' });
            const code = String(m.code || '').toUpperCase().trim();
            const live = registry.get(code);
            if (live) {   // already live — join it with any restored role
              room = live;
              client = live.addPlayer(conn, identity(m), restoredRole(live));
              return wire();
            }
            const saved = await store.loadRoom(code).catch(() => null);
            if (!saved) return conn.send({ t: 'err', reason: 'no saved world with that code' });
            // access: the owner, OR anyone who has played it (a recorded member)
            const isMember = account && store.membership ? await store.membership(account.id, code).catch(() => null) : null;
            if (saved.meta.ownerId && (!account || (account.id !== saved.meta.ownerId && !isMember))) {
              return conn.send({ t: 'err', reason: 'that world belongs to another player' });
            }
            const r = registry.create({ code, name: saved.meta.name, public: !!m.public,
              ownerId: saved.meta.ownerId || (account && account.id),
              members: saved.meta.members || [],       // carry forward (file backend)
              snapshot: saved.snapshot });
            if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
            room = r;
            client = r.addPlayer(conn, identity(m), 'host');   // the resumer revives + hosts the session
            wire();
          });
        case 'rejoin':
          return enterRoom(async () => {
            const d = tokens.verify('reconnect', String(m.token || ''));
            if (!d) return conn.send({ t: 'err', reason: 'session expired' });
            const r = registry.get(d.room);
            if (!r) return conn.send({ t: 'err', reason: 'that game is no longer available' });
            // re-seat with the token's identity; a stale 'host' token can't hijack
            // an existing host — it rejoins as a player instead.
            let role = d.role;
            if (role === 'host' && r.hasHost()) role = 'player';
            room = r;
            client = r.addPlayer(conn, { name: d.name, color: d.color, gz: hello && hello.gz }, role, d.sid);
            wire();
          });
      }
      if (room && client) room.onMessage(client, m);
    };
  };
}

module.exports = { createLobby };
