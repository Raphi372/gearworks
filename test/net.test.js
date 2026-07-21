'use strict';
/* Integration: transport, room lifecycle, command authority, determinism over
   the wire, and reconnect — all against the real authoritative server. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Core = require('../shared/core.js');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

async function hello(c, extra = {}) {
  c.send(Object.assign({ t: 'hello', proto: 1, name: 'P', color: '#4aa3ff', gz: false }, extra));
  return c.next('lobby');
}
async function createRoom(c, opts = {}) {
  await hello(c);
  c.send(Object.assign({ t: 'create', roomName: 'T', public: false }, opts));
  return c.next('welcome');
}
// find an iron patch deterministically for a seed (mirrors scripts/test.js)
function findIron(g) {
  for (let r = 2; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let ore = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const t = g.World.tileAt(dx + x, dy + y); if (t.r === 'iron' && t.amt > 0) ore++; }
    if (ore >= 3 && !g.World.tileAt(dx, dy).water) return [dx, dy];
  }
  throw new Error('no iron patch found');
}

test('handshake + hello returns a lobby with the public room list', async () => {
  const c = await connect(srv.port);
  const lobby = await hello(c);
  assert.strictEqual(lobby.proto, 1);
  assert.ok(Array.isArray(lobby.rooms));
  c.close();
});

test('create → welcome as host with an invite code', async () => {
  const c = await connect(srv.port);
  const w = await createRoom(c, { seed: 111 });
  assert.strictEqual(w.role, 'host');
  assert.match(w.code, /^[A-Z0-9]{6}$/);
  assert.ok(Number.isInteger(w.id));
  c.close();
});

test('a second client joins as player; a third as spectator', async () => {
  const host = await connect(srv.port);
  const { code } = await createRoom(host, { seed: 222 });

  const player = await connect(srv.port);
  await hello(player);
  player.send({ t: 'join', code });
  assert.strictEqual((await player.next('welcome')).role, 'player');

  const spec = await connect(srv.port);
  await hello(spec);
  spec.send({ t: 'join', code, spectate: true });
  assert.strictEqual((await spec.next('welcome')).role, 'spectator');

  host.close(); player.close(); spec.close();
});

test('a full room rejects further players', async () => {
  const host = await connect(srv.port);
  const { code } = await createRoom(host, { seed: 333, maxPlayers: 2 });
  const p2 = await connect(srv.port);
  await hello(p2); p2.send({ t: 'join', code });
  assert.strictEqual((await p2.next('welcome')).role, 'player');   // seats now 2/2
  const p3 = await connect(srv.port);
  await hello(p3); p3.send({ t: 'join', code });
  assert.match((await p3.next('err')).reason, /full/i);
  host.close(); p2.close(); p3.close();
});

test('a valid command is applied and broadcast to every client', async () => {
  const host = await connect(srv.port);
  const { code } = await createRoom(host, { seed: 444 });
  const g = Core.createGame({ seed: 444 });
  const [x, y] = findIron(g);

  const player = await connect(srv.port);
  await hello(player); player.send({ t: 'join', code });
  await player.next('welcome');

  host.send({ t: 'cmd', q: 1, cmd: { t: 'place', type: 'miner', x, y, rot: 1 } });
  const isPlace = (m) => m.t === 'tk' && Array.isArray(m.c) && m.c.some((cc) => cc.t === 'place' && cc.type === 'miner');
  const tkHost = await host.next(isPlace, 4000);
  const tkPeer = await player.next(isPlace, 4000);
  assert.ok(tkHost && tkPeer, 'both clients received the placement tick');
  host.close(); player.close();
});

test('the server stamps issuer identity — a spoofed _p is overridden', async () => {
  const host = await connect(srv.port);
  const w = await createRoom(host, { seed: 555 });
  const g = Core.createGame({ seed: 555 });
  const [x, y] = findIron(g);
  host.send({ t: 'cmd', q: 1, cmd: { t: 'place', type: 'miner', x, y, rot: 1, _p: 999999 } });
  const tk = await host.next((m) => m.t === 'tk' && m.c.some((cc) => cc.t === 'place'), 4000);
  const place = tk.c.find((cc) => cc.t === 'place');
  assert.strictEqual(place._p, w.id, 'issuer is the real player id');
  assert.notStrictEqual(place._p, 999999, 'spoofed issuer was discarded');
  host.close();
});

test('invalid, server-only, and admin-gated commands are rejected', async () => {
  const host = await connect(srv.port);
  const { code } = await createRoom(host, { seed: 666 });

  // tech-locked build (assembler at tier 0) → rejected by validation
  host.send({ t: 'cmd', q: 10, cmd: { t: 'place', type: 'assembler', x: 0, y: 0, rot: 0 } });
  assert.strictEqual((await host.next('rej')).q, 10);

  // server-only command from a client → rejected by the permission gate
  host.send({ t: 'cmd', q: 11, cmd: { t: 'ai', ops: [] } });
  assert.match((await host.next((m) => m.t === 'rej' && m.q === 11)).reason, /server-only/i);

  // admin-gated command from a plain player → rejected
  const player = await connect(srv.port);
  await hello(player); player.send({ t: 'join', code }); await player.next('welcome');
  player.send({ t: 'cmd', q: 12, cmd: { t: 'setWeather', weather: 'rain' } });
  assert.match((await player.next((m) => m.t === 'rej' && m.q === 12)).reason, /admin/i);

  host.close(); player.close();
});

test('a client mirroring the wire converges to the server state hash (determinism)', async () => {
  const c = await connect(srv.port);
  await hello(c);
  c.send({ t: 'create', roomName: 'D', public: false, seed: 4242 });
  const snap = await c.next('snap', 4000);
  await c.next('welcome');
  assert.ok(snap.raw, 'server sent a raw snapshot (gz negotiated off)');

  const g = Core.createGame({ seed: snap.raw.seed });
  g.Snapshot.restore(snap.raw);
  const [x, y] = findIron(g);
  c.send({ t: 'cmd', q: 1, cmd: { t: 'place', type: 'miner', x, y, rot: 1 } });

  // apply every tick/heartbeat the server sends; at the first authoritative
  // hash for a tick we've reached, our independently-simulated hash must match.
  let compared = false;
  for (let i = 0; i < 300 && !compared; i++) {
    const m = await c.next((x) => x.t === 'tk' || x.t === 'tks' || x.t === 'hash', 4000);
    if (m.t === 'hash') {
      if (g.S.tick === m.n) { assert.strictEqual(g.stateHash(), m.h, 'mirror hash matches server @tick ' + m.n); compared = true; }
    } else {
      if (m.n <= g.S.tick) continue;
      while (g.S.tick < m.n - 1) g.tickOnce(null);
      g.tickOnce(m.t === 'tk' ? m.c : null);
    }
  }
  assert.ok(compared, 'compared at least one authoritative hash');
  c.close();
});

test('a dropped client can rejoin its seat with its session token', async () => {
  const host = await connect(srv.port);
  const { code } = await createRoom(host, { seed: 777 });     // host keeps the room alive
  const player = await connect(srv.port);
  await hello(player); player.send({ t: 'join', code });
  const token = (await player.next('welcome')).token;

  player.close();                                             // unexpected drop
  await new Promise((r) => setTimeout(r, 200));               // let the server process it

  const back = await connect(srv.port);
  back.send({ t: 'hello', proto: 1, gz: false });
  await back.next('lobby');
  back.send({ t: 'rejoin', token });
  const w = await back.next('welcome', 4000);
  assert.strictEqual(w.role, 'player', 'resumed the same role');
  assert.strictEqual(w.code, code, 'resumed the same room');
  host.close(); back.close();
});
