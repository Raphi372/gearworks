'use strict';
/* ==========================================================================
   metrics.js — dependency-free observability (P1.4).

   Collects operational counters/gauges the server already has signal for —
   live rooms, connections, simulation ticks/sec, player commands, client↔server
   hash DIVERGENCES (a determinism/cheating signal), resyncs, and client RTT
   percentiles — and exposes them two ways:

     • GET /metrics  — Prometheus text exposition (scrape + alert externally)
     • GET /health   — the same numbers as JSON, for a quick eyeball / uptime check

   It also self-alerts on a divergence spike (via the monitoring webhook), since
   a burst of divergences means clients are computing different state than the
   authoritative server. Zero dependencies; all counters are plain integers and
   the RTT sketch is a fixed-size ring, so memory is bounded.
   ========================================================================== */
function createMetrics(config, deps) {
  deps = deps || {};
  const log = config.log;
  const monitor = deps.monitor;
  const gauges = deps.gauges || (() => ({}));      // live { rooms, connections }
  const startedAt = Date.now();

  const c = { ticks: 0, commands: 0, messages: 0, connections: 0, divergences: 0, resyncs: 0, errors: 0 };

  // RTT sketch: a fixed ring of the most recent client-reported round trips
  const RTT_CAP = 1024;
  const rtt = new Float64Array(RTT_CAP);
  let rttN = 0, rttI = 0;

  // ticks/sec: lightly smoothed, refreshed once a second from the tick counter
  let tps = 0, lastTicks = 0;
  const tpsTimer = setInterval(() => { const d = c.ticks - lastTicks; lastTicks = c.ticks; tps = tps * 0.5 + d * 0.5; }, 1000);
  if (tpsTimer.unref) tpsTimer.unref();

  // divergence-spike alerting: count divergences in a rolling minute; if they
  // cross the threshold, warn + report once (then reset to avoid alert storms)
  const alertPerMin = config.DIVERGENCE_ALERT_PER_MIN | 0;
  let divWindow = [];
  function checkDivergenceSpike() {
    const cut = Date.now() - 60000;
    divWindow = divWindow.filter((t) => t >= cut);
    if (alertPerMin > 0 && divWindow.length >= alertPerMin) {
      log.warn(`divergence spike: ${divWindow.length}/min (threshold ${alertPerMin}) — clients disagree with the authoritative state`);
      if (monitor && monitor.report) monitor.report('divergence_spike', new Error(`${divWindow.length} divergences in the last minute`));
      divWindow = [];      // reset so we alert once per burst, not every check
      return true;
    }
    return false;
  }
  const divTimer = setInterval(checkDivergenceSpike, 15000);
  if (divTimer.unref) divTimer.unref();

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[i]);
  }
  function rttStats() {
    if (!rttN) return { p50: 0, p95: 0, count: 0 };
    const a = Array.prototype.slice.call(rtt, 0, rttN).sort((x, y) => x - y);
    return { p50: percentile(a, 50), p95: percentile(a, 95), count: rttN };
  }

  function snapshot() {
    const g = gauges() || {};
    const r = rttStats();
    return {
      uptime_sec: Math.round((Date.now() - startedAt) / 1000),
      rooms: g.rooms | 0,
      connections: g.connections | 0,
      ticks_total: c.ticks,
      ticks_per_sec: Math.round(tps),
      commands_total: c.commands,
      messages_total: c.messages,
      connections_total: c.connections,
      divergences_total: c.divergences,
      resyncs_total: c.resyncs,
      errors_total: c.errors,
      rtt_ms_p50: r.p50,
      rtt_ms_p95: r.p95,
      rtt_samples: r.count,
    };
  }

  const SERIES = [
    ['uptime_seconds', 'gauge', 'Process uptime in seconds', 'uptime_sec'],
    ['rooms', 'gauge', 'Live game rooms', 'rooms'],
    ['connections', 'gauge', 'Current in-room WebSocket connections', 'connections'],
    ['ticks_total', 'counter', 'Simulation ticks executed', 'ticks_total'],
    ['ticks_per_second', 'gauge', 'Recent simulation ticks per second', 'ticks_per_sec'],
    ['commands_total', 'counter', 'Player commands applied', 'commands_total'],
    ['messages_total', 'counter', 'Inbound in-room messages', 'messages_total'],
    ['connections_total', 'counter', 'WebSocket connections opened', 'connections_total'],
    ['divergences_total', 'counter', 'Client/server state-hash divergences', 'divergences_total'],
    ['resyncs_total', 'counter', 'Authoritative snapshots resent to clients', 'resyncs_total'],
    ['errors_total', 'counter', 'Reported process errors', 'errors_total'],
    ['rtt_ms_p50', 'gauge', 'Client round-trip time p50 in ms', 'rtt_ms_p50'],
    ['rtt_ms_p95', 'gauge', 'Client round-trip time p95 in ms', 'rtt_ms_p95'],
  ];
  function prometheus() {
    const s = snapshot();
    const out = [];
    for (const [name, type, help, key] of SERIES) {
      out.push(`# HELP gearworks_${name} ${help}`);
      out.push(`# TYPE gearworks_${name} ${type}`);
      out.push(`gearworks_${name} ${s[key]}`);
    }
    return out.join('\n') + '\n';
  }

  function stop() { clearInterval(tpsTimer); clearInterval(divTimer); }

  return {
    recordTick() { c.ticks++; },
    recordCommands(n) { c.commands += n | 0; },
    recordMessage() { c.messages++; },
    recordConnection() { c.connections++; },
    recordResync() { c.resyncs++; },
    recordError() { c.errors++; },
    recordDivergence() { c.divergences++; divWindow.push(Date.now()); },
    recordRtt(ms) { if (!isFinite(ms) || ms < 0 || ms > 60000) return; rtt[rttI] = ms; rttI = (rttI + 1) % RTT_CAP; if (rttN < RTT_CAP) rttN++; },
    checkDivergenceSpike, snapshot, prometheus, stop,
    token: config.METRICS_TOKEN || '',       // optional bearer for /metrics
  };
}

module.exports = { createMetrics };
