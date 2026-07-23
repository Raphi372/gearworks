'use strict';
/* Integration: the global leaderboard is built from derived Factory projections
   written at save time (net worth, buildings, tech, owner). File backend; a
   Postgres case runs when TEST_DATABASE_URL is set. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Core = require('../shared/core.js');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }
function findIron(g) {
  for (let r = 2; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let ore = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const t = g.World.tileAt(dx + x, dy + y); if (t.r === 'iron' && t.amt > 0) ore++; }
    if (ore >= 3 && !g.World.tileAt(dx, dy).water) return [dx, dy];
  }
  throw new Error('no iron patch found');
}

function suite(label, envForServer) {
  test(`[${label}] leaderboard reflects derived projections, owner, and ordering`, async () => {
    const srv = await startServer(envForServer);
    try {
      // authed world with a placed building (non-zero entity count + an owner name)
      const user = uniq('Zed_');
      const c1 = await connect(srv.port); await hello(c1);
      c1.send({ t: 'auth', mode: 'register', username: user, password: 'ownerpass1' });
      assert.ok((await c1.next('auth')).ok);
      c1.send({ t: 'create', roomName: 'Owned Works', public: true, seed: 444 });
      const w1 = await c1.next('welcome');
      const g = Core.createGame({ seed: 444 });
      const [x, y] = findIron(g);
      c1.send({ t: 'cmd', q: 1, cmd: { t: 'place', type: 'miner', x, y, rot: 1 } });
      await c1.next((m) => m.t === 'tk' && m.c.some((cc) => cc.t === 'place'), 4000);
      c1.send({ t: 'save' }); await c1.next('saved', 4000);

      // anonymous world, no buildings
      const c2 = await connect(srv.port); await hello(c2);
      c2.send({ t: 'create', roomName: 'Empty Lot', public: true, seed: 555 });
      const w2 = await c2.next('welcome');
      c2.send({ t: 'save' }); await c2.next('saved', 4000);

      // fetch the leaderboard
      const c3 = await connect(srv.port); await hello(c3);
      c3.send({ t: 'leaderboard' });
      const rows = (await c3.next('leaderboard', 4000)).rows;

      const a = rows.find((r) => r.code === w1.code);
      const b = rows.find((r) => r.code === w2.code);
      assert.ok(a && b, 'both worlds appear on the leaderboard');
      assert.strictEqual(a.ownerName, user, 'owner name resolved for the account-owned world');
      assert.strictEqual(b.ownerName, null, 'anonymous world has no owner name');
      assert.ok(a.entities >= 1, 'placed building counted in the projection');
      assert.strictEqual(b.entities, 0, 'empty world has zero buildings');
      for (let i = 0; i + 1 < rows.length; i++) assert.ok(rows[i].money >= rows[i + 1].money, 'rows sorted by net worth desc');
      rows.forEach((r) => { assert.strictEqual(typeof r.money, 'number'); assert.strictEqual(typeof r.tech, 'number'); assert.ok(r.name); });

      c1.close(); c2.close(); c3.close();
    } finally { await srv.stop(); }
  });
}

suite('file', {});
if (process.env.TEST_DATABASE_URL) {
  suite('postgres', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL });
} else {
  test('postgres leaderboard (skipped — set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
}

async function player(port, name, seed) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
  const id = (await c.next('auth')).account.id;
  c.send({ t: 'create', roomName: name + ' base', public: true, seed });
  await c.next('welcome');
  c.send({ t: 'save' }); await c.next('saved', 4000);
  return { c, id, name };
}

test('the friends leaderboard shows only you + your friends', async () => {
  const srv = await startServer({});
  try {
    const a = await player(srv.port, uniq('a'), 10);
    const b = await player(srv.port, uniq('b'), 11);
    const cc = await player(srv.port, uniq('c'), 12);   // NOT a friend of a
    // a and b are friends (mutual request auto-accepts)
    a.c.send({ t: 'friendReq', username: b.name }); await a.c.next('friends');
    b.c.send({ t: 'friendReq', username: a.name }); await b.c.next('friends');

    // global board includes everyone (incl. the non-friend c)
    a.c.send({ t: 'leaderboard', scope: 'global' });
    const g = await a.c.next('leaderboard');
    assert.strictEqual(g.scope, 'global');
    assert.ok(new Set(g.rows.map((r) => r.ownerId)).has(cc.id), 'global includes the non-friend');

    // friends board is restricted to a + b (never c)
    a.c.send({ t: 'leaderboard', scope: 'friends' });
    const f = await a.c.next('leaderboard');
    assert.strictEqual(f.scope, 'friends');
    const fOwners = new Set(f.rows.map((r) => r.ownerId));
    assert.ok(fOwners.has(a.id) && fOwners.has(b.id), 'includes me and my friend');
    assert.ok(!fOwners.has(cc.id), 'excludes the non-friend');
    assert.ok(f.rows.every((r) => r.ownerId === a.id || r.ownerId === b.id), 'only friends + self');

    // signed-out + friends scope just returns the global board
    const anon = await connect(srv.port); await hello(anon);
    anon.send({ t: 'leaderboard', scope: 'friends' });
    assert.strictEqual((await anon.next('leaderboard')).scope, 'global', 'no account → global');
    a.c.close(); b.c.close(); cc.c.close(); anon.close();
  } finally { await srv.stop(); }
});
