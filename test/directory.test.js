'use strict';
/* Room directory + connect-token handoff (Phase 1 — horizontal-scale foundation,
   docs/FUTURE_ARCHITECTURE.md §4.3/§5).
   - connect tokens sign/verify/expire like every other server token,
   - the directory resolves/lists/expires routes in both 'local' and shared 'file'
     mode, and two instances sharing a dir see each other's rooms,
   - single instance: /resolve issues a connect token the same instance accepts;
     a forged token is rejected,
   - two instances: a DIFFERENT instance resolves the owner's room and mints a
     connect token that the OWNER verifies and seats — the handoff gate. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createTokens } = require('../server/players/tokens');
const { createDirectory } = require('../server/world/directory');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quiet() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
function httpGet(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
  });
}
function dirCfg(extra) {
  return Object.assign({ log: quiet(), INSTANCE_ID: 'i', REGION: 'local', PUBLIC_URL: 'ws://i',
    DIRECTORY: 'local', DIRECTORY_DIR: '', DIRECTORY_STALE_MS: 0, SAVE_DIR: os.tmpdir() }, extra);
}

test('connect tokens sign, verify, and reject tamper/purpose/expiry', () => {
  const t = createTokens({ AUTH_SECRET: 'dir-secret' });
  const tok = t.sign('connect', { aid: 'acc1', room: 'ABC123', region: 'eu' }, 60000);
  const d = t.verify('connect', tok);
  assert.strictEqual(d.room, 'ABC123');
  assert.strictEqual(d.aid, 'acc1');
  assert.strictEqual(t.verify('reconnect', tok), null, 'wrong purpose rejected');
  const bad = tok.slice(0, 4) + (tok[4] === 'A' ? 'B' : 'A') + tok.slice(5);
  assert.strictEqual(t.verify('connect', bad), null, 'tamper rejected');
  const short = t.sign('connect', { room: 'X' }, -1000);   // already past
  assert.strictEqual(t.verify('connect', short), null, 'expired rejected');
});

test('directory resolves, lists, and expires routes (local + shared file)', async () => {
  // local backend
  const d = createDirectory(dirCfg({ INSTANCE_ID: 'i1', PUBLIC_URL: 'ws://i1' }));
  d.register('AAA111', { public: true, players: 2 });
  const r = d.resolve('AAA111');
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.url, 'ws://i1');
  assert.strictEqual(r.players, 2);
  assert.ok(d.list({ public: true }).some((x) => x.code === 'AAA111'));
  d.deregister('AAA111');
  assert.strictEqual(d.resolve('AAA111'), null);

  // shared 'file' backend: two instances, one directory dir
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dir-'));
  try {
    const a = createDirectory(dirCfg({ INSTANCE_ID: 'A', PUBLIC_URL: 'ws://A', DIRECTORY: 'file', DIRECTORY_DIR: shared }));
    const b = createDirectory(dirCfg({ INSTANCE_ID: 'B', PUBLIC_URL: 'ws://B', DIRECTORY: 'file', DIRECTORY_DIR: shared }));
    a.register('ROOMAA', { public: true, players: 1 });
    const viaB = b.resolve('ROOMAA');
    assert.ok(viaB && viaB.self === false && viaB.instanceId === 'A' && viaB.url === 'ws://A', 'B sees A\'s room as remote');
    assert.strictEqual(a.resolve('ROOMAA').self, true, 'A owns it');
    a.deregister('ROOMAA');
    assert.strictEqual(b.resolve('ROOMAA'), null, 'deregister removes the route everywhere');

    // staleness: a route not refreshed within STALE_MS is dead
    const s = createDirectory(dirCfg({ DIRECTORY: 'file', DIRECTORY_DIR: shared, DIRECTORY_STALE_MS: 1 }));
    s.register('OLD001', {});
    await sleep(15);
    assert.strictEqual(s.resolve('OLD001'), null, 'stale route fails closed');
  } finally { fs.rmSync(shared, { recursive: true, force: true }); }
});

test('single instance: /resolve issues a connect token it accepts; a forgery is rejected', async () => {
  const srv = await startServer({});
  try {
    const c1 = await connect(srv.port); await hello(c1);
    c1.send({ t: 'create', roomName: 'Router', public: true, seed: 70 });
    const code = (await c1.next('welcome')).code;

    const res = JSON.parse((await httpGet(srv.port, `/resolve?code=${code}`)).body);
    assert.strictEqual(res.self, true, 'local room resolves to this instance');
    assert.ok(res.connectToken, 'a connect token is issued');

    // join carrying the issued connect token → seated
    const c2 = await connect(srv.port); await hello(c2);
    c2.send({ t: 'join', code, connectToken: res.connectToken });
    assert.strictEqual((await c2.next('welcome')).code, code, 'valid connect token accepted');

    // join carrying a forged connect token → rejected
    const c3 = await connect(srv.port); await hello(c3);
    c3.send({ t: 'join', code, connectToken: 'forged.token' });
    assert.match((await c3.next('err')).reason, /invalid connect token/i);

    // an unknown code resolves to 404
    assert.strictEqual((await httpGet(srv.port, '/resolve?code=ZZZ999')).status, 404);
    c1.close(); c2.close(); c3.close();
  } finally { await srv.stop(); }
});

test('two instances: a peer resolves the owner\'s room and mints a token the owner accepts', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dir2-'));
  const AUTH_SECRET = 'handoff-shared-secret';
  const common = { AUTH_SECRET, DIRECTORY: 'file', DIRECTORY_DIR: shared, REGION: 'local' };
  const A = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-a' }));
  const B = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-b' }));
  try {
    // a client creates a room on instance A (A registers the route in the shared dir)
    const owner = await connect(A.port); await hello(owner);
    owner.send({ t: 'create', roomName: 'Cross', public: true, seed: 71 });
    const code = (await owner.next('welcome')).code;

    // instance B — which does NOT host the room — resolves it and issues a connect token
    const viaB = JSON.parse((await httpGet(B.port, `/resolve?code=${code}`)).body);
    assert.strictEqual(viaB.self, false, 'B knows the room lives elsewhere');
    assert.strictEqual(viaB.url, 'ws://instance-a', 'B routes to instance A');
    assert.ok(viaB.connectToken, 'B mints a connect token (shared AUTH_SECRET)');

    // the client opens the game WS to the OWNER (A) with B\'s token → A verifies + seats it
    const joiner = await connect(A.port); await hello(joiner);
    joiner.send({ t: 'join', code, connectToken: viaB.connectToken });
    const w = await joiner.next('welcome', 4000);
    assert.strictEqual(w.code, code, 'the owner accepted the peer-issued connect token');
    assert.strictEqual(w.role, 'player');

    // and A resolves its own room as local
    const viaA = JSON.parse((await httpGet(A.port, `/resolve?code=${code}`)).body);
    assert.strictEqual(viaA.self, true);
    owner.close(); joiner.close();
  } finally { await A.stop(); await B.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});

test('claim() is a compare-and-set placement guard against split-brain', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cas-'));
  try {
    const a = createDirectory(dirCfg({ INSTANCE_ID: 'A', PUBLIC_URL: 'ws://A', DIRECTORY: 'file', DIRECTORY_DIR: shared }));
    const b = createDirectory(dirCfg({ INSTANCE_ID: 'B', PUBLIC_URL: 'ws://B', DIRECTORY: 'file', DIRECTORY_DIR: shared }));
    assert.strictEqual(a.claim('DUP001', { public: true }), true, 'A wins the first claim');
    assert.strictEqual(b.claim('DUP001', { public: true }), false, 'B cannot claim a code A owns');
    assert.strictEqual(a.claim('DUP001', {}), true, 're-claiming our own code is fine');
    a.deregister('DUP001');
    assert.strictEqual(b.claim('DUP001', {}), true, 'B claims it once A releases');
    assert.strictEqual(b.ownedElsewhere('DUP001'), false, 'and B does not consider its own room foreign');

    // a dead (stale) owner can be taken over
    const s = createDirectory(dirCfg({ INSTANCE_ID: 'C', DIRECTORY: 'file', DIRECTORY_DIR: shared, DIRECTORY_STALE_MS: 1 }));
    s.claim('STALE1', {});
    await sleep(15);
    const t = createDirectory(dirCfg({ INSTANCE_ID: 'D', DIRECTORY: 'file', DIRECTORY_DIR: shared, DIRECTORY_STALE_MS: 1 }));
    assert.strictEqual(t.claim('STALE1', {}), true, 'a stale route can be taken over');
  } finally { fs.rmSync(shared, { recursive: true, force: true }); }
});

test('rejoin redirects to the owning instance when the room moved', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-redir-'));
  const AUTH_SECRET = 'redirect-shared-secret';
  const common = { AUTH_SECRET, DIRECTORY: 'file', DIRECTORY_DIR: shared, REGION: 'local' };
  const A = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-a' }));
  const B = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-b' }));
  try {
    // host a live room on A and capture its reconnect token
    const host = await connect(A.port); await hello(host);
    host.send({ t: 'create', roomName: 'Movable', public: true, seed: 74 });
    const w = await host.next('welcome');
    const reconnectToken = w.token;

    // a client that lands on B (wrong instance) is redirected to A, not rejected
    const c = await connect(B.port); await hello(c);
    c.send({ t: 'rejoin', token: reconnectToken });
    const red = await c.next((m) => m.t === 'redirect' || m.t === 'err', 4000);
    assert.strictEqual(red.t, 'redirect', 'redirected rather than refused');
    assert.strictEqual(red.url, 'ws://instance-a', 'to the owning instance');
    c.close();

    // and rejoining on A itself still works
    const c2 = await connect(A.port); await hello(c2);
    c2.send({ t: 'rejoin', token: reconnectToken });
    assert.strictEqual((await c2.next('welcome', 4000)).code, w.code, 'rejoined on the owner');
    host.close(); c2.close();
  } finally { await A.stop(); await B.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});

test('the lobby `resolve` message hands out a connect token the instance accepts', async () => {
  const srv = await startServer({});
  try {
    const host = await connect(srv.port); await hello(host);
    host.send({ t: 'create', roomName: 'Router2', public: true, seed: 72 });
    const code = (await host.next('welcome')).code;

    // a second client resolves over the lobby socket (CSP-safe control channel)
    const c = await connect(srv.port); await hello(c);
    c.send({ t: 'resolve', code });
    const r = await c.next('resolved');
    assert.strictEqual(r.self, true, 'single instance resolves to itself');
    assert.ok(r.connectToken, 'connect token issued over the socket');
    c.send({ t: 'join', code, connectToken: r.connectToken });
    assert.strictEqual((await c.next('welcome')).code, code, 'the resolve-issued token is accepted');
    host.close(); c.close();
  } finally { await srv.stop(); }
});

test('the public listing and lobby resolve span instances', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dir3-'));
  const AUTH_SECRET = 'agg-shared-secret';
  const common = { AUTH_SECRET, DIRECTORY: 'file', DIRECTORY_DIR: shared, REGION: 'eu' };
  const A = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-a' }));
  const B = await startServer(Object.assign({}, common, { PUBLIC_URL: 'ws://instance-b' }));
  try {
    const owner = await connect(A.port); await hello(owner);
    owner.send({ t: 'create', roomName: 'Shared World', public: true, seed: 73 });
    const code = (await owner.next('welcome')).code;

    // instance B's public listing includes A's room as a remote row
    const cB = await connect(B.port);
    const lob = await hello(cB);
    const row = (lob.rooms || []).find((x) => x.code === code);
    assert.ok(row, 'B lists the room hosted on A');
    assert.strictEqual(row.here, false, 'flagged as remote');
    assert.strictEqual(row.name, 'Shared World', 'remote name surfaced');
    assert.strictEqual(row.region, 'eu');

    // resolving it over B routes to A + a token A accepts
    cB.send({ t: 'resolve', code });
    const r = await cB.next('resolved');
    assert.strictEqual(r.self, false);
    assert.strictEqual(r.url, 'ws://instance-a');
    const joiner = await connect(A.port); await hello(joiner);
    joiner.send({ t: 'join', code, connectToken: r.connectToken });
    assert.strictEqual((await joiner.next('welcome', 4000)).code, code, 'routed join seated on A');
    owner.close(); cB.close(); joiner.close();
  } finally { await A.stop(); await B.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});
