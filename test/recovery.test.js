'use strict';
/* Integration: account recovery — email verification and password reset.
   Uses the `capture` mail backend (server writes outgoing mail to a JSONL file
   we read the token from). File backend; a Postgres case runs when
   TEST_DATABASE_URL is set. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');

let srv, capture;
before(async () => {
  capture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mail-')), 'out.jsonl');
  srv = await startServer({ MAIL_CAPTURE_FILE: capture });   // MAIL_PROVIDER auto-resolves to 'capture'
});
after(async () => { if (srv) await srv.stop(); });

function mails() {
  if (!fs.existsSync(capture)) return [];
  return fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function lastMail() { const m = mails(); if (!m.length) throw new Error('no mail captured'); return m[m.length - 1]; }
function tokenFrom(text) {
  const m = text.match(/[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/);
  if (!m) throw new Error('no token found in mail body');
  return m[0];
}
function resetCount(to) { return mails().filter((m) => m.to === to && /reset/i.test(m.subject)).length; }

async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }

// register, attach an email, and verify it (reads the verify token from mail)
async function registerVerified(name, email, password) {
  const c = await connect(srv.port);
  await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password });
  assert.ok((await c.next('auth')).ok);
  c.send({ t: 'setEmail', email });
  const set = await c.next('account');
  assert.ok(set.ok, set.error);
  assert.strictEqual(set.account.emailVerified, false);
  const vtok = tokenFrom(lastMail().text);
  c.send({ t: 'verifyEmail', token: vtok });
  const ver = await c.next('account');
  assert.ok(ver.ok, ver.error);
  assert.strictEqual(ver.account.emailVerified, true, 'email is verified');
  return c;
}

test('full password reset round-trip; old password stops working', async () => {
  const name = uniq('u_'), email = uniq('a') + '@example.com';
  (await registerVerified(name, email, 'origpass1')).close();

  const r = await connect(srv.port); await hello(r);
  r.send({ t: 'auth', mode: 'requestReset', emailOrUsername: email });
  assert.ok((await r.next('auth')).ok);
  const token = tokenFrom(lastMail().text);
  r.send({ t: 'auth', mode: 'resetPassword', token, password: 'brandnew99' });
  assert.ok((await r.next('auth')).ok, 'reset succeeded');

  r.send({ t: 'auth', mode: 'login', username: name, password: 'brandnew99' });
  assert.ok((await r.next('auth')).ok, 'new password works');
  r.send({ t: 'auth', mode: 'login', username: name, password: 'origpass1' });
  assert.strictEqual((await r.next('auth')).ok, false, 'old password rejected');
  r.close();

  // single-use: the same token cannot reset again (password changed → pv changed)
  const s = await connect(srv.port); await hello(s);
  s.send({ t: 'auth', mode: 'resetPassword', token, password: 'thirdpass1' });
  const again = await s.next('auth');
  assert.strictEqual(again.ok, false);
  assert.match(again.error, /already been used/i);
  s.close();
});

test('an invalid or garbage reset token is rejected', async () => {
  const c = await connect(srv.port); await hello(c);
  c.send({ t: 'auth', mode: 'resetPassword', token: 'not.arealtoken', password: 'whatever1' });
  const r = await c.next('auth');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid or has expired/i);
  c.close();
});

test('requestReset never reveals whether an account exists (no enumeration)', async () => {
  const c = await connect(srv.port); await hello(c);
  const before = mails().length;
  c.send({ t: 'auth', mode: 'requestReset', emailOrUsername: 'ghost-' + uniq('') + '@example.com' });
  assert.ok((await c.next('auth')).ok, 'always resolves ok');
  assert.strictEqual(mails().length, before, 'no email sent for a nonexistent account');
  c.close();
});

test('reset is not sent to an unverified email', async () => {
  const name = uniq('u_'), email = uniq('unv') + '@example.com';
  const c = await connect(srv.port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'origpass1' });
  await c.next('auth');
  c.send({ t: 'setEmail', email });            // sends a VERIFY mail; email stays unverified
  await c.next('account');
  c.close();

  const before = resetCount(email);
  const r = await connect(srv.port); await hello(r);
  r.send({ t: 'auth', mode: 'requestReset', emailOrUsername: email });
  await r.next('auth');
  assert.strictEqual(resetCount(email), before, 'no reset email to an unverified address');
  r.close();
});

test('reset requests are rate-limited (max 3 per 15 min)', async () => {
  const name = uniq('u_'), email = uniq('rl') + '@example.com';
  (await registerVerified(name, email, 'origpass1')).close();
  const r = await connect(srv.port); await hello(r);
  for (let i = 0; i < 5; i++) {
    r.send({ t: 'auth', mode: 'requestReset', emailOrUsername: email });
    assert.ok((await r.next('auth')).ok);      // always ok regardless of throttle
  }
  assert.ok(resetCount(email) <= 3, 'at most 3 reset emails were actually sent');
  r.close();
});
