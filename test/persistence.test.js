'use strict';
/* Integration: account-owned world persistence and owner-only resume.
   Runs on the default file backend; an optional Postgres case runs only when
   TEST_DATABASE_URL is set (migrations assumed applied). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');

async function hello(c, extra = {}) {
  c.send(Object.assign({ t: 'hello', proto: 1, name: 'P', gz: false }, extra));
  return c.next('lobby');
}
async function registerAndConnect(port, name, password) {
  const c = await connect(port);
  await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password });
  const res = await c.next('auth');
  assert.strictEqual(res.ok, true, res.error);
  return { c, account: res.account, token: res.token };
}

function suite(label, envForServer) {
  let srv;
  before(async () => { srv = await startServer(envForServer); });
  after(async () => { if (srv) await srv.stop(); });

  test(`[${label}] a world created while signed in is listed under My Worlds`, async () => {
    const { c } = await registerAndConnect(srv.port, uniq('owner_'), 'ownerpass1');
    c.send({ t: 'create', roomName: 'My Factory', public: false, seed: 1234 });
    const w = await c.next('welcome');
    c.send({ t: 'save' });                       // host manual save -> persisted with ownerId
    await c.next('saved', 4000);
    c.send({ t: 'myWorlds' });
    const my = await c.next('myWorlds', 4000);
    assert.ok(my.worlds.some((x) => x.code === w.code), 'created world appears in My Worlds');
    c.close();
  });

  test(`[${label}] a private saved world can be resumed only by its owner`, async () => {
    const nameA = uniq('alice_');
    const a1 = await registerAndConnect(srv.port, nameA, 'alicepass1');
    a1.c.send({ t: 'create', roomName: 'Alice World', public: false, seed: 5678 });
    const w = await a1.c.next('welcome');
    a1.c.send({ t: 'save' });
    await a1.c.next('saved', 4000);
    a1.c.close();                                // room empties, then evicts to disk

    await new Promise((r) => setTimeout(r, 1000));   // > EMPTY_ROOM_TTL_MS so it is disk-only

    // a different account may not resume it
    const b = await registerAndConnect(srv.port, uniq('bob_'), 'bobpass123');
    b.c.send({ t: 'resume', code: w.code });
    assert.match((await b.c.next('err', 4000)).reason, /belongs to another player/i);
    b.c.close();

    // the owner (re-logging in) can
    const a2 = await connect(srv.port);
    await hello(a2);
    a2.send({ t: 'auth', mode: 'login', username: nameA, password: 'alicepass1' });
    assert.strictEqual((await a2.next('auth')).ok, true);
    a2.send({ t: 'resume', code: w.code });
    const back = await a2.next('welcome', 4000);
    assert.strictEqual(back.code, w.code, 'owner resumed the world');
    assert.strictEqual(back.role, 'host');
    a2.close();
  });
}

// Default backend (always runs).
suite('file', {});

// Optional Postgres backend — only when a disposable test DB is provided.
// Assumes `prisma migrate deploy` has been run against TEST_DATABASE_URL.
if (process.env.TEST_DATABASE_URL) {
  suite('postgres', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL });
} else {
  test('postgres backend (skipped — set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
}
