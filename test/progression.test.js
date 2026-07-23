'use strict';
/* Progression (P1.1 — cross-world XP / levels).
   - the pure XP/level math (curve + aggregate + tech union),
   - end-to-end: an account's level/xp is the aggregate of its worlds'
     derived projections, and only signed-in players get a progression. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Progression = require('../shared/progression.js');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }

test('the XP/level curve and cross-world aggregate are correct', () => {
  // triangular curve: L1@0, L2@1k, L3@3k, L4@6k, L5@10k
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(Progression.xpForLevel), [0, 1000, 3000, 6000, 10000]);
  assert.strictEqual(Progression.levelForXp(0), 1);
  assert.strictEqual(Progression.levelForXp(999), 1);
  assert.strictEqual(Progression.levelForXp(1000), 2);
  assert.strictEqual(Progression.levelForXp(2999), 2);
  assert.strictEqual(Progression.levelForXp(3000), 3);

  // per-world XP = money + entities*5 + tech*250
  assert.strictEqual(Progression.worldXp({ money: 800, entities: 10, tech: 2 }), 800 + 50 + 500);

  const s = Progression.summarize([
    { projection: { money: 800, entities: 10, tech: 2, techIds: ['automation', 'smelting'] } }, // 1350
    { projection: { money: 400, entities: 0, tech: 1, techIds: ['automation', 'electronics'] } }, // 650
  ]);
  assert.strictEqual(s.xp, 2000);
  assert.strictEqual(s.level, 2);                              // 2000 -> level 2
  assert.deepStrictEqual(s.unlockedTech, ['automation', 'electronics', 'smelting']); // sorted union, deduped
  assert.strictEqual(s.xpThisLevel, 1000);
  assert.strictEqual(s.xpNextLevel, 3000);

  // negative / missing inputs never throw or go below floor
  const z = Progression.summarize([]);
  assert.strictEqual(z.xp, 0);
  assert.strictEqual(z.level, 1);
  assert.deepStrictEqual(z.unlockedTech, []);
});

test("an account's progression is the aggregate of its worlds' projections", async () => {
  const srv = await startServer({});
  try {
    // sign in and capture the account id + token
    const c1 = await connect(srv.port); await hello(c1);
    const name = uniq('u_');
    c1.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
    const auth = await c1.next('auth');
    const accountId = auth.account.id, token = auth.token;

    // world A (this connection), saved so its projection lands on disk
    c1.send({ t: 'create', roomName: 'Alpha', public: true, seed: 40 });
    const a = await c1.next('welcome');
    c1.send({ t: 'save' }); await c1.next('saved');

    // world B (second connection, same account via the auth token)
    const c2 = await connect(srv.port); await hello(c2, { authToken: token });
    c2.send({ t: 'create', roomName: 'Beta', public: true, seed: 41 });
    const b = await c2.next('welcome');
    c2.send({ t: 'save' }); await c2.next('saved');

    // the leaderboard exposes each world's derived projection — compute the
    // expected aggregate from the two worlds this account owns
    c1.send({ t: 'leaderboard' });
    const rows = (await c1.next('leaderboard')).rows.filter((r) => r.ownerId === accountId);
    assert.strictEqual(rows.length, 2, 'both owned worlds are on the leaderboard');
    const expected = Progression.summarize(rows.map((r) => ({ projection: { money: r.money, entities: r.entities, tech: r.tech } })));

    c1.send({ t: 'progression' });
    const p = (await c1.next('progression')).progression;
    assert.ok(p, 'signed-in players get a progression');
    assert.strictEqual(p.xp, expected.xp, 'xp is the sum of both worlds');
    assert.strictEqual(p.level, expected.level, 'level derives from that xp');
    assert.ok(p.xp > 0, 'two starting worlds carry some xp');
    assert.ok(Array.isArray(p.unlockedTech), 'unlockedTech is a list');

    c1.close(); c2.close();
  } finally { await srv.stop(); }
});

test('anonymous connections have no progression', async () => {
  const srv = await startServer({});
  try {
    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'progression' });
    assert.strictEqual((await c.next('progression')).progression, null);
    c.close();
  } finally { await srv.stop(); }
});
