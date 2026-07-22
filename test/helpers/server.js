'use strict';
/* ==========================================================================
   test/helpers/server.js — boot the REAL server as a child process for
   integration tests, on an ephemeral port with a throwaway save directory and
   test-only limits. Nothing is stubbed: this exercises the actual transport,
   lobby, auth, rooms, and persistence exactly as production does.
   ========================================================================== */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', '..', 'server', 'server.js');

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function waitHealthy(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (r) => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
      function retry() { if (Date.now() > deadline) reject(new Error('server never became healthy')); else setTimeout(poll, 100); }
    })();
  });
}

// Boot a server. `extraEnv` overrides defaults (e.g. STORAGE/DATABASE_URL for
// the Postgres-backed tests). Returns { port, saveDir, logs, stop }.
async function startServer(extraEnv = {}) {
  const port = await freePort();
  // honor a caller-provided SAVE_DIR (restart tests reuse one across servers);
  // only auto-clean directories we created ourselves.
  const ownsSaveDir = !extraEnv.SAVE_DIR;
  const saveDir = extraEnv.SAVE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'gw-it-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    STORAGE: 'file',
    SAVE_DIR: saveDir,
    AUTH_SECRET: 'itest-' + crypto.randomBytes(8).toString('hex'),
    NODE_ENV: 'development',
    // test-tuned limits: fast idle-eviction, small caps, quick hash audits
    EMPTY_ROOM_TTL_MS: '500',
    HASH_INTERVAL: '20',
    LOGIN_MAX_ATTEMPTS: '3',
    MAX_ROOMS: '64',
  }, extraEnv);

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));

  try {
    await waitHealthy(port);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) {}
    throw new Error(e.message + '\n--- server output ---\n' + out.join(''));
  }

  return {
    port,
    saveDir,
    logs: () => out.join(''),
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) { cleanup(); return resolve(); }
        child.on('exit', () => { cleanup(); resolve(); });
        try { child.kill('SIGTERM'); } catch (_) { cleanup(); resolve(); }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2500).unref();
      });
      function cleanup() { if (ownsSaveDir) { try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch (_) {} } }
    },
  };
}

module.exports = { startServer, freePort };
