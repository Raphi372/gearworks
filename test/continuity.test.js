'use strict';
/* Integration: restart/deploy continuity — a recently-active world is restored
   as a LIVE room when the server restarts on the same save directory. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../shared/core.js');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }
function findIron(g) {
  for (let r = 2; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let ore = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const t = g.World.tileAt(dx + x, dy + y); if (t.r === 'iron' && t.amt > 0) ore++; }
    if (ore >= 3 && !g.World.tileAt(dx, dy).water) return [dx, dy];
  }
  throw new Error('no iron patch found');
}

// create a public world with a placed building, then stop the server (SIGTERM
// saves every room). Returns the shared saveDir + the world code.
async function makeWorld(saveDir) {
  const s = await startServer({ SAVE_DIR: saveDir });
  const c = await connect(s.port); await hello(c);
  c.send({ t: 'create', roomName: 'Persistent Town', public: true, seed: 4242 });
  const w = await c.next('welcome');
  const g = Core.createGame({ seed: 4242 });
  const [x, y] = findIron(g);
  c.send({ t: 'cmd', q: 1, cmd: { t: 'place', type: 'miner', x, y, rot: 1 } });
  await c.next((m) => m.t === 'tk' && m.c.some((cc) => cc.t === 'place'), 4000);
  c.send({ t: 'save' }); await c.next('saved', 4000);
  c.close();
  await s.stop();                     // graceful: final-saves all rooms
  return w.code;
}

test('a recently-active world is restored live after a restart', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cont-'));
  try {
    const code = await makeWorld(saveDir);

    // fresh server, same data — the world should be live again on boot
    const s2 = await startServer({ SAVE_DIR: saveDir, EMPTY_ROOM_TTL_MS: '5000' });
    const c2 = await connect(s2.port);
    const lobby = await hello(c2);
    assert.ok(lobby.rooms.some((r) => r.code === code), 'restored world appears in the public browser');
    c2.send({ t: 'join', code });                       // joinable == it is a LIVE room, not just on disk
    const w2 = await c2.next('welcome', 4000);
    assert.strictEqual(w2.code, code, 'joined the restored live room');
    c2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});

test('RESTORE_ON_BOOT=0 disables restore (world stays on disk only)', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cont-'));
  try {
    const code = await makeWorld(saveDir);

    const s2 = await startServer({ SAVE_DIR: saveDir, RESTORE_ON_BOOT: '0' });
    const c2 = await connect(s2.port);
    const lobby = await hello(c2);
    assert.ok(!lobby.rooms.some((r) => r.code === code), 'not restored to the public browser');
    c2.send({ t: 'join', code });
    assert.match((await c2.next('err', 4000)).reason, /not found/i, 'not a live room');
    c2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});
