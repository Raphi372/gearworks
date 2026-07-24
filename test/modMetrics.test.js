'use strict';
/* Observability for the moderation / anti-cheat subsystems: bans, reports, and
   anti-cheat flags surface as Prometheus counters on /metrics (and /health). */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createMetrics } = require('../server/metrics');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; };
async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }
async function reg(port, name) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
  const r = await c.next('auth'); return { c, name, id: r.account.id };
}
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    req.on('error', reject);
  });
}
const metricVal = (body, name) => { const m = body.match(new RegExp('^gearworks_' + name + ' (\\d+)$', 'm')); return m ? Number(m[1]) : null; };

test('the moderation/anti-cheat counters increment and export', () => {
  const m = createMetrics({ log: quiet(), METRICS_TOKEN: '', DIVERGENCE_ALERT_PER_MIN: 0 }, {});
  m.recordBan(); m.recordBan(); m.recordReport(); m.recordFlag(); m.recordFlag(); m.recordFlag();
  const s = m.snapshot();
  assert.strictEqual(s.bans_total, 2);
  assert.strictEqual(s.reports_total, 1);
  assert.strictEqual(s.flags_total, 3);
  const p = m.prometheus();
  assert.match(p, /# TYPE gearworks_bans_total counter/);
  assert.match(p, /^gearworks_bans_total 2$/m);
  assert.match(p, /^gearworks_reports_total 1$/m);
  assert.match(p, /^gearworks_flags_total 3$/m);
});

test('bans, reports and flags surface on /metrics end-to-end', async () => {
  const admin = uniq('admin');
  const srv = await startServer({ ADMIN_USERS: admin, CMD_RATE_LIMIT: '2', ANTICHEAT_FLAG_SCORE: '20' });
  try {
    const a = await reg(srv.port, admin);
    const reporter = await reg(srv.port, uniq('rep'));
    const target = await reg(srv.port, uniq('bad'));

    // a report
    reporter.c.send({ t: 'report', username: target.name, reason: 'griefing' });
    assert.strictEqual((await reporter.c.next('reported')).ok, true);
    // a ban
    a.c.send({ t: 'ban', username: target.name, reason: 'cheating' });
    await a.c.next('mod');
    // an anti-cheat flag: a player bursts commands past the rate limit in a room
    const spam = await reg(srv.port, uniq('spam'));
    spam.c.send({ t: 'create', roomName: 'Spam', public: true, seed: 3 }); await spam.c.next('welcome');
    for (let i = 0; i < 15; i++) spam.c.send({ t: 'cmd', q: i, cmd: { t: 'noop' } });
    await sleep(300);

    const res = await httpGet(srv.port, '/metrics');
    assert.strictEqual(res.status, 200);
    assert.ok(metricVal(res.body, 'reports_total') >= 1, 'reports counted');
    assert.ok(metricVal(res.body, 'bans_total') >= 1, 'bans counted');
    assert.ok(metricVal(res.body, 'flags_total') >= 1, 'flags counted');

    // /health carries the same numbers (nested under `metrics`)
    const health = JSON.parse((await httpGet(srv.port, '/health')).body);
    assert.ok(health.metrics.bans_total >= 1 && health.metrics.reports_total >= 1 && health.metrics.flags_total >= 1);

    a.c.close(); reporter.c.close(); target.c.close(); spam.c.close();
  } finally { await srv.stop(); }
});
