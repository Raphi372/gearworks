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

function createRegistry(config, store) {
  const rooms = new Map();     // code -> Room
  let nextPlayerId = 1;

  function makeCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c;
    do { c = ''; for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)]; } while (rooms.has(c));
    return c;
  }

  const deps = {
    config, store,
    newPlayerId: () => nextPlayerId++,
    onClose: (code) => rooms.delete(code),
  };

  function create(opts) {
    if (rooms.size >= config.MAX_ROOMS) return null;
    const code = (opts.code && !rooms.has(opts.code)) ? opts.code : makeCode();
    const room = new Room(Object.assign({}, opts, { code }), deps);
    rooms.set(code, room);
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
    all: () => Array.from(rooms.values()),
    destroyAll: (why) => { for (const r of Array.from(rooms.values())) r.destroy(why); },
  };
}

module.exports = { createRegistry };
