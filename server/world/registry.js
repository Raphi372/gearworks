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

function createRegistry(config, store, tokens, metrics, directory, presence) {
  const rooms = new Map();     // code -> Room
  let nextPlayerId = 1;

  function makeCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c;
    // avoid codes live locally OR owned by another instance (shared directory)
    do { c = ''; for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)]; }
    while (rooms.has(c) || (directory && directory.ownedElsewhere(c)));
    return c;
  }

  function unregister(code) { rooms.delete(code); if (directory) directory.deregister(code); }
  const deps = {
    config, store, tokens, metrics, presence,
    newPlayerId: () => nextPlayerId++,
    onClose: unregister,     // room self-removes (idle-evict / destroy) → also drop its route
  };

  function announce(room) {
    if (directory) directory.register(room.code, { name: room.name, public: room.public, players: room.nonSpectators(), maxPlayers: room.maxPlayers });
  }

  function create(opts) {
    if (rooms.size >= config.MAX_ROOMS) return null;
    const code = (opts.code && !rooms.has(opts.code)) ? opts.code : makeCode();
    // claim the code in the directory first (split-brain guard). If a live peer
    // already owns it (e.g. two instances restoring the same world on boot, or a
    // resume racing the owner), refuse — the caller routes the client instead.
    if (directory && !directory.claim(code, { name: opts.name, public: opts.public, players: 0 })) return null;
    const room = new Room(Object.assign({}, opts, { code }), deps);
    rooms.set(code, room);
    announce(room);          // refresh the route with the live room's name/players
    return room;
  }

  function get(code) { return rooms.get(String(code || '').toUpperCase().trim()); }

  function publicRooms() {
    const list = [];
    const seen = new Set();
    for (const r of rooms.values()) {
      if (!r.public) continue;
      seen.add(r.code);
      list.push({
        code: r.code, name: r.name,
        players: r.nonSpectators(),
        spectators: r.clients.size - r.nonSpectators(),
        maxPlayers: r.maxPlayers, tick: r.game.S.tick,
        region: config.REGION, here: true,
      });
    }
    // aggregate public rooms hosted on OTHER instances (multi-instance browser).
    // Remote rows carry only what the directory knows; joining one resolves to
    // its owning instance via the connect-token handoff. No-op in 'local' mode.
    if (directory) {
      for (const rt of directory.list({ public: true })) {
        if (rt.self || seen.has(rt.code)) continue;
        seen.add(rt.code);
        list.push({ code: rt.code, name: rt.name, players: rt.players, maxPlayers: rt.maxPlayers | 0,
          tick: 0, region: rt.region, url: rt.url, here: false });
      }
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
