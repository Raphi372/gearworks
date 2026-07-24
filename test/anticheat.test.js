'use strict';
/* Anti-cheat anomaly scoring (Phase 3). Unit: weighted signals accumulate per
   authed subject, cross a threshold to record a flag, decay over time, and are
   rate-limited by a cooldown. Integration: a client that spams commands past the
   rate limit in a live room gets flagged, and an admin sees it in the queue. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAntiCheat } = require('../server/anticheat');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStore() {
  const flags = [];
  return { flags, recordFlag: (f) => { flags.push(f); return Promise.resolve({ ok: true }); } };
}

test('the scorer flags an authed subject once its weighted score crosses the threshold', async () => {
  const store = fakeStore();
  // threshold 25 (< two rate signals = 20, ≤ three = 30) so the crossing has
  // margin: the scorer decays before each add, so a threshold set exactly to the
  // summed weight would land fractionally under it and flap under CI timing.
  const ac = createAntiCheat({ ANTICHEAT_FLAG_SCORE: 25, ANTICHEAT_DECAY_MS: 15000, ANTICHEAT_COOLDOWN_MS: 60000 }, store);
  const c = { aid: 'acc1', name: 'Suspect' };
  ac.signal('rate', c, 'ROOM01');   // +10 → ~10
  ac.signal('rate', c, 'ROOM01');   // +10 → ~20  (< 25)
  assert.strictEqual(store.flags.length, 0, 'below threshold: no flag');
  ac.signal('rate', c, 'ROOM01');   // +10 → ~30  (≥ 25)
  await sleep(5);
  assert.strictEqual(store.flags.length, 1, 'crossing the threshold records a flag');
  assert.strictEqual(store.flags[0].accountId, 'acc1');
  assert.ok(store.flags[0].score >= 25);

  // within the cooldown, more signals do not re-flag
  for (let i = 0; i < 10; i++) ac.signal('rate', c, 'ROOM01');
  await sleep(5);
  assert.strictEqual(store.flags.length, 1, 'cooldown suppresses repeat flags');
});

test('anonymous clients are not scored, and a zero threshold disables scoring', async () => {
  const store = fakeStore();
  const ac = createAntiCheat({ ANTICHEAT_FLAG_SCORE: 10, ANTICHEAT_DECAY_MS: 15000, ANTICHEAT_COOLDOWN_MS: 0 }, store);
  for (let i = 0; i < 20; i++) ac.signal('perm', { aid: null, name: 'Anon' }, 'R');
  await sleep(5);
  assert.strictEqual(store.flags.length, 0, 'no account → not scored');

  const off = createAntiCheat({ ANTICHEAT_FLAG_SCORE: 0 }, fakeStore());
  assert.strictEqual(off.enabled, false, 'threshold 0 disables the scorer');
});

test('scores decay over time so transient blips fade', async () => {
  const store = fakeStore();
  const ac = createAntiCheat({ ANTICHEAT_FLAG_SCORE: 100, ANTICHEAT_DECAY_MS: 40, ANTICHEAT_COOLDOWN_MS: 0 }, store);
  const c = { aid: 'acc2', name: 'Blip' };
  ac.signal('rate', c, 'R');            // +10 → score ~10
  await sleep(60);                      // > one decay window
  ac.signal('rate', c, 'R');            // decays to ~0 first, then +10
  const s = ac._subjects.get('a:acc2');
  assert.ok(s.score < 15, 'the earlier points decayed rather than accumulating');
  assert.strictEqual(store.flags.length, 0);
});

test('a command-spamming client is flagged in a live room and an admin sees it', async () => {
  const admin = uniq('admin');
  const srv = await startServer({ ADMIN_USERS: admin, CMD_RATE_LIMIT: '2', ANTICHEAT_FLAG_SCORE: '20' });
  try {
    // admin account (to read the flag queue)
    const a = await connect(srv.port); a.send({ t: 'hello', proto: 1, name: 'A', gz: false }); await a.next('lobby');
    a.send({ t: 'auth', mode: 'register', username: admin, password: 'pw12345678' }); await a.next('auth');

    // a normal player hosts a room, then bursts commands past the rate limit
    const p = await connect(srv.port); p.send({ t: 'hello', proto: 1, name: 'P', gz: false }); await p.next('lobby');
    p.send({ t: 'auth', mode: 'register', username: uniq('spam'), password: 'pw12345678' });
    const pname = (await p.next('auth')).account.username;
    p.send({ t: 'create', roomName: 'Spam', public: true, seed: 3 }); await p.next('welcome');
    for (let i = 0; i < 15; i++) p.send({ t: 'cmd', q: i, cmd: { t: 'noop' } });   // most get rate-limited → 'rate' signals
    await sleep(300);   // let the fire-and-forget flag write land

    a.send({ t: 'mod' });
    const mod = await a.next('mod');
    assert.ok(Array.isArray(mod.flags), 'the mod payload carries the flags queue');
    const flag = mod.flags.find((f) => f.name === pname);
    assert.ok(flag, 'the spamming player was flagged');
    assert.ok(flag.score >= 20, 'the flag records the score reached');
    // the flag captured the recent-input replay window ([SEC-3])
    assert.ok(Array.isArray(flag.replay) && flag.replay.length, 'the flag carries a replay window');
    assert.ok(flag.replay.every((r) => r.t === 'noop' && typeof r.tick === 'number'), 'replay entries are input type + tick');

    // an admin can dismiss the flag
    a.send({ t: 'flagClear', id: flag.id });
    const after = await a.next('mod');
    assert.ok(!after.flags.some((f) => f.name === pname), 'dismiss clears the flag');

    a.close(); p.close();
  } finally { await srv.stop(); }
});
