#!/usr/bin/env node
'use strict';
/* ==========================================================================
   scripts/validate.js — fast static validation for CI (no browser, no deps).
   Syntax-checks every JS file and asserts a few structural invariants.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
function ok(msg) { console.log('  ✓ ' + msg); }
function bad(msg) { console.log('  ✗ ' + msg); failed++; }

// 1. syntax-check all JS under shared/, client/, server/, scripts/
function jsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      if (fs.statSync(fp).isDirectory()) { if (!/node_modules/.test(fp)) walk(fp); }
      else if (f.endsWith('.js')) out.push(fp);
    }
  })(dir);
  return out;
}
let syntaxOk = true;
for (const dir of ['shared', 'client', 'server', 'scripts']) {
  for (const f of jsFiles(path.join(ROOT, dir))) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad('syntax: ' + path.relative(ROOT, f) + '\n' + e.stderr); syntaxOk = false; }
  }
}
if (syntaxOk) ok('all JS files parse');

// 2. shared core loads and is deterministic across two instances
try {
  const Core = require('../shared/core.js');
  const a = Core.createGame({ seed: 123 });
  const b = Core.createGame({ seed: 123 });
  for (let i = 0; i < 200; i++) { a.tickOnce(null); b.tickOnce(null); }
  if (a.stateHash() === b.stateHash()) ok('shared core is deterministic (200 ticks, equal hash)');
  else bad('shared core DIVERGED across instances');
} catch (e) { bad('shared core failed to load: ' + e.message); }

// 3. server modules all require cleanly
try {
  process.env.STORAGE = 'file';
  require('../server/config');
  require('../server/network/websocket');
  require('../server/network/httpServer');
  require('../server/database');
  require('../server/players/sessions');
  require('../server/players/lobby');
  require('../server/world/registry');
  require('../server/simulation/room');
  ok('all server modules resolve');
} catch (e) { bad('server module load failed: ' + e.message); }

// 4. index.html references the expected scripts and has no inline event handlers
try {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const src of ['shared/core.js', 'client/net.js', 'client/game.js']) {
    if (!html.includes(src)) bad('index.html missing script ' + src);
  }
  if (/\son[a-z]+\s*=\s*"/.test(html.replace(/<meta[^>]*>/g, ''))) bad('index.html has inline event handlers (CSP risk)');
  else ok('index.html clean of inline handlers (CSP-safe)');
} catch (e) { bad('index.html check failed: ' + e.message); }

console.log(failed ? `\nVALIDATION FAILED (${failed})` : '\nVALIDATION PASSED');
process.exit(failed ? 1 : 0);
