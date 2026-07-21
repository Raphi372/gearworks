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
     players/sessions.js    reconnect session tokens
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
const { createMonitoring } = require('./monitoring');
const { createMailer } = require('./mailer');

const log = config.log;
const monitor = createMonitoring(config);
const mailer = createMailer(config);

async function main() {
  const store = createStore(config);
  try { await store.ready(); }
  catch (e) { log.error(`persistence backend not ready: ${e.message}`); process.exit(1); }

  const registry = createRegistry(config, store);
  const auth = createAuth(config, store, mailer);
  const handleConn = createLobby(config, registry, auth, store);

  const server = createHttpServer(config, {
    getStats: () => ({ rooms: registry.size(), sessions: require('./players/sessions').size }),
    onUpgrade: (socket) => handleConn(new WSConn(socket)),
  });

  // resume a saved world from a file (file backend)
  if (config.LOAD_FILE) {
    const data = await store.loadFile(config.LOAD_FILE);
    if (!data) { log.error(`failed to load ${config.LOAD_FILE}`); process.exit(1); }
    const r = registry.create({ name: data.meta.name, public: true, snapshot: data.snapshot, code: data.meta.code });
    log(`resumed save into room ${r.code} ("${r.name}") @tick ${r.game.S.tick}`);
  }

  server.listen(config.PORT, config.HOST, () => {
    log(`Gearworks server listening`, { host: config.HOST, port: config.PORT, proto: config.PROTO, env: config.NODE_ENV });
  });

  // ---- graceful shutdown (Fly/Railway send SIGTERM; Ctrl-C sends SIGINT) ----
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`${signal} — saving all rooms and shutting down`);
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
