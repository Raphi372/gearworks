'use strict';
/* ==========================================================================
   players/lobby.js — pre-room connection handling (session entry point).

   A freshly upgraded WebSocket starts in "lobby scope": it can query the
   public room list and create / join / rejoin a room. Once it belongs to a
   room, further messages route to that Room. This is where a player's session
   is established (and, with the Postgres backend, where account auth would
   hook in — see docs/DATABASE.md).
   ========================================================================== */
const Core = require('../../shared/core.js');
const sessions = require('./sessions');

function createLobby(config, registry) {
  return function handleConn(conn) {
    let client = null;   // set once inside a room
    let room = null;
    let hello = null;

    function wire() {
      conn.onclose = () => { if (room && client) room.removePlayer(client, 'disconnected'); };
    }
    conn.onclose = () => {};

    conn.onmessage = (m) => {
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'hello':
          hello = { name: m.name, color: m.color, gz: m.gz };
          if (m.proto !== Core.PROTO) conn.send({ t: 'err', reason: 'protocol version mismatch — refresh the page' });
          else conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms() });
          return;
        case 'listRooms':
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms() });
          return;
        case 'create': {
          if (room) return;
          const r = registry.create({
            name: m.roomName, public: m.public, maxPlayers: m.maxPlayers,
            seed: (m.seed !== undefined && isFinite(m.seed)) ? m.seed : undefined,
          });
          if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
          room = r;
          client = r.addPlayer(conn, hello || m, m.spectate ? 'spectator' : 'host');
          wire();
          return;
        }
        case 'join': {
          if (room) return;
          const r = registry.get(m.code);
          if (!r) return conn.send({ t: 'err', reason: 'room not found' });
          const asSpec = !!m.spectate;
          if (!asSpec && r.nonSpectators() >= r.maxPlayers) return conn.send({ t: 'err', reason: 'room full' });
          room = r;
          client = r.addPlayer(conn, hello || m, asSpec ? 'spectator' : 'player');
          wire();
          return;
        }
        case 'rejoin': {   // reconnect with session token
          if (room) return;
          const sess = sessions.get(String(m.token || ''));
          const r = sess && registry.get(sess.roomCode);
          if (!r) return conn.send({ t: 'err', reason: 'session expired' });
          room = r;
          client = r.addPlayer(conn, { name: sess.name, color: sess.color }, sess.role, m.token);
          wire();
          return;
        }
      }
      if (room && client) room.onMessage(client, m);
    };
  };
}

module.exports = { createLobby };
