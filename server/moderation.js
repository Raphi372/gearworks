'use strict';
/* ==========================================================================
   moderation.js — account bans (Phase 3).

   A small, additive moderation surface: an admin (listed in ADMIN_USERS) can
   ban an account by username, optionally for a number of days, or lift a ban.
   Bans persist through the store (file: bans.json | Postgres: Ban table) and
   are enforced SERVER-SIDE at login and session resume (see players/accounts.js)
   — the client is never trusted to know it's banned. Issuing a ban also bumps
   the target's tokenVersion, so any live session is invalidated immediately.

   Admins are configured by ADMIN_USERS (comma-separated usernames), so the $0
   single-instance deploy has no admins and this module is a no-op by default.
   ========================================================================== */
function createModeration(config, store) {
  const admins = config.ADMIN_USERS || [];
  function isAdmin(username) { return !!username && admins.indexOf(String(username).toLowerCase()) >= 0; }

  // the active ban on an account, or null — the single enforcement primitive
  async function check(accountId) {
    if (!accountId || !store.getBan) return null;
    return store.getBan(accountId).catch(() => null);
  }

  async function ban(byUsername, targetUsername, reason, days) {
    if (!isAdmin(byUsername)) return { error: 'not authorized' };
    if (!store.banAccount) return { error: 'moderation unavailable' };
    const target = await store.getAccountByName(String(targetUsername || '').trim()).catch(() => null);
    if (!target) return { error: 'no player with that name' };
    if (isAdmin(target.username)) return { error: 'cannot ban an admin' };
    const d = Math.max(0, Math.min(3650, days | 0));   // 0 = permanent, capped at ~10y
    const until = d > 0 ? Date.now() + d * 86400000 : 0;
    await store.banAccount(target.id, { reason: String(reason || '').slice(0, 200), by: byUsername, at: Date.now(), until });
    // invalidate every existing session for the banned account (immediate effect)
    if (store.updateAccount) {
      const acct = await store.getAccount(target.id).catch(() => null);
      if (acct) await store.updateAccount(target.id, { tokenVersion: (acct.tokenVersion || 0) + 1 }).catch(() => {});
    }
    return { ok: true };
  }

  async function unban(byUsername, targetUsername) {
    if (!isAdmin(byUsername)) return { error: 'not authorized' };
    if (!store.unbanAccount) return { error: 'moderation unavailable' };
    const target = await store.getAccountByName(String(targetUsername || '').trim()).catch(() => null);
    if (!target) return { error: 'no player with that name' };
    await store.unbanAccount(target.id);
    return { ok: true };
  }

  async function list(byUsername) {
    if (!isAdmin(byUsername)) return { error: 'not authorized' };
    const bans = store.listBans ? await store.listBans().catch(() => []) : [];
    return { bans };
  }

  return { isAdmin, check, ban, unban, list };
}

module.exports = { createModeration };
