'use strict';
/* Durable achievement-unlock notifications (Phase 2 increment). Ownership stays
   a DERIVED projection of progression ([DB-6]); a small ledger only records which
   unlocks have been ANNOUNCED, so the server can surface the newly-crossed ones
   exactly once. */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFileStore } = require('../server/database/fileStore');
const Achievements = require('../shared/achievements.js');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ach-'));
  return { store: createFileStore({ SAVE_DIR: dir, BACKUPS: 1, log: { error() {} } }), dir };
}

test('the ledger returns only newly-recorded keys, per account', async () => {
  const { store, dir } = tmpStore();
  try {
    assert.deepStrictEqual(await store.markAchievements('a', ['x', 'y']), ['x', 'y'], 'all new the first time');
    assert.deepStrictEqual(await store.markAchievements('a', ['x', 'y', 'z']), ['z'], 'only the unseen one');
    assert.deepStrictEqual(await store.markAchievements('a', ['x']), [], 'nothing new');
    assert.deepStrictEqual(await store.markAchievements('b', ['x']), ['x'], 'ledger is per-account');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a real unlock (from evaluate) is announced once, then a newly-crossed one', async () => {
  const { store, dir } = tmpStore();
  try {
    // a mid-progression summary unlocks the early achievements
    const mid = { level: 5, money: 5000, entities: 50, unlockedTech: new Array(3) };
    const midKeys = Achievements.evaluate(mid).list.filter((a) => a.unlocked).map((a) => a.key);
    assert.ok(midKeys.length, 'sanity: the summary unlocks something');
    assert.deepStrictEqual((await store.markAchievements('acc', midKeys)).sort(), midKeys.slice().sort(), 'first view announces them');
    assert.deepStrictEqual(await store.markAchievements('acc', midKeys), [], 'a second view announces nothing');

    // crossing a new threshold announces exactly the newly-unlocked one(s)
    const rich = { level: 10, money: 120000, entities: 600, unlockedTech: new Array(12) };
    const richKeys = Achievements.evaluate(rich).list.filter((a) => a.unlocked).map((a) => a.key);
    const fresh = await store.markAchievements('acc', richKeys);
    assert.ok(fresh.length && fresh.every((k) => !midKeys.includes(k)), 'only the newly-crossed unlocks are announced');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the achievements reply carries a fresh[] and does not re-announce', async () => {
  const srv = await startServer({});
  try {
    const c = await connect(srv.port);
    c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); await c.next('lobby');
    c.send({ t: 'auth', mode: 'register', username: uniq('ach'), password: 'pw12345678' }); await c.next('auth');
    c.send({ t: 'achievements' });
    const r1 = await c.next('achievements');
    assert.ok(r1.achievements && Array.isArray(r1.achievements.list));
    assert.ok(Array.isArray(r1.fresh), 'reply carries a fresh[] list');
    // a fresh account at level 1 has unlocked nothing, so nothing is announced
    assert.strictEqual(r1.fresh.length, 0);
    c.send({ t: 'achievements' });
    assert.deepStrictEqual((await c.next('achievements')).fresh, [], 'still nothing on a repeat view');
    c.close();
  } finally { await srv.stop(); }
});
