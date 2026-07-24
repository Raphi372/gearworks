'use strict';
/* ==========================================================================
   database/index.js — persistence abstraction.

   The rest of the server talks to ONE store interface and never knows which
   backend is behind it. Default is the zero-dependency file backend; set
   STORAGE=postgres (+ DATABASE_URL) for the production relational backend.

   Store interface:
     ready()                -> Promise         connectivity check at boot
     saveRoom(code, data)   -> bool            persist a room snapshot (sync-safe)
     loadRoom(code)         -> Promise<data?>  read a room snapshot
     loadFile(absPath)      -> Promise<data?>  read a file save (file backend)
     listRoomCodes()        -> Promise<string[]>
     recentRooms(sinceMs)   -> Promise<world[]> worlds saved since (boot restore)
     topFactories(limit)    -> Promise<row[]>  leaderboard from derived projections
     flush()                -> Promise         drain any queued writes
     close()                -> Promise         graceful shutdown
   ========================================================================== */
const { createFileStore } = require('./fileStore');
const { createPostgresStore } = require('./postgresStore');
const { createSnapshotStore } = require('./snapshotStore');

function createStore(config) {
  // where snapshot BLOBS live (inline by default). Injected into either backend
  // so metadata and the (large) snapshot can be stored independently.
  const snapshots = createSnapshotStore(config);
  if (config.STORAGE === 'postgres') {
    config.log('persistence: PostgreSQL backend');
    return createPostgresStore(config, snapshots);
  }
  // the file backend's save path is synchronous (SIGTERM flush); an async blob
  // backend (s3) can't be awaited there, so it pairs with STORAGE=postgres.
  if (snapshots.async) throw new Error(`SNAPSHOT_STORE=${snapshots.mode} requires STORAGE=postgres`);
  config.log(`persistence: file backend (${config.SAVE_DIR})`);
  return createFileStore(config, snapshots);
}

module.exports = { createStore };
