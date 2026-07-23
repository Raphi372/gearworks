'use strict';
/* Observability (P1.4).
   - the metrics module: counters, RTT percentiles, Prometheus exposition,
     and divergence-spike alerting,
   - end-to-end: /metrics serves Prometheus text and reflects live activity;
     /health carries the same numbers; the optional bearer token gates /metrics. */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createMetrics } = require('../server/metrics');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quietLog() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: headers || {} }, (r) => {
      let body = ''; r.on('data', (d) => (body += d)); r.on('end', () => resolve({ status: r.statusCode, body, ctype: r.headers['content-type'] }));
    });
    req.on('error', reject);
  });
}

test('metrics: counters, RTT percentiles, and Prometheus exposition', () => {
  const m = createMetrics({ log: quietLog(), METRICS_TOKEN: '', DIVERGENCE_ALERT_PER_MIN: 0 },
    { gauges: () => ({ rooms: 2, connections: 5 }) });
  m.recordTick(); m.recordTick(); m.recordCommands(3);
  m.recordConnection(); m.recordDivergence(); m.recordResync(); m.recordMessage();
  [10, 20, 30, 40, 100].forEach((v) => m.recordRtt(v));
  m.recordRtt(-1); m.recordRtt(999999);        // out-of-range samples ignored

  const s = m.snapshot();
  assert.strictEqual(s.rooms, 2);
  assert.strictEqual(s.connections, 5);
  assert.strictEqual(s.ticks_total, 2);
  assert.strictEqual(s.commands_total, 3);
  assert.strictEqual(s.divergences_total, 1);
  assert.strictEqual(s.resyncs_total, 1);
  assert.strictEqual(s.connections_total, 1);
  assert.strictEqual(s.rtt_samples, 5);
  assert.strictEqual(s.rtt_ms_p50, 30);        // floor(0.5*5)=index 2 -> 30
  assert.strictEqual(s.rtt_ms_p95, 100);

  const prom = m.prometheus();
  assert.match(prom, /# TYPE gearworks_ticks_total counter/);
  assert.match(prom, /gearworks_ticks_total 2/);
  assert.match(prom, /gearworks_rooms 2/);
  assert.match(prom, /gearworks_rtt_ms_p95 100/);
  m.stop();
});

test('metrics: a divergence spike alerts via the monitor once per burst', () => {
  let reports = 0, lastKind = null;
  const monitor = { report: (kind) => { reports++; lastKind = kind; } };
  const m = createMetrics({ log: quietLog(), DIVERGENCE_ALERT_PER_MIN: 3 }, { monitor, gauges: () => ({}) });

  m.recordDivergence(); m.recordDivergence();
  assert.strictEqual(m.checkDivergenceSpike(), false, 'below threshold: no alert');
  assert.strictEqual(reports, 0);

  m.recordDivergence();                          // now 3 in the window == threshold
  assert.strictEqual(m.checkDivergenceSpike(), true, 'threshold reached: alert');
  assert.strictEqual(reports, 1);
  assert.strictEqual(lastKind, 'divergence_spike');

  assert.strictEqual(m.checkDivergenceSpike(), false, 'window reset: no repeat alert');
  assert.strictEqual(reports, 1);
  m.stop();
});

test('metrics: no divergence alert when the threshold is disabled (0)', () => {
  let reports = 0;
  const m = createMetrics({ log: quietLog(), DIVERGENCE_ALERT_PER_MIN: 0 }, { monitor: { report: () => reports++ }, gauges: () => ({}) });
  for (let i = 0; i < 20; i++) m.recordDivergence();
  assert.strictEqual(m.checkDivergenceSpike(), false);
  assert.strictEqual(reports, 0);
  m.stop();
});

test('/metrics serves Prometheus text and reflects live activity; /health carries the numbers', async () => {
  const srv = await startServer({});
  try {
    // /metrics before any traffic
    const before = await httpGet(srv.port, '/metrics');
    assert.strictEqual(before.status, 200);
    assert.match(before.ctype, /text\/plain/);
    assert.match(before.body, /gearworks_rooms 0/);

    // create a room and drive some ticks + a ping carrying an RTT sample
    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'create', roomName: 'Obs', public: true, seed: 60 });
    await c.next('welcome');
    c.send({ t: 'ping', ts: 1, rtt: 42 });
    await new Promise((r) => setTimeout(r, 400));   // let a few ticks run

    const health = JSON.parse((await httpGet(srv.port, '/health')).body);
    assert.ok(health.metrics, '/health includes a metrics block');
    assert.strictEqual(health.metrics.rooms, 1, 'one live room');
    assert.ok(health.metrics.ticks_total > 0, 'ticks advanced');
    assert.ok(health.metrics.connections_total >= 1, 'a connection was counted');
    assert.strictEqual(health.metrics.rtt_ms_p50, 42, 'client RTT recorded');

    const after = await httpGet(srv.port, '/metrics');
    assert.match(after.body, /gearworks_rooms 1/);
    assert.match(after.body, /gearworks_rtt_ms_p50 42/);
    c.close();
  } finally { await srv.stop(); }
});

test('/metrics honors an optional bearer token', async () => {
  const token = uniq('tok_');
  const srv = await startServer({ METRICS_TOKEN: token });
  try {
    const noauth = await httpGet(srv.port, '/metrics');
    assert.strictEqual(noauth.status, 401, 'rejected without the token');
    const ok = await httpGet(srv.port, '/metrics', { Authorization: `Bearer ${token}` });
    assert.strictEqual(ok.status, 200, 'accepted with the token');
    assert.match(ok.body, /gearworks_uptime_seconds/);
  } finally { await srv.stop(); }
});
