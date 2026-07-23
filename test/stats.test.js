'use strict';
/* Stats (P1.1 — time-series counters).
   - the file store's recordStats appends bounded per-metric rings,
   - the periodic sampler records one point-set per active account,
   - end-to-end: a signed-in player's `stats` request seeds and returns a
     series that matches their current progression; anon gets none. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFileStore } = require('../server/database/fileStore');
const { createStatSampler } = require('../server/stats');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quietLog() { const l = () => {}; l.error = () => {}; return l; }
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }

test('recordStats keeps a bounded ring of the newest points per metric', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-stat-'));
  try {
    const store = createFileStore({ SAVE_DIR: dir, BACKUPS: 3, STAT_KEEP: 2, log: quietLog() });
    await store.recordStats('acc1', { net_worth: 100, xp: 10 }, 1000);
    await store.recordStats('acc1', { net_worth: 200, xp: 20 }, 2000);
    await store.recordStats('acc1', { net_worth: 300, xp: 30 }, 3000);
    const s = await store.statsFor('acc1');
    assert.strictEqual(s.net_worth.length, 2, 'trimmed to STAT_KEEP');
    assert.deepStrictEqual(s.net_worth.map((p) => p.v), [200, 300], 'oldest dropped, order preserved');
    assert.deepStrictEqual(s.xp.map((p) => p.v), [20, 30]);
    // a different account is isolated and absent
    assert.deepStrictEqual(await store.statsFor('nobody'), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sampler records one point-set per active account', async () => {
  const recorded = [];
  const fakeStore = {
    recordStats: (aid, samples) => { recorded.push({ aid, samples }); return Promise.resolve(); },
    progression: (aid) => Promise.resolve({ money: 500, entities: 4, unlockedTech: ['automation'], xp: 500, level: 1 }),
  };
  // two live rooms sharing one member + one unique member -> two distinct accounts
  const fakeRegistry = { all: () => [
    { members: new Map([['acc1', {}], ['acc2', {}]]) },
    { members: new Map([['acc2', {}]]) },
    { members: new Map() },
  ] };
  const sampler = createStatSampler({ STAT_SAMPLE_MIN: 60, log: quietLog() }, fakeRegistry, fakeStore);
  const n = await sampler.sampleOnce();
  assert.strictEqual(n, 2, 'deduped to two active accounts');
  const ids = recorded.map((r) => r.aid).sort();
  assert.deepStrictEqual(ids, ['acc1', 'acc2']);
  assert.deepStrictEqual(recorded[0].samples, { net_worth: 500, entities: 4, tech: 1, xp: 500, level: 1 });
});

test('a signed-in player gets a stats series matching their progression; anon gets none', async () => {
  const srv = await startServer({});
  try {
    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'auth', mode: 'register', username: uniq('u_'), password: 'pw12345678' });
    await c.next('auth');
    c.send({ t: 'create', roomName: 'Metrics', public: true, seed: 50 });
    await c.next('welcome');
    c.send({ t: 'save' }); await c.next('saved');

    c.send({ t: 'progression' });
    const p = (await c.next('progression')).progression;

    // first stats view seeds a point from the current progression
    c.send({ t: 'stats' });
    const series = (await c.next('stats')).series;
    assert.ok(series && series.net_worth && series.net_worth.length >= 1, 'seeded a net-worth point');
    assert.strictEqual(series.net_worth[series.net_worth.length - 1].v, p.money, 'net worth matches progression');
    assert.strictEqual(series.xp[series.xp.length - 1].v, p.xp, 'xp matches progression');
    assert.ok(series.level && series.entities && series.tech, 'all metrics recorded');
    c.close();

    const anon = await connect(srv.port); await hello(anon);
    anon.send({ t: 'stats' });
    assert.strictEqual((await anon.next('stats')).series, null, 'anonymous has no stats');
    anon.close();
  } finally { await srv.stop(); }
});
