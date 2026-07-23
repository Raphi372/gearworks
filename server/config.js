'use strict';
/* ==========================================================================
   Configuration & logging — the single source of tunables.
   Values come from environment variables (production) with CLI-flag overrides
   (local dev), so the same binary runs unchanged locally, in Docker, and on
   Fly.io/Railway. Nothing here reaches into game logic.
   ========================================================================== */
const path = require('path');
const Core = require('../shared/core.js');

const args = process.argv.slice(2);
function flag(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
function envInt(name, def) { const v = parseInt(process.env[name], 10); return Number.isFinite(v) ? v : def; }

const ROOT = path.resolve(__dirname, '..');

// --- .env loader (zero-dependency) ------------------------------------------
// Self-hosting on a laptop/box is far easier when secrets live in a gitignored
// .env file than in shell exports that vanish on reboot. We parse a minimal
// KEY=VALUE file (one pair per line, '#' comment lines, optional quotes) and
// populate process.env WITHOUT overwriting anything already set by the real
// environment (so Docker/CI/PM2 env always wins). No dependency is added — the
// runtime stays install-free. Put each value on its own line; inline comments
// after a value are treated as part of the value, so avoid them.
(function loadDotenv() {
  try {
    const raw = require('fs').readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;                                   // blank / comment / malformed
      let val = m[2];
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'"))))
        val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (e) { /* no .env present — that's fine */ }
})();

const NODE_ENV = process.env.NODE_ENV || 'development';

const config = {
  ROOT,
  NODE_ENV,
  isProd: NODE_ENV === 'production',
  PORT: parseInt(flag('--port', process.env.PORT || '8080'), 10),
  HOST: process.env.HOST || '0.0.0.0',

  // persistence
  STORAGE: (process.env.STORAGE || 'file').toLowerCase(),   // 'file' | 'postgres'
  SAVE_DIR: path.resolve(ROOT, flag('--save-dir', process.env.SAVE_DIR || 'saves')),
  DATABASE_URL: process.env.DATABASE_URL || '',
  BACKUPS: envInt('BACKUPS', 5),
  LOAD_FILE: flag('--load', process.env.LOAD_FILE || null),
  // on boot, re-create rooms saved within this window so a restart/deploy or
  // crash doesn't end live games (RESTORE_ON_BOOT=0 disables).
  RESTORE_ON_BOOT: process.env.RESTORE_ON_BOOT !== '0',
  RESTORE_WINDOW_MIN: envInt('RESTORE_WINDOW_MIN', 30),
  // time-series stats: sample each active account's aggregate every N minutes
  // (STAT_SAMPLE_MIN=0 disables the sampler), keeping the last STAT_KEEP points
  // per metric so storage stays bounded.
  STAT_SAMPLE_MIN: envInt('STAT_SAMPLE_MIN', 60),
  STAT_KEEP: envInt('STAT_KEEP', 168),                 // e.g. a week of hourly points
  // observability: /metrics (Prometheus) + /health JSON. An optional bearer
  // token gates /metrics; a divergence spike (per minute) triggers an alert.
  METRICS_TOKEN: process.env.METRICS_TOKEN || '',
  DIVERGENCE_ALERT_PER_MIN: envInt('DIVERGENCE_ALERT_PER_MIN', 0),   // 0 disables

  // horizontal-scale scaffolding (docs/FUTURE_ARCHITECTURE.md, Phase 1). All
  // additive: DIRECTORY=local is the single-instance no-op used by the $0 deploy.
  INSTANCE_ID: process.env.INSTANCE_ID || `${require('os').hostname()}-${process.pid}`,
  REGION: process.env.REGION || 'local',
  PUBLIC_URL: process.env.PUBLIC_URL || '',           // this instance's reachable ws(s):// URL
  DIRECTORY: process.env.DIRECTORY || 'local',        // 'local' | 'file' (shared room router)
  DIRECTORY_DIR: process.env.DIRECTORY_DIR || '',     // defaults to <SAVE_DIR>/directory (see directory.js)
  DIRECTORY_STALE_MS: envInt('DIRECTORY_STALE_MS', 120000),   // a route unrefreshed this long is dead
  DIRECTORY_HEARTBEAT_MS: envInt('DIRECTORY_HEARTBEAT_MS', 30000),
  CONNECT_TTL_MS: envInt('CONNECT_TTL_MIN', 2) * 60 * 1000,   // connect-token lifetime
  // where room snapshot blobs live: 'inline' (default) or 'fs' (shared dir), so
  // any instance can load any room. Object storage (s3/R2) slots in here next.
  SNAPSHOT_STORE: process.env.SNAPSHOT_STORE || 'inline',
  SNAPSHOT_DIR: process.env.SNAPSHOT_DIR || '',                // defaults to <SAVE_DIR>/snapshots

  // simulation / networking
  TICK_MS: 1000 / Core.Config.SIM_HZ,
  MAX_ROOMS: envInt('MAX_ROOMS', 32),
  MAX_PLAYERS_PER_ROOM: envInt('MAX_PLAYERS_PER_ROOM', 16),
  MAX_MSG_BYTES: envInt('MAX_MSG_BYTES', 512 * 1024),
  CMD_RATE_LIMIT: envInt('CMD_RATE_LIMIT', 100),       // commands/sec/client
  CHAT_RATE_LIMIT: envInt('CHAT_RATE_LIMIT', 6),       // messages/5s/client
  EMPTY_ROOM_TTL_MS: envInt('EMPTY_ROOM_TTL_MS', 10 * 60 * 1000),
  HASH_INTERVAL: envInt('HASH_INTERVAL', 100),         // ticks between hash audits
  ALLOW_ORIGIN: process.env.ALLOW_ORIGIN || '*',       // CORS for /health etc.

  // accounts / auth
  AUTH_SECRET: process.env.AUTH_SECRET || '',      // HMAC key for session tokens; MUST be set in prod
  TOKEN_TTL_DAYS: envInt('TOKEN_TTL_DAYS', 30),
  RECONNECT_TTL_MIN: envInt('RECONNECT_TTL_MIN', 60),    // reconnect-token lifetime
  RECONNECT_TTL_MS: envInt('RECONNECT_TTL_MIN', 60) * 60 * 1000,
  LOGIN_MAX_ATTEMPTS: envInt('LOGIN_MAX_ATTEMPTS', 8),   // per username per 15 min
  MAINTENANCE: process.env.MAINTENANCE === '1',    // reject new games with a notice

  // account recovery (password reset / email verification)
  RESET_TTL_MIN: envInt('RESET_TTL_MIN', 45),      // reset/verify token lifetime
  // mail: zero-dependency. 'resend' uses the HTTP API; 'capture' writes JSONL
  // (tests); default 'log' sends nothing (dev logs the body, prod stays quiet).
  MAIL_PROVIDER: (process.env.MAIL_PROVIDER || (process.env.MAIL_CAPTURE_FILE ? 'capture' : 'log')).toLowerCase(),
  MAIL_API_KEY: process.env.MAIL_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || 'Gearworks <onboarding@resend.dev>',
  MAIL_CAPTURE_FILE: process.env.MAIL_CAPTURE_FILE || '',
  APP_URL: process.env.APP_URL || '',              // used to build reset links in email

  PROTO: Core.PROTO,
  VERSION: process.env.GIT_SHA || 'dev',
};

// A stable secret is required to sign session tokens across restarts. In dev we
// synthesize an ephemeral one (sessions won't survive a restart) and warn.
if (!config.AUTH_SECRET) {
  config.AUTH_SECRET = require('crypto').randomBytes(32).toString('hex');
  config._ephemeralSecret = true;
}

/* ----------------------------- logging -------------------------------- */
// Human-readable lines in dev; single-line JSON in production so log
// aggregators (Fly, Railway, Grafana Loki, …) can parse them.
function emit(level, msg, extra) {
  if (config.isProd) {
    process.stdout.write(JSON.stringify(Object.assign({ t: new Date().toISOString(), level, msg }, extra || {})) + '\n');
  } else {
    const e = extra ? ' ' + JSON.stringify(extra) : '';
    process.stdout.write(`[${new Date().toISOString()}] ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${e}\n`);
  }
}
const log = (msg, extra) => emit('info', msg, extra);
log.info = log;
log.warn = (msg, extra) => emit('warn', msg, extra);
log.error = (msg, extra) => emit('error', msg, extra);

config.log = log;
if (config._ephemeralSecret) log.warn('AUTH_SECRET not set — using an ephemeral key; sessions will not survive a restart. Set AUTH_SECRET in production.');
if (config.MAINTENANCE) log.warn('MAINTENANCE mode is ON — new games are disabled.');
module.exports = config;
