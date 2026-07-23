'use strict';
/* Presence — online / in-game status with friend fan-out (Phase 2, slice 2).
   - the presence module (local + shared file, TTL → offline),
   - end-to-end: a friend sees you go online → in-game → offline. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPresence } = require('../server/presence');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quiet() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
const cfg = (extra) => Object.assign({ REGION: 'local', log: quiet(), SAVE_DIR: os.tmpdir(), PRESENCE: 'local', PRESENCE_TTL_MS: 60000 }, extra);

test('presence: set / get / clear, TTL expiry, and shared file backend', async () => {
  const p = createPresence(cfg({}));
  assert.strictEqual(p.get('a1').online, false, 'unknown → offline');
  p.set('a1', { status: 'online' });
  assert.deepStrictEqual({ online: p.get('a1').online, status: p.get('a1').status }, { online: true, status: 'online' });
  p.set('a1', { status: 'ingame', roomCode: 'ABC123' });
  assert.strictEqual(p.get('a1').status, 'ingame');
  assert.strictEqual(p.get('a1').roomCode, 'ABC123');
  p.clear('a1');
  assert.strictEqual(p.get('a1').online, false, 'cleared → offline');

  // TTL: a presence not refreshed goes stale
  const s = createPresence(cfg({ PRESENCE_TTL_MS: 1 }));
  s.set('x', { status: 'online' });
  await sleep(15);
  assert.strictEqual(s.get('x').online, false, 'stale → offline');

  // shared file backend: another instance sees it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-pres-'));
  try {
    const a = createPresence(cfg({ PRESENCE: 'file', PRESENCE_DIR: dir, REGION: 'eu' }));
    a.set('u1', { status: 'ingame', roomCode: 'ZZ' });
    const b = createPresence(cfg({ PRESENCE: 'file', PRESENCE_DIR: dir }));
    const got = b.get('u1');
    assert.strictEqual(got.online, true);
    assert.strictEqual(got.status, 'ingame');
    assert.strictEqual(got.region, 'eu');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a friend sees you go online → in-game → offline', async () => {
  const srv = await startServer({});
  try {
    const aliceName = uniq('alice'), bobName = uniq('bob');
    const ca = await connect(srv.port); await hello(ca);
    ca.send({ t: 'auth', mode: 'register', username: aliceName, password: 'pw12345678' });
    const aliceId = (await ca.next('auth')).account.id;
    const cb = await connect(srv.port); await hello(cb);
    cb.send({ t: 'auth', mode: 'register', username: bobName, password: 'pw12345678' });
    await cb.next('auth');

    // become friends (mutual requests auto-accept)
    ca.send({ t: 'friendReq', username: bobName }); await ca.next('friends');
    cb.send({ t: 'friendReq', username: aliceName }); await cb.next('friends');

    // alice is in the lobby → bob sees her online
    ca.send({ t: 'friends' }); await ca.next('friends');   // keeps alice's presence fresh
    cb.send({ t: 'friends' });
    let alice = (await cb.next('friends')).graph.friends.find((f) => f.id === aliceId);
    assert.ok(alice && alice.presence.online, 'alice online');
    assert.strictEqual(alice.presence.status, 'online');

    // alice creates a room → in-game
    ca.send({ t: 'create', roomName: 'Presence', public: true, seed: 90 });
    const code = (await ca.next('welcome')).code;
    cb.send({ t: 'friends' });
    alice = (await cb.next('friends')).graph.friends.find((f) => f.id === aliceId);
    assert.strictEqual(alice.presence.status, 'ingame', 'alice in a game');
    assert.strictEqual(alice.presence.roomCode, code);

    // alice disconnects → offline
    ca.close();
    await sleep(300);
    cb.send({ t: 'friends' });
    alice = (await cb.next('friends')).graph.friends.find((f) => f.id === aliceId);
    assert.strictEqual(alice.presence.online, false, 'alice offline after leaving');
    cb.close();
  } finally { await srv.stop(); }
});
