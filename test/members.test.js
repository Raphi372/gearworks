'use strict';
/* Integration: persistent world membership (P1.1 — WorldMember).
   - a world records everyone who plays it; "My Worlds" lists owned + joined
     worlds and distinguishes the two,
   - a recorded member may revive a dormant private world; a stranger may not,
   - a promoted member's role is carried forward across a real server restart. */
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
async function register(port, username) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username, password: 'pw12345678' });
  assert.ok((await c.next('auth')).ok, 'registered ' + username);
  return c;
}
async function login(port, username) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'login', username, password: 'pw12345678' });
  assert.ok((await c.next('auth')).ok, 'logged in ' + username);
  return c;
}
async function myWorlds(c) { c.send({ t: 'myWorlds' }); return (await c.next('myWorlds')).worlds; }
// force a durable save while the host is still connected (deterministic — no
// reliance on idle-eviction or host-migration timing)
async function hostSave(host) { host.send({ t: 'save' }); await host.next('saved'); }

test('a world records its members; My Worlds distinguishes owner from member', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mem-'));
  const AUTH_SECRET = 'members-fixed-secret';
  const ownName = uniq('own'), memName = uniq('mem');
  try {
    const s1 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET });
    // owner creates a private world
    const owner = await register(s1.port, ownName);
    owner.send({ t: 'create', roomName: 'Camp', public: false, seed: 30 });
    const code = (await owner.next('welcome')).code;
    // a second account joins it by code — becomes a recorded member (player)
    const member = await register(s1.port, memName);
    member.send({ t: 'join', code });
    assert.strictEqual((await member.next('welcome')).role, 'player');
    member.close();                 // leaves as a player (no host migration)
    await hostSave(owner);          // persist membership while the owner hosts
    owner.close();
    await s1.stop();

    // fresh server, same save dir + secret — membership survives
    const s2 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET, RESTORE_ON_BOOT: '0' });
    const o2 = await login(s2.port, ownName);
    const ow = (await myWorlds(o2)).find((w) => w.code === code);
    assert.ok(ow, 'owner sees the world');
    assert.strictEqual(ow.owner, true, 'flagged as owner');

    const m2 = await login(s2.port, memName);
    const mw = (await myWorlds(m2)).find((w) => w.code === code);
    assert.ok(mw, 'member sees the world they played');
    assert.strictEqual(mw.owner, false, 'not flagged as owner');
    assert.strictEqual(mw.role, 'player', 'recorded role surfaced');
    o2.close(); m2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});

test('a recorded member can revive a dormant private world; a stranger cannot', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mem2-'));
  const AUTH_SECRET = 'members2-fixed-secret';
  const ownName = uniq('own'), memName = uniq('mem'), strName = uniq('str');
  try {
    const s1 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET });
    const owner = await register(s1.port, ownName);
    owner.send({ t: 'create', roomName: 'Vault', public: false, seed: 31 });
    const code = (await owner.next('welcome')).code;
    const member = await register(s1.port, memName);
    member.send({ t: 'join', code }); await member.next('welcome');
    member.close();
    // register the stranger now so the account exists, but it never joins
    (await register(s1.port, strName)).close();
    await hostSave(owner);
    owner.close();
    await s1.stop();

    // dormant world (RESTORE_ON_BOOT off): resume goes through the disk-access gate
    const s2 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET, RESTORE_ON_BOOT: '0' });
    // a stranger cannot revive someone else's private world
    const stranger = await login(s2.port, strName);
    stranger.send({ t: 'resume', code });
    assert.match((await stranger.next('err')).reason, /belongs to another player/i);
    stranger.close();
    // an anonymous connection cannot either
    const anon = await connect(s2.port); await hello(anon);
    anon.send({ t: 'resume', code });
    assert.match((await anon.next('err')).reason, /belongs to another player/i);
    anon.close();
    // the recorded member can
    const member2 = await login(s2.port, memName);
    member2.send({ t: 'resume', code });
    assert.strictEqual((await member2.next('welcome')).code, code, 'member revived the world');
    member2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});

test("a promoted member's admin role is carried forward across a restart", async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mem3-'));
  const AUTH_SECRET = 'members3-fixed-secret';
  const ownName = uniq('own'), memName = uniq('mem');
  try {
    const s1 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET });
    const owner = await register(s1.port, ownName);
    owner.send({ t: 'create', roomName: 'Fort', public: false, seed: 32 });
    const code = (await owner.next('welcome')).code;
    const member = await register(s1.port, memName);
    member.send({ t: 'join', code });
    const memberId = (await member.next('welcome')).id;
    // owner (host) promotes the member to admin
    owner.send({ t: 'adm', op: 'role', id: memberId, role: 'admin' });
    assert.strictEqual((await member.next('prole')).role, 'admin', 'promoted to admin');
    member.close();
    await hostSave(owner);          // persist the admin role
    owner.close();
    await s1.stop();

    // restart restores the room live with members carried forward
    const s2 = await startServer({ SAVE_DIR: saveDir, AUTH_SECRET });
    const member2 = await login(s2.port, memName);
    member2.send({ t: 'join', code });
    assert.strictEqual((await member2.next('welcome', 4000)).role, 'admin', 'admin role restored');
    member2.close();
    await s2.stop();
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});
