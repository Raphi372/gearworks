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

  PROTO: Core.PROTO,
  VERSION: process.env.GIT_SHA || 'dev',
};

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
module.exports = config;
