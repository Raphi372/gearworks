'use strict';
/* Integration: durable & versioned sessions (P1.2).
   - reconnect tokens survive a real server restart (shared AUTH_SECRET),
   - password reset invalidates existing auth sessions,
   - forged / tampered / expired reconnect tokens are rejected. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
function tokenFrom(text) { const m = text.match(/[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/); if (!m) throw new Error('no token in mail'); return m[0]; }
function lastMail(file) { const l = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); return JSON.parse(l[l.length - 1]); }

test('a reconnect token survives a full server restart (durable reconnect)', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sess-'));
  const AUTH_SECRET = 'p12-durable-fixed-secret';   // stable across the restart (as in prod)
  try {
    // server #1: host a world, capture the reconnect token, then SIGTERM (final-save)
    const s1 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET });
    const c1 = await connect(s1.port); await hello(c1);
    c1.send({ t: 'create', roomName: 'Camp', public: true, seed: 20 });
    const w1 = await c1.next('welcome');
    const reconnectToken = w1.token;
    assert.strictEqual(w1.role, 'host');
    c1.close();
    await s1.stop();

    // server #2: same SAVE_DIR + same secret. P0.3 restores the room; the
    // stateless token verifies and re-seats us into it.
    const s2 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET, EMPTY_ROOM_TTL_MS: '5000' });
    const c2 = await connect(s2.port); await hello(c2);
    c2.send({ t: 'rejoin', token: reconnectToken });
    const w2 = await c2.next('welcome', 4000);
    assert.strictEqual(w2.code, w1.code, 'rejoined the same room after restart');
    assert.strictEqual(w2.role, 'host', 'same role restored');
    assert.ok(w2.players.some((p) => p.name === 'Ada' && p.role === 'host'), 'seat restored');
    c2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});

test('a password reset invalidates existing auth sessions', async () => {
  const capture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sessmail-')), 'out.jsonl');
  const srv = await startServer({ MAIL_CAPTURE_FILE: capture });
  try {
    const name = uniq('u_'), email = uniq('a') + '@example.com';
    // register + attach + verify email; capture the auth (session) token
    const reg = await connect(srv.port); await hello(reg);
    reg.send({ t: 'auth', mode: 'register', username: name, password: 'origpass1' });
    const authToken = (await reg.next('auth')).token;
    reg.send({ t: 'setEmail', email }); await reg.next('account');
    reg.send({ t: 'verifyEmail', token: tokenFrom(lastMail(capture).text) }); await reg.next('account');
    reg.close();

    // the auth token auto-logs-in
    const a = await connect(srv.port);
    assert.ok((await hello(a, { authToken })).account, 'token works before reset');
    a.close();

    // reset the password
    const r = await connect(srv.port); await hello(r);
    r.send({ t: 'auth', mode: 'requestReset', emailOrUsername: email }); await r.next('auth');
    r.send({ t: 'auth', mode: 'resetPassword', token: tokenFrom(lastMail(capture).text), password: 'brandnew99' });
    assert.ok((await r.next('auth')).ok, 'reset succeeded');
    r.close();

    // the OLD token is now rejected (tokenVersion bumped), but a fresh login works
    const b = await connect(srv.port);
    assert.ok(!(await hello(b, { authToken })).account, 'old session invalidated after reset');
    b.send({ t: 'auth', mode: 'login', username: name, password: 'brandnew99' });
    assert.ok((await b.next('auth')).ok, 'new login works');
    b.close();
  } finally { await srv.stop(); }
});

test('forged and tampered reconnect tokens are rejected', async () => {
  const srv = await startServer({});
  try {
    const host = await connect(srv.port); await hello(host);
    host.send({ t: 'create', roomName: 'Sec', public: false, seed: 21 });
    const real = (await host.next('welcome')).token;

    // forged (not signed by us)
    const f = await connect(srv.port); await hello(f);
    f.send({ t: 'rejoin', token: 'totally.fake' });
    assert.match((await f.next('err')).reason, /expired|not found|session/i);
    f.close();

    // tampered payload (signature no longer matches)
    const bad = real.slice(0, 4) + (real[4] === 'A' ? 'B' : 'A') + real.slice(5);
    const t = await connect(srv.port); await hello(t);
    t.send({ t: 'rejoin', token: bad });
    assert.match((await t.next('err')).reason, /expired|not found|session/i);
    t.close();
    host.close();
  } finally { await srv.stop(); }
});

test('an expired reconnect token is rejected', async () => {
  const srv = await startServer({ RECONNECT_TTL_MIN: '0' });   // tokens expire immediately
  try {
    const host = await connect(srv.port); await hello(host);
    host.send({ t: 'create', roomName: 'Exp', public: false, seed: 22 });
    const token = (await host.next('welcome')).token;
    await new Promise((r) => setTimeout(r, 40));               // let exp pass

    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'rejoin', token });
    assert.match((await c.next('err')).reason, /expired|session/i);
    c.close(); host.close();
  } finally { await srv.stop(); }
});
