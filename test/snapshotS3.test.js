'use strict';
/* Object-storage snapshot backend (Phase 3): a zero-dependency SigV4 PUT/GET/
   DELETE against S3/R2, exercised end-to-end against a mock S3 HTTP server.
   Also asserts the composition guard: an async blob backend needs Postgres. */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSnapshotStore } = require('../server/database/snapshotStore');
const { createStore } = require('../server/database');

const quiet = () => { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; };

// a tiny in-memory S3-compatible server: path-style /<bucket>/<key>
function mockS3() {
  const objects = new Map();
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') { objects.set(req.url, body); res.writeHead(200); return res.end(); }
      if (req.method === 'GET') {
        if (!objects.has(req.url)) { res.writeHead(404); return res.end(); }
        res.writeHead(200); return res.end(objects.get(req.url));
      }
      if (req.method === 'DELETE') { objects.delete(req.url); res.writeHead(204); return res.end(); }
      res.writeHead(405); res.end();
    });
  });
  return { server, objects, seenAuth };
}

test('the s3 snapshot backend round-trips blobs with a SigV4-signed request', async () => {
  const m = mockS3();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const port = m.server.address().port;
  const store = createSnapshotStore({
    log: quiet(), SNAPSHOT_STORE: 's3',
    SNAPSHOT_S3_ENDPOINT: `http://127.0.0.1:${port}`, SNAPSHOT_S3_BUCKET: 'gw',
    SNAPSHOT_S3_REGION: 'auto', SNAPSHOT_S3_ACCESS_KEY: 'AKID', SNAPSHOT_S3_SECRET_KEY: 'SEKRET',
    SNAPSHOT_S3_PREFIX: 'snaps/',
  });
  try {
    assert.strictEqual(store.external, true);
    assert.strictEqual(store.async, true, 'object storage is async');

    const blob = { tick: 42, tiles: [1, 2, 3] };
    const ref = await store.put('ROOM01', blob);
    assert.strictEqual(ref, 'snaps/ROOM01.snap.json', 'ref is the prefixed key, host-independent');
    assert.ok(m.objects.has('/gw/snaps/ROOM01.snap.json'), 'PUT landed at the path-style key');

    // the request was SigV4-signed
    const auth = m.seenAuth[m.seenAuth.length - 1];
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);

    // read it back
    assert.deepStrictEqual(await store.get(ref), blob, 'get returns the stored blob');
    // a missing key resolves to null (not a throw)
    assert.strictEqual(await store.get('snaps/nope.snap.json'), null);
    // delete removes it
    await store.del('ROOM01');
    assert.ok(!m.objects.has('/gw/snaps/ROOM01.snap.json'), 'DELETE removed the object');
    assert.strictEqual(await store.get(ref), null);
  } finally { await new Promise((r) => m.server.close(r)); }
});

test('s3 config is validated, and the file backend rejects an async blob store', () => {
  // missing credentials → a clear error
  assert.throws(() => createSnapshotStore({ log: quiet(), SNAPSHOT_STORE: 's3', SNAPSHOT_S3_ENDPOINT: 'https://x', SNAPSHOT_S3_BUCKET: 'b' }), /requires/);
  // file backend + async (s3) blob store → refused at composition
  assert.throws(() => createStore({
    log: quiet(), STORAGE: 'file', SAVE_DIR: require('os').tmpdir(), BACKUPS: 1,
    SNAPSHOT_STORE: 's3', SNAPSHOT_S3_ENDPOINT: 'https://x', SNAPSHOT_S3_BUCKET: 'b',
    SNAPSHOT_S3_ACCESS_KEY: 'k', SNAPSHOT_S3_SECRET_KEY: 's',
  }), /requires STORAGE=postgres/);
});
