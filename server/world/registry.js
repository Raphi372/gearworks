'use strict';
/* ==========================================================================
   world/registry.js — the set of live game worlds (rooms).

   Owns the room map, invite-code generation, capacity limits, and the public
   room-browser listing. Constructs Room instances with their injected
   dependencies (persistence store, id allocator, self-removal callback), so
   Room never imports the registry back — no dependency cycle.
   ========================================================================== */
const crypto = require('crypto');
const { Room } = require('../simulation/room');

function createRegistry(config, store, tokens, metrics, directory) {
  const rooms = new Map();     // code -> Room
  let nextPlayerId = 1;

  function makeCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c;
    do { c = ''; for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)]; } while (rooms.has(c));
    return c;
  }

  function unregister(code) { rooms.delete(code); if (directory) directory.deregister(code); }
  const deps = {
    config, store, tokens, metrics,
    newPlayerId: () => nextPlayerId++,
    onClose: unregister,     // room self-removes (idle-evict / destroy) → also drop its route
  };

  function announce(room) {
    if (directory) directory.register(room.code, { public: room.public, players: room.nonSpectators() });
  }

  function create(opts) {
    if (rooms.size >= config.MAX_ROOMS) return null;
    const code = (opts.code && !rooms.has(opts.code)) ? opts.code : makeCode();
    const room = new Room(Object.assign({}, opts, { code }), deps);
    rooms.set(code, room);
    announce(room);          // publish this instance's ownership of the room to the directory
    return room;
  }

  function get(code) { return rooms.get(String(code || '').toUpperCase().trim()); }

  function publicRooms() {
    const list = [];
    for (const r of rooms.values()) {
      if (!r.public) continue;
      list.push({
        code: r.code, name: r.name,
        players: r.nonSpectators(),
        spectators: r.clients.size - r.nonSpectators(),
        maxPlayers: r.maxPlayers, tick: r.game.S.tick,
      });
    }
    return list;
  }

  return {
    create, get, publicRooms,
    size: () => rooms.size,
    connections: () => { let n = 0; for (const r of rooms.values()) n += r.clients.size; return n; },
    all: () => Array.from(rooms.values()),
    // refresh every owned room's directory route (called on an interval by server.js)
    // so live rooms stay "fresh" and crashed instances' routes go stale and evict.
    heartbeatDirectory: () => { if (directory) for (const r of rooms.values()) announce(r); },
    destroyAll: (why) => { for (const r of Array.from(rooms.values())) r.destroy(why); },
  };
}

module.exports = { createRegistry };
