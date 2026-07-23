'use strict';
/* ==========================================================================
   database/snapshotStore.js — where a room's authoritative snapshot BLOB lives.

   Separating the (large, hot) snapshot from its (small) metadata is what lets
   metadata sit in a shared database while snapshots live in shared blob storage,
   so ANY instance can load ANY room on placement — the last piece of a true
   multi-instance data plane (docs/FUTURE_ARCHITECTURE.md §2.3/§3.4).

   `World.snapshot` stays the authoritative record ([DB-6]); it may simply live
   outside the metadata row, addressed by a small `snapshotRef`.

   Backends behind one contract ({ external, put, get, del }):
     • 'inline' (default) — the snapshot stays embedded in the room save, exactly
       as today (external=false). The $0 single box never leaves this mode.
     • 'fs'               — the snapshot is written to a separate directory
       (optionally a shared/network mount) as <code>.snap.json; the room save
       keeps only a `snapshotRef` pointer. This proves the externalized-blob
       split with zero cloud infra and is genuinely useful on a shared volume.

   The object-storage ('s3' / Cloudflare R2) backend slots in here next behind
   the SAME contract — a zero-dependency SigV4 PUT/GET, like server/mailer.js's
   HTTP approach — with no change to callers ([A-7], [DB-3]).
   ========================================================================== */
const fs = require('fs');
const path = require('path');

function createSnapshotStore(config) {
  const mode = config.SNAPSHOT_STORE === 'fs' ? 'fs' : 'inline';
  if (mode === 'inline') {
    return { mode, external: false, put() { return null; }, get() { return null; }, del() {} };
  }
  const dir = config.SNAPSHOT_DIR || path.join(config.SAVE_DIR || 'saves', 'snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* created lazily */ }
  const key = (code) => `${code}.snap.json`;
  const at = (ref) => path.join(dir, path.basename(String(ref)));
  config.log(`snapshots: fs backend (${dir})`);
  return {
    mode, external: true,
    // write the blob; return the ref stored alongside the room's metadata.
    put(code, snapshot) { fs.writeFileSync(at(key(code)), JSON.stringify(snapshot)); return key(code); },
    get(ref) { try { return JSON.parse(fs.readFileSync(at(ref), 'utf8')); } catch (e) { return null; } },
    del(code) { try { fs.unlinkSync(at(key(code))); } catch (e) { /* already gone */ } },
  };
}

module.exports = { createSnapshotStore };
