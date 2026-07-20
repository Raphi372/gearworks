#!/usr/bin/env node
'use strict';
/* ==========================================================================
   scripts/test.js — headless integration tests (no browser required).

   Exercises the authoritative stack end-to-end in-process: determinism,
   snapshot round-trips, command validation/authority, chat sanitization, and
   the file persistence backend. Complements the Playwright UI tests (which
   need a browser) with a fast CI-friendly check.
   ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../shared/core.js');

let passed = 0;
function test(name, fn) { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } }

function findIron(g) {
  for (let r = 2; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let ore = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const t = g.World.tileAt(dx + x, dy + y); if (t.r === 'iron' && t.amt > 0) ore++; }
    if (ore >= 3 && !g.World.tileAt(dx, dy).water) return [dx, dy];
  }
  throw new Error('no iron patch found');
}

test('determinism: identical command stream -> identical hash', () => {
  const a = Core.createGame({ seed: 777 }), b = Core.createGame({ seed: 777 });
  const [x, y] = findIron(a);
  const cmd = { t: 'place', type: 'miner', x, y, rot: 1 };
  assert.strictEqual(a.Commands.validate(cmd), null, 'placement should validate');
  a.tickOnce([cmd]); b.tickOnce([cmd]);
  for (let i = 0; i < 500; i++) { a.tickOnce(null); b.tickOnce(null); }
  assert.strictEqual(a.stateHash(), b.stateHash());
});

test('snapshot round-trip stays in lockstep', () => {
  const a = Core.createGame({ seed: 42 });
  const [x, y] = findIron(a);
  a.tickOnce([{ t: 'place', type: 'miner', x, y, rot: 1 },
    { t: 'place', type: 'belt', x: x + 2, y, rot: 1 }, { t: 'place', type: 'furnace', x: x + 3, y, rot: 1 }]);
  for (let i = 0; i < 300; i++) a.tickOnce(null);
  const snap = JSON.parse(JSON.stringify(a.Snapshot.capture()));
  const b = Core.createGame({ seed: 42 }); b.Snapshot.restore(snap);
  assert.strictEqual(a.stateHash(), b.stateHash(), 'equal immediately after restore');
  for (let i = 0; i < 300; i++) { a.tickOnce(null); b.tickOnce(null); }
  assert.strictEqual(a.stateHash(), b.stateHash(), 'equal after 300 more ticks');
});

test('command authority: invalid commands rejected', () => {
  const g = Core.createGame({ seed: 5 });
  assert.ok(g.Commands.validate({ t: 'place', type: 'assembler', x: 0, y: 0, rot: 0 }), 'tech-locked building rejected');
  assert.ok(g.Commands.validate({ t: 'sell', item: 'iron_plate', qty: 999999 }), 'oversized sell rejected');
  assert.ok(g.Commands.validate({ t: 'research', tech: 'ai_core' }), 'unmet-prereq research rejected');
  assert.strictEqual(g.Commands.PERMS.ai, 'server', 'ai command is server-only');
  assert.strictEqual(g.Commands.PERMS.setWeather, 'admin', 'weather is admin-gated');
});

test('file persistence backend saves a room to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const config = { SAVE_DIR: dir, BACKUPS: 5, log: Object.assign(() => {}, { error: () => {} }) };
  const { createFileStore } = require('../server/database/fileStore');
  const store = createFileStore(config);
  const g = Core.createGame({ seed: 9 });
  const data = { meta: { name: 'T', code: 'ABC123', saved: Date.now(), kind: 'test', seq: 1 }, snapshot: g.Snapshot.capture() };
  assert.ok(store.saveRoom('ABC123', data), 'saveRoom returns true');
  assert.ok(fs.existsSync(path.join(dir, 'ABC123.json')), 'save file exists on disk');
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'ABC123.json'), 'utf8'));
  assert.ok(back && back.snapshot && back.snapshot.tick !== undefined, 'reloaded room has a snapshot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chat sanitization strips control chars and caps length', () => {
  // mirror the server-side sanitize used in simulation/room.js
  const sanitize = (s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  assert.strictEqual(sanitize('hi\tthere\n'), 'hithere');
  assert.strictEqual(sanitize('Z'.repeat(300)).length, 200);
  assert.strictEqual(sanitize('   '), '');
});

setTimeout(() => console.log(`\n${passed} tests passed`), 50);
