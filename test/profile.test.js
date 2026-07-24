'use strict';
/* Integration: the profile + cosmetics locker. Bio and equipped loadout are
   persisted per-account; cosmetic ownership is derived, so the server clamps an
   equip request to what the account has actually earned. File backend; a
   Postgres case runs when TEST_DATABASE_URL is set. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers/server');
const { connect } = require('./helpers/wsClient');

const uniq = (p) => p + crypto.randomBytes(3).toString('hex');
async function hello(c) { c.send({ t: 'hello', proto: 1, name: 'P', gz: false }); return c.next('lobby'); }
async function register(port, name) {
  const c = await connect(port); await hello(c);
  c.send({ t: 'auth', mode: 'register', username: name, password: 'pw12345678' });
  const id = (await c.next('auth')).account.id;
  return { c, id, name };
}

function suite(label, env) {
  test(`[${label}] my locker: default profile, bio persists, equip is clamped to owned`, async () => {
    const srv = await startServer(env);
    try {
      const a = await register(srv.port, uniq('prof'));

      // fresh profile: empty bio, empty loadout, and a catalog I can equip from
      a.c.send({ t: 'profile' });
      let r = await a.c.next('profile');
      assert.strictEqual(r.mine, true);
      assert.strictEqual(r.profile.bio, '');
      assert.deepStrictEqual(r.profile.loadout, { nameplate: null, title: null });
      assert.ok(Array.isArray(r.profile.catalog) && r.profile.catalog.length, 'own locker carries the catalog');
      // a new account owns only the default nameplate; everything else is locked
      assert.strictEqual(r.profile.catalog.find((c) => c.key === 'plate_steel').unlocked, true);
      assert.strictEqual(r.profile.catalog.find((c) => c.key === 'plate_gold').unlocked, false);

      // set a bio and equip the OWNED default nameplate — both take
      a.c.send({ t: 'setProfile', bio: 'i make gears', equipped: { nameplate: 'plate_steel' } });
      r = await a.c.next('profile');
      assert.strictEqual(r.profile.bio, 'i make gears');
      assert.strictEqual(r.profile.loadout.nameplate, '#9fb2c8', 'owned nameplate equipped');

      // try to equip a NOT-owned cosmetic — the server drops it (untrusted client)
      a.c.send({ t: 'setProfile', equipped: { nameplate: 'plate_gold', title: 'title_tycoon' } });
      r = await a.c.next('profile');
      assert.deepStrictEqual(r.profile.loadout, { nameplate: null, title: null }, 'unowned equip rejected');
      assert.strictEqual(r.profile.bio, 'i make gears', 'bio untouched when only equipped is sent');

      // persistence: a fresh login for the same account sees the saved bio
      const c2 = await connect(srv.port); await hello(c2);
      c2.send({ t: 'auth', mode: 'login', username: a.name, password: 'pw12345678' });
      await c2.next('auth');
      c2.send({ t: 'profile' });
      assert.strictEqual((await c2.next('profile')).profile.bio, 'i make gears', 'bio persisted across sessions');

      a.c.close(); c2.close();
    } finally { await srv.stop(); }
  });

  test(`[${label}] another player's public profile: bio + loadout, but no locker`, async () => {
    const srv = await startServer(env);
    try {
      const a = await register(srv.port, uniq('me'));
      const b = await register(srv.port, uniq('them'));
      b.c.send({ t: 'setProfile', bio: 'hello from b' }); await b.c.next('profile');

      a.c.send({ t: 'profile', username: b.name });
      const r = await a.c.next('profile');
      assert.strictEqual(r.mine, false);
      assert.strictEqual(r.profile.username, b.name.toLowerCase());
      assert.strictEqual(r.profile.bio, 'hello from b');
      assert.strictEqual(r.profile.catalog, undefined, 'public view never exposes the locker');

      a.c.close(); b.c.close();
    } finally { await srv.stop(); }
  });

  test(`[${label}] a signed-out client cannot write a profile`, async () => {
    const srv = await startServer(env);
    try {
      const anon = await connect(srv.port); await hello(anon);
      anon.send({ t: 'setProfile', bio: 'nope' });
      assert.strictEqual((await anon.next('profile')).profile, null, 'no account → no write');
      anon.close();
    } finally { await srv.stop(); }
  });
}

suite('file', {});
if (process.env.TEST_DATABASE_URL) {
  suite('postgres', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL });
} else {
  test('postgres profile (skipped — set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
}
