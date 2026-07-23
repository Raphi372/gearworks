'use strict';
/* Quickplay matchmaking (Phase 2, slice 4).
   The lobby's `quickplay` finds a public room with a free seat, else tells the
   client to host one; private and full rooms are never matched. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }

test('quickplay matches a joinable public room, else says to create one', async () => {
  const srv = await startServer({});
  try {
    // no rooms yet → create your own
    const c0 = await connect(srv.port); await hello(c0);
    c0.send({ t: 'quickplay' });
    assert.strictEqual((await c0.next('quickplay')).create, true, 'no rooms → create');
    c0.close();

    // host a public room with room for 2
    const host = await connect(srv.port); await hello(host);
    host.send({ t: 'create', roomName: 'QP', public: true, maxPlayers: 2, seed: 95 });
    const code = (await host.next('welcome')).code;

    // a fresh player is matched into it
    const c2 = await connect(srv.port); await hello(c2);
    c2.send({ t: 'quickplay' });
    assert.strictEqual((await c2.next('quickplay')).code, code, 'matched the open public room');
    // …and joins, filling it to 2/2
    c2.send({ t: 'join', code }); await c2.next('welcome');

    // now the only public room is full → next quickplay says create
    const c3 = await connect(srv.port); await hello(c3);
    c3.send({ t: 'quickplay' });
    assert.strictEqual((await c3.next('quickplay')).create, true, 'full room → create');
    c3.close();

    // a private room is never matched
    const priv = await connect(srv.port); await hello(priv);
    priv.send({ t: 'create', roomName: 'Secret', public: false, seed: 96 });
    await priv.next('welcome');
    const c4 = await connect(srv.port); await hello(c4);
    c4.send({ t: 'quickplay' });
    assert.strictEqual((await c4.next('quickplay')).create, true, 'private rooms are not matched');

    host.close(); c2.close(); priv.close(); c4.close();
  } finally { await srv.stop(); }
});

test('quickplay prefers the fuller room so players congregate', async () => {
  const srv = await startServer({});
  try {
    // two open public rooms; one already has a second player
    const h1 = await connect(srv.port); await hello(h1);
    h1.send({ t: 'create', roomName: 'A', public: true, maxPlayers: 8, seed: 97 });
    const codeA = (await h1.next('welcome')).code;
    const h2 = await connect(srv.port); await hello(h2);
    h2.send({ t: 'create', roomName: 'B', public: true, maxPlayers: 8, seed: 98 });
    const codeB = (await h2.next('welcome')).code;
    // add a second player to A so it's fuller
    const a2 = await connect(srv.port); await hello(a2);
    a2.send({ t: 'join', code: codeA }); await a2.next('welcome');

    const cq = await connect(srv.port); await hello(cq);
    cq.send({ t: 'quickplay' });
    assert.strictEqual((await cq.next('quickplay')).code, codeA, 'matched into the fuller room');
    void codeB;
    h1.close(); h2.close(); a2.close(); cq.close();
  } finally { await srv.stop(); }
});
