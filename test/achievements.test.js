'use strict';
/* Achievements (Phase 2, slice 5) — derived from cross-world progression.
   - the pure evaluator (thresholds, unlocked/locked, progress),
   - end-to-end: the server's achievements equal evaluate(progression). */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Achievements = require('../shared/achievements');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
const byKey = (list, k) => list.find((x) => x.key === k);

test('the achievement evaluator: thresholds, unlocked/locked, progress', () => {
  const r = Achievements.evaluate({ level: 5, money: 100000, entities: 10, unlockedTech: ['a', 'b'], xp: 9999 });
  assert.strictEqual(r.total, 6);
  assert.strictEqual(byKey(r.list, 'level2').unlocked, true);
  assert.strictEqual(byKey(r.list, 'level5').unlocked, true);
  const l10 = byKey(r.list, 'level10');
  assert.strictEqual(l10.unlocked, false);
  assert.strictEqual(l10.progress, 0.5, 'level 5 of 10 → halfway');
  assert.strictEqual(byKey(r.list, 'worth100k').unlocked, true);
  assert.strictEqual(byKey(r.list, 'build500').progress, 10 / 500);
  assert.strictEqual(byKey(r.list, 'tech10').progress, 2 / 10);
  assert.strictEqual(r.unlocked, r.list.filter((x) => x.unlocked).length);

  const empty = Achievements.evaluate({});
  assert.strictEqual(empty.unlocked, 0, 'nothing unlocked from an empty summary');
  assert.ok(empty.list.every((x) => x.progress === 0 || x.target === 0));
});

test("the server's achievements equal evaluate(progression)", async () => {
  const srv = await startServer({});
  try {
    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'auth', mode: 'register', username: uniq('u_'), password: 'pw12345678' });
    await c.next('auth');
    c.send({ t: 'create', roomName: 'Ach', public: true, seed: 42 });
    await c.next('welcome');
    c.send({ t: 'save' }); await c.next('saved');

    c.send({ t: 'progression' });
    const p = (await c.next('progression')).progression;
    c.send({ t: 'achievements' });
    const a = (await c.next('achievements')).achievements;
    assert.deepStrictEqual(a, Achievements.evaluate(p), 'achievements are a pure function of progression');
    assert.strictEqual(a.total, 6);
    c.close();

    // anonymous connections have no achievements
    const anon = await connect(srv.port); await hello(anon);
    anon.send({ t: 'achievements' });
    assert.strictEqual((await anon.next('achievements')).achievements, null);
    anon.close();
  } finally { await srv.stop(); }
});
