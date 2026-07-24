'use strict';
/* Integration: account bans. An admin (ADMIN_USERS) can ban/unban by username;
   bans are enforced server-side at login and session resume, and issuing one
   kills the target's live session immediately. File backend; a Postgres case
   runs when TEST_DATABASE_URL is set. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c, token) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false, authToken: token }); return c.next('lobby'); }
async function register(port, name) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
  const r = await c.next('auth');
  return { c, id: r.account.id, name, token: r.token, account: r.account };
}

function suite(label, baseEnv) {
  test(`[${label}] an admin can ban and unban; a ban blocks login + kills the session`, async () => {
    const admin = uniq('admin');
    const srv = await startServer(Object.assign({ ADMIN_USERS: admin }, baseEnv));
    try {
      const a = await register(srv.port, admin);
      const t = await register(srv.port, uniq('grief'));
      assert.strictEqual(a.account.admin, true, 'admin flag set on the admin account');
      assert.ok(!t.account.admin, 'ordinary account is not an admin');

      // admin bans the target with a reason → the ban shows up in the list
      a.c.send({ t: 'ban', username: t.name, reason: 'griefing' });
      let mod = await a.c.next('mod');
      assert.strictEqual(mod.error, null);
      assert.ok(mod.bans.some((b) => b.username === t.name.toLowerCase() && b.reason === 'griefing'), 'ban is listed');

      // the target can no longer log in — the reason is surfaced
      const t2 = await connect(srv.port); await hello(t2);
      t2.send({ t: 'auth', mode: 'login', username: t.name, password: 'pw12345678' });
      const denied = await t2.next('auth');
      assert.strictEqual(denied.ok, false);
      assert.match(denied.error, /banned/);
      assert.match(denied.error, /griefing/);

      // the target's existing session token is dead too (tokenVersion bumped)
      const t3 = await connect(srv.port);
      const lob = await hello(t3, t.token);
      assert.strictEqual(lob.account, null, 'banned session resolves to signed-out');

      // unban → the target can log in again
      a.c.send({ t: 'unban', username: t.name });
      mod = await a.c.next('mod');
      assert.ok(!mod.bans.some((b) => b.username === t.name.toLowerCase()), 'ban lifted');
      const t4 = await connect(srv.port); await hello(t4);
      t4.send({ t: 'auth', mode: 'login', username: t.name, password: 'pw12345678' });
      assert.strictEqual((await t4.next('auth')).ok, true, 'login restored after unban');

      a.c.close(); t.c.close(); t2.close(); t3.close(); t4.close();
    } finally { await srv.stop(); }
  });

  test(`[${label}] a non-admin cannot use the ban tools, and an admin cannot be banned`, async () => {
    const admin = uniq('admin');
    const srv = await startServer(Object.assign({ ADMIN_USERS: admin }, baseEnv));
    try {
      const a = await register(srv.port, admin);
      const nobody = await register(srv.port, uniq('nobody'));

      // an ordinary account's ban command is refused
      nobody.c.send({ t: 'ban', username: admin, reason: 'coup' });
      const r = await nobody.c.next('mod');
      assert.strictEqual(r.error, 'not authorized');
      assert.strictEqual(r.bans, null);

      // an admin cannot be banned (here, the admin banning itself)
      a.c.send({ t: 'ban', username: admin });
      const r2 = await a.c.next('mod');
      assert.strictEqual(r2.error, 'cannot ban an admin');

      a.c.close(); nobody.c.close();
    } finally { await srv.stop(); }
  });
}

suite('file', {});
if (process.env.TEST_DATABASE_URL) {
  suite('postgres', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL });
} else {
  test('postgres moderation (skipped — set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
}

// store-level: a lapsed temporary ban is treated as inactive and cleared
test('the file store expires a temporary ban', () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const { createFileStore } = require('../server/database/fileStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ban-'));
  const store = createFileStore({ SAVE_DIR: dir, BACKUPS: 1, log: { error() {} } });
  return (async () => {
    await store.banAccount('acc1', { reason: 'temp', by: 'mod', at: Date.now(), until: Date.now() - 1000 });
    assert.strictEqual(await store.getBan('acc1'), null, 'a past-dated ban is inactive');
    await store.banAccount('acc2', { reason: 'perm', by: 'mod', at: Date.now(), until: 0 });
    assert.ok(await store.getBan('acc2'), 'a permanent ban stays active');
    fs.rmSync(dir, { recursive: true, force: true });
  })();
});
