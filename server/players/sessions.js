'use strict';
/* ==========================================================================
   players/sessions.js — reconnect session store.

   Maps an opaque session token to a player's identity within a room. When a
   socket drops unexpectedly the client keeps its token and can `rejoin`,
   resuming the same seat with role intact. Tokens live only in memory (a
   dropped process forgets sessions — clients then re-join fresh), which is
   the correct trade-off for a single authoritative game process per room.

   This is deliberately a tiny singleton: reconnect tokens are global across
   rooms, and both the lobby and each Room need to read/update them.
   ========================================================================== */
const crypto = require('crypto');

const byToken = new Map();   // token -> { roomCode, playerId, name, color, role }

module.exports = {
  newToken() { return crypto.randomBytes(12).toString('hex'); },
  get(token) { return byToken.get(token); },
  set(token, rec) { byToken.set(token, rec); },
  remove(token) { byToken.delete(token); },
  updateRole(token, role) { const r = byToken.get(token); if (r) r.role = role; },
  get size() { return byToken.size; },
};
