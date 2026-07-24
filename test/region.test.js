'use strict';
/* Regional server picker (Phase 3): the lobby reports its home region, the
   aggregated listing tags every room with its region, and region-scoped
   quickplay routes to a room in the requested region across instances. Two
   real server processes in different regions share a directory + AUTH_SECRET. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'Reg', gz: false }); return c.next('lobby'); }

test('the lobby reports its region and quickplay is region-scoped across instances', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-region-'));
  const common = { AUTH_SECRET: 'region-shared-secret', DIRECTORY: 'file', DIRECTORY_DIR: shared };
  const A = await startServer(Object.assign({}, common, { REGION: 'eu', PUBLIC_URL: 'ws://inst-eu' }));
  const B = await startServer(Object.assign({}, common, { REGION: 'us', PUBLIC_URL: 'ws://inst-us' }));
  try {
    // A (eu) hosts a public room; B (us) hosts a public room
    const hostA = await connect(A.port); await hello(hostA);
    hostA.send({ t: 'create', roomName: 'EU World', public: true, seed: 91 });
    const codeEu = (await hostA.next('welcome')).code;
    const hostB = await connect(B.port); await hello(hostB);
    hostB.send({ t: 'create', roomName: 'US World', public: true, seed: 92 });
    const codeUs = (await hostB.next('welcome')).code;

    // a client on A: the lobby reports A's home region, and the aggregated
    // listing carries both rooms with correct region tags
    const c = await connect(A.port);
    const lob = await hello(c);
    assert.strictEqual(lob.region, 'eu', 'lobby reports the home region');
    const rowEu = (lob.rooms || []).find((r) => r.code === codeEu);
    const rowUs = (lob.rooms || []).find((r) => r.code === codeUs);
    assert.ok(rowEu && rowUs, 'both rooms are listed on A');
    assert.strictEqual(rowEu.region, 'eu');
    assert.strictEqual(rowUs.region, 'us', 'the remote room keeps its own region');

    // region-scoped quickplay routes to the room in the requested region
    c.send({ t: 'quickplay', region: 'us' });
    assert.strictEqual((await c.next('quickplay')).code, codeUs, 'quickplay us → the US room');
    c.send({ t: 'quickplay', region: 'eu' });
    assert.strictEqual((await c.next('quickplay')).code, codeEu, 'quickplay eu → the EU room');
    // a region with no rooms → the client is told to host one
    c.send({ t: 'quickplay', region: 'ap' });
    assert.strictEqual((await c.next('quickplay')).create, true, 'empty region → create');
    // no region → falls back to home-first (the EU room, hosted locally)
    c.send({ t: 'quickplay' });
    assert.strictEqual((await c.next('quickplay')).code, codeEu, 'unscoped → home region preferred');

    hostA.close(); hostB.close(); c.close();
  } finally { await A.stop(); await B.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});
