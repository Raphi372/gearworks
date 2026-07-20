'use strict';
/* ==========================================================================
   monitoring.js — optional, dependency-free error reporting.

   Production error tracking without pulling in the Sentry SDK (which would
   break the zero-dependency runtime). If ERROR_WEBHOOK (or a Sentry
   store-endpoint URL) is configured, uncaught errors are POSTed as JSON;
   otherwise this is a no-op beyond local logging. See docs/PRODUCTION.md for
   wiring a full Sentry/analytics stack.
   ========================================================================== */
const https = require('https');
const http = require('http');
const { URL } = require('url');

function createMonitoring(config) {
  const endpoint = process.env.ERROR_WEBHOOK || '';
  const log = config.log;

  function report(kind, err) {
    if (!endpoint) return;
    try {
      const u = new URL(endpoint);
      const body = JSON.stringify({
        service: 'gearworks-server', version: config.VERSION, env: config.NODE_ENV,
        kind, message: (err && (err.message || String(err))) || 'unknown',
        stack: err && err.stack, ts: new Date().toISOString(),
      });
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 4000 });
      req.on('error', () => {});      // never let telemetry failures cascade
      req.on('timeout', () => req.destroy());
      req.end(body);
    } catch (e) { /* swallow */ }
  }

  if (endpoint) log(`error reporting enabled -> ${endpoint.replace(/\/\/[^@]*@/, '//***@')}`);
  return { report };
}

module.exports = { createMonitoring };
