'use strict';
/* Integration: the player-reports lifecycle. Any signed-in player can flag
   another for review; admins (ADMIN_USERS) triage a queue and resolve/dismiss.
   File backend; a Postgres case runs when TEST_DATABASE_URL is set. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }
async function register(port, name) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
  const r = await c.next('auth');
  return { c, id: r.account.id, name, account: r.account };
}

function suite(label, baseEnv) {
  test(`[${label}] a player files a report; an admin triages the queue`, async () => {
    const admin = uniq('admin');
    const srv = await startServer(Object.assign({ ADMIN_USERS: admin }, baseEnv));
    try {
      const a = await register(srv.port, admin);
      const reporter = await register(srv.port, uniq('rep'));
      const target = await register(srv.port, uniq('bad'));

      // an ordinary player files a report (and re-files → still one open report)
      reporter.c.send({ t: 'report', username: target.name, reason: 'spamming chat' });
      assert.strictEqual((await reporter.c.next('reported')).ok, true);
      reporter.c.send({ t: 'report', username: target.name, reason: 'spamming chat again' });
      await reporter.c.next('reported');

      // the reporter (non-admin) cannot see the queue
      reporter.c.send({ t: 'mod' });
      const denied = await reporter.c.next('mod');
      assert.strictEqual(denied.error, 'not authorized');
      assert.strictEqual(denied.reports, null);

      // the admin sees exactly one open report, enriched with names + reason
      a.c.send({ t: 'mod' });
      let mod = await a.c.next('mod');
      const mine = mod.reports.filter((r) => r.target === target.name.toLowerCase());
      assert.strictEqual(mine.length, 1, 'one open report per (reporter, target)');
      assert.strictEqual(mine[0].reporter, reporter.name.toLowerCase());
      assert.strictEqual(mine[0].reason, 'spamming chat again', 're-report updates the reason');

      // the admin dismisses it → it leaves the open queue
      a.c.send({ t: 'reportResolve', id: mine[0].id, action: 'dismissed' });
      mod = await a.c.next('mod');
      assert.ok(!mod.reports.some((r) => r.id === mine[0].id), 'resolved report leaves the queue');

      a.c.close(); reporter.c.close(); target.c.close();
    } finally { await srv.stop(); }
  });

  test(`[${label}] you cannot report yourself or an admin`, async () => {
    const admin = uniq('admin');
    const srv = await startServer(Object.assign({ ADMIN_USERS: admin }, baseEnv));
    try {
      const p = await register(srv.port, uniq('p'));
      p.c.send({ t: 'report', username: p.name, reason: 'x' });
      assert.match((await p.c.next('reported')).error, /yourself/);
      p.c.send({ t: 'report', username: admin, reason: 'x' });
      assert.match((await p.c.next('reported')).error, /cannot be reported/);
      p.c.close();
    } finally { await srv.stop(); }
  });
}

suite('file', {});
if (process.env.TEST_DATABASE_URL) {
  suite('postgres', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL });
} else {
  test('postgres reports (skipped — set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
}
