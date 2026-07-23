'use strict';
/* Social graph — friends / requests / blocking (Phase 2, slice 1).
   - the friendship state machine on the file backend,
   - end-to-end over the lobby: request → incoming → accept → friends. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFileStore } = require('../server/database/fileStore');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quiet() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
const ids = (list) => list.map((x) => x.id).sort();

test('the friendship state machine: request, accept, remove, auto-accept, block', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-soc-'));
  try {
    const store = createFileStore({ SAVE_DIR: dir, BACKUPS: 3, log: quiet() });
    await store.createAccount({ id: 'a1', username: 'alice', color: '#fff' });
    await store.createAccount({ id: 'a2', username: 'bob', color: '#fff' });

    // request a1 -> a2
    assert.ok((await store.friendRequest('a1', 'a2')).ok);
    assert.deepStrictEqual(ids((await store.friendGraph('a1')).outgoing), ['a2']);
    const gb = await store.friendGraph('a2');
    assert.deepStrictEqual(ids(gb.incoming), ['a1']);
    assert.strictEqual(gb.incoming[0].username, 'alice', 'usernames resolved');

    // accept
    assert.ok((await store.friendRespond('a2', 'a1', true)).ok);
    assert.deepStrictEqual(ids((await store.friendGraph('a1')).friends), ['a2']);
    assert.deepStrictEqual(ids((await store.friendGraph('a2')).friends), ['a1']);
    assert.strictEqual((await store.friendGraph('a1')).outgoing.length, 0, 'pending cleared');

    // remove
    await store.friendRemove('a1', 'a2');
    assert.strictEqual((await store.friendGraph('a1')).friends.length, 0);
    assert.strictEqual((await store.friendGraph('a2')).friends.length, 0);

    // mutual requests auto-accept
    await store.friendRequest('a1', 'a2');
    await store.friendRequest('a2', 'a1');
    assert.deepStrictEqual(ids((await store.friendGraph('a1')).friends), ['a2']);

    // block removes the friendship and prevents new requests
    await store.friendBlock('a1', 'a2', true);
    assert.strictEqual((await store.friendGraph('a1')).friends.length, 0);
    assert.deepStrictEqual(ids((await store.friendGraph('a1')).blocked), ['a2']);
    assert.ok((await store.friendRequest('a2', 'a1')).error, 'blocked user cannot re-request');
    await store.friendBlock('a1', 'a2', false);     // unblock
    assert.ok((await store.friendRequest('a2', 'a1')).ok, 'request works again after unblock');

    // can't befriend yourself
    assert.ok((await store.friendRequest('a1', 'a1')).error);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('friends over the lobby: request → incoming → accept', async () => {
  const srv = await startServer({});
  try {
    const aliceName = uniq('alice'), bobName = uniq('bob');
    const ca = await connect(srv.port); await hello(ca);
    ca.send({ t: 'auth', mode: 'register', username: aliceName, password: 'pw12345678' });
    const aliceId = (await ca.next('auth')).account.id;

    // requesting a non-existent user reports an error (no graph mutation)
    ca.send({ t: 'friendReq', username: 'ghost_' + bobName });
    assert.match((await ca.next('friends')).error, /no player/i);

    const cb = await connect(srv.port); await hello(cb);
    cb.send({ t: 'auth', mode: 'register', username: bobName, password: 'pw12345678' });
    await cb.next('auth');

    // alice requests bob
    ca.send({ t: 'friendReq', username: bobName });
    const ga = await ca.next('friends');
    assert.strictEqual(ga.error, null);
    assert.strictEqual(ga.graph.outgoing.length, 1, 'alice has an outgoing request');

    // bob sees the incoming request and accepts it
    cb.send({ t: 'friends' });
    const gb = await cb.next('friends');
    assert.strictEqual(gb.graph.incoming.length, 1);
    assert.strictEqual(gb.graph.incoming[0].id, aliceId);
    cb.send({ t: 'friendResp', id: aliceId, accept: true });
    assert.strictEqual((await cb.next('friends')).graph.friends[0].id, aliceId, 'now friends');

    // and alice sees bob as a friend
    ca.send({ t: 'friends' });
    assert.strictEqual((await ca.next('friends')).graph.friends.length, 1);

    // signed-out connection gets no graph
    const anon = await connect(srv.port); await hello(anon);
    anon.send({ t: 'friends' });
    assert.strictEqual((await anon.next('friends')).graph, null);
    ca.close(); cb.close(); anon.close();
  } finally { await srv.stop(); }
});
