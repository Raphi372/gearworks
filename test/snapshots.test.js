'use strict';
/* Externalized snapshots (Phase 1, slice 3 — docs/FUTURE_ARCHITECTURE.md §3.4).
   - the snapshot store 'inline' (default) and 'fs' backends,
   - the file backend externalizes the blob (room save holds only a snapshotRef)
     and a SECOND store over the same dirs hydrates it — the cross-instance load,
   - a real server with SNAPSHOT_STORE=fs round-trips a world (resume hydrates). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSnapshotStore } = require('../server/database/snapshotStore');
const { createFileStore } = require('../server/database/fileStore');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quiet() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }

test('the snapshot store: inline is a no-op, fs round-trips a blob', () => {
  const inline = createSnapshotStore({ SNAPSHOT_STORE: 'inline', log: quiet() });
  assert.strictEqual(inline.external, false);
  assert.strictEqual(inline.put('X', { a: 1 }), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-snap-'));
  try {
    const s = createSnapshotStore({ SNAPSHOT_STORE: 'fs', SNAPSHOT_DIR: dir, log: quiet() });
    assert.strictEqual(s.external, true);
    const ref = s.put('ABC123', { tick: 9, blob: [1, 2, 3] });
    assert.ok(ref, 'put returns a ref');
    assert.deepStrictEqual(s.get(ref), { tick: 9, blob: [1, 2, 3] });
    s.del('ABC123');
    assert.strictEqual(s.get(ref), null, 'deleted blob is gone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file backend externalizes the snapshot; another instance hydrates it', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-snapS-'));
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-snapB-'));
  const cfg = { SAVE_DIR: saveDir, BACKUPS: 3, log: quiet(), SNAPSHOT_STORE: 'fs', SNAPSHOT_DIR: snapDir };
  try {
    const A = createFileStore(cfg, createSnapshotStore(cfg));
    const data = { meta: { name: 'W', code: 'CODE01', saved: Date.now(), ownerId: 'o1', public: true,
      projection: { money: 5, entities: 2, tech: 1 }, members: [] }, snapshot: { tick: 123, blob: [4, 5, 6] } };
    A.saveRoom('CODE01', data);

    // the room save on disk holds only a ref — the big blob is NOT inline
    const raw = JSON.parse(fs.readFileSync(path.join(saveDir, 'CODE01.json'), 'utf8'));
    assert.strictEqual(raw.snapshot, null, 'no inline snapshot in the room save');
    assert.ok(raw.meta.snapshotRef, 'a snapshotRef points at the blob');

    // meta-only reads never touch the blob but still work (leaderboard/listing)
    const lb = await A.topFactories(10);
    assert.ok(lb.some((r) => r.code === 'CODE01' && r.money === 5));

    // a SECOND store over the SAME dirs (a different instance) hydrates the blob
    const B = createFileStore(cfg, createSnapshotStore(cfg));
    const loaded = await B.loadRoom('CODE01');
    assert.deepStrictEqual(loaded.snapshot, { tick: 123, blob: [4, 5, 6] }, 'hydrated from the shared snapshot store');
    assert.strictEqual(loaded.meta.name, 'W');
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); fs.rmSync(snapDir, { recursive: true, force: true }); }
});

test('a real server with SNAPSHOT_STORE=fs round-trips a resumed world', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-snapR-'));
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-snapRb-'));
  const srv = await startServer({ SAVE_DIR: saveDir, SNAPSHOT_STORE: 'fs', SNAPSHOT_DIR: snapDir, RESTORE_ON_BOOT: '0' });
  try {
    // create an anonymous (ownerless) world so anyone can resume it, save it, then
    // let it idle-evict (final save → snapshot written to the external store)
    const c1 = await connect(srv.port); await hello(c1);
    c1.send({ t: 'create', roomName: 'Blob World', public: false, seed: 80 });
    const code = (await c1.next('welcome')).code;
    c1.send({ t: 'save' }); await c1.next('saved');
    c1.close();
    await sleep(900);   // EMPTY_ROOM_TTL_MS=500 → evicts + final-saves

    // the on-disk room save holds only a ref; the blob is in the snapshot dir
    const raw = JSON.parse(fs.readFileSync(path.join(saveDir, `${code}.json`), 'utf8'));
    assert.strictEqual(raw.snapshot, null, 'snapshot externalized');
    assert.ok(raw.meta.snapshotRef);
    assert.ok(fs.existsSync(path.join(snapDir, `${code}.snap.json`)), 'blob written to the snapshot store');

    // resuming reloads it — the snapshot MUST be hydrated from the external store
    const c2 = await connect(srv.port); await hello(c2);
    c2.send({ t: 'resume', code });
    const w = await c2.next('welcome', 4000);
    assert.strictEqual(w.code, code, 'resumed the externalized world');
    assert.ok(w.tick >= 0, 'world state loaded (snapshot hydrated)');
    c2.close();
  } finally { await srv.stop(); fs.rmSync(saveDir, { recursive: true, force: true }); fs.rmSync(snapDir, { recursive: true, force: true }); }
});
