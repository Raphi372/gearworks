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
const sessions = require('./sessions');

function createLobby(config, registry, auth, store) {
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

    // identity used when joining: authenticated account, else the inline name
    function identity(m) {
      if (account) return { name: account.username, color: account.color, gz: (hello && hello.gz) };
      return { name: m.name || (hello && hello.name), color: m.color || (hello && hello.color), gz: (hello && hello.gz) };
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
        case 'listRooms':
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms(), account: account || null, maintenance: config.MAINTENANCE });
          return;
        case 'myWorlds': {
          if (!account || !store.accountsEnabled) return conn.send({ t: 'myWorlds', worlds: [] });
          const worlds = await store.worldsByOwner(account.id).catch(() => []);
          return conn.send({ t: 'myWorlds', worlds });
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
            client = r.addPlayer(conn, identity(m), asSpec ? 'spectator' : 'player');
            wire();
          });
        case 'resume':
          // load a saved world back into a live room, then host it
          return enterRoom(async () => {
            if (config.MAINTENANCE) return conn.send({ t: 'err', reason: 'server is in maintenance — try again shortly' });
            const code = String(m.code || '').toUpperCase().trim();
            if (registry.get(code)) {   // already live — just join it
              room = registry.get(code);
              client = room.addPlayer(conn, identity(m), 'player');
              return wire();
            }
            const saved = await store.loadRoom(code).catch(() => null);
            if (!saved) return conn.send({ t: 'err', reason: 'no saved world with that code' });
            // only the owner may resume a private saved world
            if (saved.meta.ownerId && (!account || account.id !== saved.meta.ownerId)) {
              return conn.send({ t: 'err', reason: 'that world belongs to another player' });
            }
            const r = registry.create({ code, name: saved.meta.name, public: !!m.public,
              ownerId: saved.meta.ownerId || (account && account.id), snapshot: saved.snapshot });
            if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
            room = r;
            client = r.addPlayer(conn, identity(m), 'host');
            wire();
          });
        case 'rejoin':
          return enterRoom(async () => {
            const sess = sessions.get(String(m.token || ''));
            const r = sess && registry.get(sess.roomCode);
            if (!r) return conn.send({ t: 'err', reason: 'session expired' });
            room = r;
            client = r.addPlayer(conn, { name: sess.name, color: sess.color, gz: hello && hello.gz }, sess.role, m.token);
            wire();
          });
      }
      if (room && client) room.onMessage(client, m);
    };
  };
}

module.exports = { createLobby };
