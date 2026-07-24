'use strict';
/* Unit: read/write client routing for a Postgres primary + optional replica
   ([DB-9]). The load-bearing invariant is that authorization reads and all
   writes NEVER touch the replica, so replica lag can't corrupt access control. */
const { test } = require('node:test');
const assert = require('node:assert');
const { createRouting } = require('../server/database/replica');

// distinct sentinels stand in for the two Prisma clients
const primary = { id: 'primary' };
const replica = { id: 'replica' };

test('with a replica, only lag-tolerant reads route to it', () => {
  const db = createRouting(primary, replica);
  assert.strictEqual(db.hasReplica, true);
  assert.strictEqual(db.read, replica, 'listing/leaderboard reads use the replica');
  assert.strictEqual(db.authz, primary, 'authorization reads stay on the primary ([DB-9])');
  assert.strictEqual(db.write, primary, 'writes stay on the primary');
});

test('with no replica, everything collapses to the primary', () => {
  const db = createRouting(primary, null);
  assert.strictEqual(db.hasReplica, false);
  assert.strictEqual(db.read, primary);
  assert.strictEqual(db.authz, primary);
  assert.strictEqual(db.write, primary);
});

test('a replica that is the same object as the primary is treated as none', () => {
  const db = createRouting(primary, primary);
  assert.strictEqual(db.hasReplica, false, 'same client is not a real replica');
  assert.strictEqual(db.read, primary);
});

test('authz and write are never the replica, regardless of configuration', () => {
  for (const r of [null, primary, replica]) {
    const db = createRouting(primary, r);
    assert.notStrictEqual(db.authz, replica, 'authz is never the replica');
    assert.notStrictEqual(db.write, replica, 'write is never the replica');
  }
});

test('a missing primary is a hard error', () => {
  assert.throws(() => createRouting(null, replica), /requires a primary/);
});
