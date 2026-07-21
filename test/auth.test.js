'use strict';
/* Integration: authentication & lobby identity (register/login/guest/token). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c, extra = {}) {
  c.send(Object.assign({ t: 'hello', proto: 1, name: 'Tester', gz: false }, extra));
  return c.next('lobby');
}

test('register creates an account and returns a session token', async () => {
  const c = await connect(srv.port);
  await hello(c);
  const name = uniq('ada_');
  c.send({ t: 'auth', mode: 'register', username: name, password: 'hunter2pw' });
  const res = await c.next('auth');
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.account.username, name);
  assert.ok(res.token && res.token.includes('.'), 'HMAC token returned');
  c.close();
});

test('duplicate username is rejected', async () => {
  const c = await connect(srv.port);
  await hello(c);
  const name = uniq('dup_');
  c.send({ t: 'auth', mode: 'register', username: name, password: 'hunter2pw' });
  assert.strictEqual((await c.next('auth')).ok, true);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'anotherpw1' });
  const res = await c.next('auth');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /taken/i);
  c.close();
});

test('invalid username and short password are rejected', async () => {
  const c = await connect(srv.port);
  await hello(c);
  c.send({ t: 'auth', mode: 'register', username: 'ab', password: 'hunter2pw' });   // too short
  assert.match((await c.next('auth')).error, /username/i);
  c.send({ t: 'auth', mode: 'register', username: uniq('shortpw_'), password: 'x' });
  assert.match((await c.next('auth')).error, /password/i);
  c.close();
});

test('login succeeds with correct password, fails with wrong', async () => {
  const reg = await connect(srv.port);
  await hello(reg);
  const name = uniq('log_');
  reg.send({ t: 'auth', mode: 'register', username: name, password: 'correctpw1' });
  assert.strictEqual((await reg.next('auth')).ok, true);
  reg.close();

  const c = await connect(srv.port);
  await hello(c);
  c.send({ t: 'auth', mode: 'login', username: name, password: 'correctpw1' });
  const good = await c.next('auth');
  assert.strictEqual(good.ok, true, good.error);
  assert.strictEqual(good.account.username, name);

  c.send({ t: 'auth', mode: 'login', username: name, password: 'WRONGpassword' });
  const bad = await c.next('auth');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /invalid credentials/i);
  c.close();
});

test('login is rate-limited after repeated failures (LOGIN_MAX_ATTEMPTS=3)', async () => {
  const name = uniq('rl_');
  const reg = await connect(srv.port);
  await hello(reg);
  reg.send({ t: 'auth', mode: 'register', username: name, password: 'correctpw1' });
  await reg.next('auth');
  reg.close();

  const c = await connect(srv.port);
  await hello(c);
  for (let i = 0; i < 3; i++) {
    c.send({ t: 'auth', mode: 'login', username: name, password: 'wrongpw' + i });
    assert.match((await c.next('auth')).error, /invalid credentials/i);
  }
  // 4th attempt is throttled — even with the CORRECT password
  c.send({ t: 'auth', mode: 'login', username: name, password: 'correctpw1' });
  assert.match((await c.next('auth')).error, /too many attempts/i);
  c.close();
});

test('guest login always succeeds and yields a persistent identity', async () => {
  const c = await connect(srv.port);
  await hello(c);
  c.send({ t: 'auth', mode: 'guest', username: 'Visitor' });
  const res = await c.next('auth');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.account.guest, true);
  assert.ok(res.token, 'guest gets a token');
  c.close();
});

test('a session token auto-logs-in via hello.authToken', async () => {
  const reg = await connect(srv.port);
  await hello(reg);
  const name = uniq('tok_');
  reg.send({ t: 'auth', mode: 'register', username: name, password: 'correctpw1' });
  const token = (await reg.next('auth')).token;
  reg.close();

  const c = await connect(srv.port);
  const lobby = await hello(c, { authToken: token });
  assert.ok(lobby.account, 'account present on lobby after token auto-login');
  assert.strictEqual(lobby.account.username, name);
  c.close();
});

test('a protocol-version mismatch is rejected', async () => {
  const c = await connect(srv.port);
  c.send({ t: 'hello', proto: 999, name: 'Old', gz: false });
  const err = await c.next('err');
  assert.match(err.reason, /protocol/i);
  c.close();
});
