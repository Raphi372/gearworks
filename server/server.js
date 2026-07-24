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
const { createMetrics } = require('./metrics');
const { createDirectory } = require('./world/directory');
const { createPresence } = require('./presence');
const { createInvites } = require('./invites');
const { createModeration } = require('./moderation');

const log = config.log;
const monitor = createMonitoring(config);
const mailer = createMailer(config);
const tokens = createTokens(config);   // shared HMAC signer (sessions + reconnect + recovery)

async function main() {
  const store = createStore(config);
  try { await store.ready(); }
  catch (e) { log.error(`persistence backend not ready: ${e.message}`); process.exit(1); }

  let registry;   // referenced by the metrics gauges thunk (assigned just below)
  const metrics = createMetrics(config, {
    monitor,
    gauges: () => (registry ? { rooms: registry.size(), connections: registry.connections() } : {}),
  });
  const directory = createDirectory(config);   // room router (local no-op | shared)
  const presence = createPresence(config);     // ephemeral online/in-game status
  const invites = createInvites(config);       // pending world invites
  registry = createRegistry(config, store, tokens, metrics, directory, presence);
  const auth = createAuth(config, store, mailer, tokens);
  const moderation = createModeration(config, store);   // account bans (admins via ADMIN_USERS)
  const stats = createStatSampler(config, registry, store);
  const handleConn = createLobby(config, registry, auth, store, tokens, metrics, directory, presence, invites, moderation);

  // control channel: code → { owning instance URL, signed connect token }. The
  // connect token binds the (optional) account to this room; the owning
  // instance verifies it on join with no cross-service call ([SEC-5], [P-6]).
  async function resolveRoom(rawCode, sessionToken) {
    const code = String(rawCode || '').toUpperCase().trim();
    if (!code) return { error: 'code required', status: 400 };
    const route = directory.resolve(code);
    if (!route) return { error: 'room not found', status: 404 };
    const account = sessionToken ? await auth.fromToken(sessionToken).catch(() => null) : null;
    const connectToken = tokens.sign('connect',
      { aid: account ? account.id : null, room: code, region: route.region }, config.CONNECT_TTL_MS);
    return { room: code, region: route.region, url: route.url, self: route.self, connectToken };
  }

  const server = createHttpServer(config, {
    getStats: () => ({ rooms: registry.size(), connections: registry.connections() }),
    onUpgrade: (socket) => handleConn(new WSConn(socket)),
    metrics, resolveRoom,
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

  // keep this instance's directory routes fresh so live rooms stay resolvable
  // and a crashed instance's routes go stale (harmless no-op in 'local' mode).
  const dirTimer = setInterval(() => registry.heartbeatDirectory(), config.DIRECTORY_HEARTBEAT_MS);
  dirTimer.unref();

  // ---- graceful shutdown (Fly/Railway send SIGTERM; Ctrl-C sends SIGINT) ----
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`${signal} — saving all rooms and shutting down`);
    stats.stop();
    metrics.stop();
    clearInterval(dirTimer);
    registry.destroyAll('shutdown');     // each room writes a final save (and deregisters its route via onClose)
    try { await store.flush(); await store.close(); } catch (e) { log.error(`store close: ${e.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();   // hard cap
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { metrics.recordError(); log.error(`uncaught: ${e.stack || e.message}`); monitor.report('uncaughtException', e); });
  process.on('unhandledRejection', (e) => { metrics.recordError(); log.error(`unhandled rejection: ${e && (e.stack || e.message)}`); monitor.report('unhandledRejection', e); });
}

main();
