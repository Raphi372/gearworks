'use strict';
/* World invites (Phase 2, slice 3).
   - the invite module (create/get/listFor/remove, TTL, shared file),
   - end-to-end over the lobby: a friend invites you into their world; you list
     it and accept → you get the code to join; authz (friends-only, access). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createInvites } = require('../server/invites');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
function quiet() { const l = () => {}; l.warn = () => {}; l.error = () => {}; return l; }
async function hello(c, extra = {}) { c.send(Object.assign({ t: 'hello', proto: 1, name: 'Ada', gz: false }, extra)); return c.next('lobby'); }
const cfg = (extra) => Object.assign({ SAVE_DIR: os.tmpdir(), log: quiet(), INVITES: 'local', INVITE_TTL_MS: 3600000 }, extra);
async function register(port, username) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username, password: 'pw12345678' });
  return { c, id: (await c.next('auth')).account.id, username };
}

test('the invite module: create / get / listFor / remove, TTL, shared file', () => {
  const inv = createInvites(cfg({}));
  const i = inv.create('a1', 'alice', 'a2', 'CODE01', 'My World');
  assert.ok(i && i.id && i.to === 'a2' && i.code === 'CODE01');
  assert.strictEqual(inv.get(i.id).name, 'My World');
  assert.strictEqual(inv.listFor('a2').length, 1);
  assert.strictEqual(inv.listFor('a3').length, 0, 'only the recipient sees it');
  inv.remove(i.id);
  assert.strictEqual(inv.get(i.id), null);
  assert.strictEqual(inv.create('a1', 'a', 'a1', 'C', 'n'), null, 'no self-invite');

  // expiry
  const inv2 = createInvites(cfg({ INVITE_TTL_MS: -1 }));
  const j = inv2.create('a1', 'a', 'a2', 'C', 'n');
  assert.strictEqual(inv2.get(j.id), null, 'expired invite is gone');
  assert.strictEqual(inv2.listFor('a2').length, 0);

  // shared file backend
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-inv-'));
  try {
    createInvites(cfg({ INVITES: 'file', INVITE_DIR: dir })).create('x', 'x', 'y', 'ROOM', 'n');
    assert.strictEqual(createInvites(cfg({ INVITES: 'file', INVITE_DIR: dir })).listFor('y').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a friend invites you into their world; you accept and get the code', async () => {
  const srv = await startServer({});
  try {
    const alice = await register(srv.port, uniq('alice'));
    const bob = await register(srv.port, uniq('bob'));
    // become friends (mutual auto-accept)
    alice.c.send({ t: 'friendReq', username: bob.username }); await alice.c.next('friends');
    bob.c.send({ t: 'friendReq', username: alice.username }); await bob.c.next('friends');

    // alice hosts a world and invites bob into it
    alice.c.send({ t: 'create', roomName: 'Co-op Base', public: false, seed: 91 });
    const code = (await alice.c.next('welcome')).code;
    alice.c.send({ t: 'invite', to: bob.id, code });
    assert.ok((await alice.c.next('invited')).ok, 'invite sent');

    // bob sees the pending invite
    bob.c.send({ t: 'invites' });
    const list = (await bob.c.next('invites')).invites;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].code, code);
    assert.strictEqual(list[0].fromName, alice.username);
    assert.strictEqual(list[0].name, 'Co-op Base');

    // bob accepts → gets the code to join; the invite is consumed
    bob.c.send({ t: 'inviteAccept', id: list[0].id });
    assert.strictEqual((await bob.c.next('inviteAccepted')).code, code);
    bob.c.send({ t: 'invites' });
    assert.strictEqual((await bob.c.next('invites')).invites.length, 0, 'invite consumed');

    // authz: can't invite a non-friend
    const carol = await register(srv.port, uniq('carol'));
    alice.c.send({ t: 'invite', to: carol.id, code });
    assert.match((await alice.c.next('invited')).error, /friend/i);
    // authz: can't invite to a world you have no access to
    alice.c.send({ t: 'invite', to: bob.id, code: 'ZZZ999' });
    assert.match((await alice.c.next('invited')).error, /access/i);

    alice.c.close(); bob.c.close(); carol.c.close();
  } finally { await srv.stop(); }
});
