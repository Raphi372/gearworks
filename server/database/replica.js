'use strict';
/* ==========================================================================
   database/replica.js — read/write client routing for a Postgres primary +
   optional read replica (Phase 3, [DB-9]).

   Scaling reads is the easy win at the database tier — but a read replica is
   *eventually* consistent, so a query served from it may be stale. The load-
   bearing safety rule is:

     • WRITES              → always the primary.
     • AUTHORIZATION reads → always the primary. A membership/ban/account check
       served from a lagging replica could grant access that was just revoked
       (or seat a just-banned player), so these MUST be strongly consistent.
     • LISTING / analytics reads (leaderboard, "my worlds", stats history) →
       the replica when one exists, else the primary. These tolerate a little
       lag; a leaderboard a few seconds behind is fine.

   `createRouting` returns the client to use for each class. With no replica it
   collapses to the primary for everything — the single-database deploy is
   unchanged. The classification lives here (pure, testable) so the store just
   asks for `read`/`authz`/`write` and can never accidentally serve an authz
   query off the replica.
   ========================================================================== */
function createRouting(primary, replica) {
  if (!primary) throw new Error('createRouting requires a primary client');
  const hasReplica = !!replica && replica !== primary;
  return {
    hasReplica,
    write: primary,                        // never a replica
    authz: primary,                        // [DB-9] never a replica — strong consistency
    read: hasReplica ? replica : primary,  // lag-tolerant listings/analytics
  };
}

module.exports = { createRouting };
