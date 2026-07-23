#!/usr/bin/env node
'use strict';
/* ==========================================================================
   GEARWORKS DEDICATED SERVER — authoritative multiplayer host (entry point)
   --------------------------------------------------------------------------
   Wires the modules together and owns the process lifecycle. The interesting
   logic lives in the modules:

     config.js              env/flag configuration + structured logging
     network/websocket.js   RFC 6455 transport (zero-dependency)
     network/httpServer.js  /health, static files, WS upgrade, security headers
     players/tokens.js      shared HMAC signer (session/reconnect/recovery tokens)
     players/lobby.js       pre-room connection handling (create/join/rejoin)
     world/registry.js      the set of live rooms + invite codes
     simulation/room.js     one authoritative deterministic game per room
     database/*             persistence abstraction (file default | postgres)

   Run (local):   node server/server.js [--port 8080] [--save-dir saves]
   Run (prod):    PORT=8080 STORAGE=file node server/server.js
   Resume a save: node server/server.js --load saves/<CODE>.json
   ========================================================================== */
const config = require('./config');
const { WSConn } = require('./network/websocket');
const { createHttpServer } = require('./network/httpServer');
const { createStore } = require('./database');
const { createRegistry } = require('./world/registry');
const { createLobby } = require('./players/lobby');
const { createAuth } = require('./players/accounts');
const { createTokens } = require('./players/tokens');
const { createMonitoring } = require('./monitoring');
const { createMailer } = require('./mailer');
const { createStatSampler } = require('./stats');

const log = config.log;
const monitor = createMonitoring(config);
const mailer = createMailer(config);
const tokens = createTokens(config);   // shared HMAC signer (sessions + reconnect + recovery)

async function main() {
  const store = createStore(config);
  try { await store.ready(); }
  catch (e) { log.error(`persistence backend not ready: ${e.message}`); process.exit(1); }

  const registry = createRegistry(config, store, tokens);
  const auth = createAuth(config, store, mailer, tokens);
  const stats = createStatSampler(config, registry, store);
  const handleConn = createLobby(config, registry, auth, store, tokens);

  const server = createHttpServer(config, {
    getStats: () => ({ rooms: registry.size(), connections: registry.connections() }),
    onUpgrade: (socket) => handleConn(new WSConn(socket)),
  });

  // resume a saved world from a file (file backend)
  if (config.LOAD_FILE) {
    const data = await store.loadFile(config.LOAD_FILE);
    if (!data) { log.error(`failed to load ${config.LOAD_FILE}`); process.exit(1); }
    const r = registry.create({ name: data.meta.name, public: true, snapshot: data.snapshot, code: data.meta.code });
    log(`resumed save into room ${r.code} ("${r.name}") @tick ${r.game.S.tick}`);
  }

  // Restart/deploy continuity: re-create rooms saved in the recent window as
  // live games, so an ongoing world survives a process restart (or crash) and
  // stays joinable — players can rejoin by code / the public browser, owners
  // don't have to manually Resume. Empty rooms idle-evict as usual.
  if (config.RESTORE_ON_BOOT && store.recentRooms) {
    const since = Date.now() - config.RESTORE_WINDOW_MIN * 60 * 1000;
    const recent = await store.recentRooms(since).catch((e) => { log.error(`restore query failed: ${e.message}`); return []; });
    let restored = 0;
    for (const w of recent) {
      if (registry.get(w.code)) continue;
      if (registry.create({ code: w.code, name: w.name, ownerId: w.ownerId, public: w.public, snapshot: w.snapshot, members: w.members })) restored++;
    }
    if (restored) log(`restored ${restored} recently-active world(s) from the last ${config.RESTORE_WINDOW_MIN} min`);
  }

  server.listen(config.PORT, config.HOST, () => {
    log(`Gearworks server listening`, { host: config.HOST, port: config.PORT, proto: config.PROTO, env: config.NODE_ENV });
    stats.start();     // begin periodic time-series sampling (no-op if disabled)
  });

  // ---- graceful shutdown (Fly/Railway send SIGTERM; Ctrl-C sends SIGINT) ----
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`${signal} — saving all rooms and shutting down`);
    stats.stop();
    registry.destroyAll('shutdown');     // each room writes a final save
    try { await store.flush(); await store.close(); } catch (e) { log.error(`store close: ${e.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();   // hard cap
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { log.error(`uncaught: ${e.stack || e.message}`); monitor.report('uncaughtException', e); });
  process.on('unhandledRejection', (e) => { log.error(`unhandled rejection: ${e && (e.stack || e.message)}`); monitor.report('unhandledRejection', e); });
}

main();
