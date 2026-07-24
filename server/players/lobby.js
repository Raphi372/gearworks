'use strict';
/* ==========================================================================
   players/lobby.js — pre-room connection handling (identity + session entry).

   A freshly upgraded WebSocket starts in "lobby scope". It can authenticate
   (register / login / guest / token), browse public games, list its own saved
   worlds, and create / join / resume / rejoin a room. Once it belongs to a
   room, further messages route to that Room.

   Authentication is OPTIONAL and additive: anonymous play still works exactly
   as before (create/join with an inline name), so nothing that relied on the
   pre-accounts flow breaks. Authenticated players get a persistent identity
   and ownership of the worlds they create.
   ========================================================================== */
const Core = require('../../shared/core.js');
const Progression = require('../../shared/progression.js');
const Achievements = require('../../shared/achievements.js');
const Cosmetics = require('../../shared/cosmetics.js');

function createLobby(config, registry, auth, store, tokens, metrics, directory, presence, invites, moderation) {
  // the account payload sent to the client, tagged with whether it's an admin
  // (so the client can show the moderation panel; the flag is never trusted).
  function outAcct(a) { return a ? Object.assign({}, a, { admin: !!(moderation && moderation.isAdmin(a.username)) }) : null; }
  return function handleConn(conn) {
    if (metrics) metrics.recordConnection();
    let client = null;    // set once inside a room
    let room = null;
    let account = null;   // authenticated identity, or null (anonymous)
    let hello = null;
    let entering = false; // guards the async create/join/resume window

    function goneOffline() { if (account && presence) presence.clear(account.id); }
    function wire() {
      conn.onclose = () => { goneOffline(); if (room && client) room.removePlayer(client, 'disconnected'); };
    }
    conn.onclose = goneOffline;
    // mark an authed player online while they sit in the lobby (in-room presence
    // is refreshed by the room's ping; TTL downgrades a silent/crashed client).
    function touchOnline() { if (account && presence && !room) presence.set(account.id, { status: 'online' }); }

    // identity used when joining: authenticated account (with id, for membership),
    // else the inline name
    function identity(m) {
      if (account) return { name: account.username, color: account.color, gz: (hello && hello.gz), aid: account.id };
      return { name: m.name || (hello && hello.name), color: m.color || (hello && hello.color), gz: (hello && hello.gz) };
    }
    // role a returning authed player gets in a live room: owner or a prior
    // admin/host member is restored to admin (never host — no host hijack).
    function restoredRole(r) {
      if (!account) return 'player';
      const mr = r.memberRole(account.id);
      return (account.id === r.ownerId || mr === 'admin' || mr === 'host') ? 'admin' : 'player';
    }
    // A connect token (docs/FUTURE_ARCHITECTURE.md §4.3) is the control plane's
    // signed proof that this client was routed here for this room. It is OPTIONAL
    // — the single-instance deploy never issues one, so its absence is fine — but
    // if present it MUST be valid for the code, so a forged/mismatched token is
    // rejected. Access/role checks still run on the instance regardless.
    function connectOk(m, code) {
      if (!m.connectToken) return true;
      const d = tokens.verify('connect', String(m.connectToken));
      return !!(d && d.room === code);
    }

    async function enterRoom(fn) {
      if (room || entering) return;
      entering = true;
      try { await fn(); } finally { entering = false; }
    }

    conn.onmessage = async (m) => {
      if (!m || typeof m.t !== 'string') return;
      touchOnline();
      switch (m.t) {
        case 'hello': {
          hello = { name: m.name, color: m.color, gz: m.gz };
          if (m.proto !== Core.PROTO) return conn.send({ t: 'err', reason: 'protocol version mismatch — refresh the page' });
          if (m.authToken) account = await auth.fromToken(m.authToken);   // silent auto-login
          touchOnline();
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms(),
            account: outAcct(account), maintenance: config.MAINTENANCE, region: config.REGION });
          return;
        }
        case 'auth': {
          // recovery flows establish no session and are handled up front
          if (m.mode === 'requestReset') {
            await auth.requestReset({ emailOrUsername: m.emailOrUsername || m.email || m.username });
            return conn.send({ t: 'auth', ok: true, mode: 'requestReset' });   // always ok (no account enumeration)
          }
          if (m.mode === 'resetPassword') {
            const r = await auth.resetPassword({ token: m.token, password: m.password });
            return conn.send({ t: 'auth', ok: !r.error, mode: 'resetPassword', error: r.error });
          }
          let res;
          if (m.mode === 'register') res = await auth.register({ username: m.username, password: m.password, color: m.color });
          else if (m.mode === 'login') res = await auth.login({ username: m.username, password: m.password });
          else if (m.mode === 'guest') res = await auth.guest({ username: m.username, color: m.color });
          else if (m.mode === 'token') { const a = await auth.fromToken(m.token); res = a ? { account: a, token: m.token } : { error: 'session expired' }; }
          else res = { error: 'bad auth mode' };
          if (res.error) return conn.send({ t: 'auth', ok: false, error: res.error });
          account = res.account;
          touchOnline();
          conn.send({ t: 'auth', ok: true, account: outAcct(res.account), token: res.token });
          return;
        }
        case 'logout': goneOffline(); account = null; return;
        case 'setEmail': {
          const r = await auth.setEmail({ account, email: m.email });
          if (r.account) account = r.account;
          return conn.send({ t: 'account', ok: !r.error, error: r.error, account: outAcct(account) });
        }
        case 'verifyEmail': {
          const r = await auth.verifyEmail({ token: m.token });
          if (!r.error && account && r.account && r.account.id === account.id) account = r.account;
          return conn.send({ t: 'account', ok: !r.error, error: r.error, account: outAcct(account) });
        }
        case 'listRooms':
          conn.send({ t: 'lobby', proto: Core.PROTO, rooms: registry.publicRooms(), account: outAcct(account), maintenance: config.MAINTENANCE, region: config.REGION });
          return;
        case 'resolve': {
          // control handoff over the lobby socket (CSP-safe, no cross-origin
          // fetch): resolve a code to its owning instance + a signed connect
          // token the owner will verify. Unknown/dormant code → this instance
          // will host it (self:true). See docs/FUTURE_ARCHITECTURE.md §4.3.
          const rc = String(m.code || '').toUpperCase().trim();
          const route = directory ? directory.resolve(rc) : null;
          const region = route ? route.region : config.REGION;
          const connectToken = tokens.sign('connect', { aid: account ? account.id : null, room: rc, region }, config.CONNECT_TTL_MS);
          return conn.send({ t: 'resolved', code: rc, self: route ? route.self : true, url: route ? route.url : '', region, connectToken });
        }
        case 'myWorlds': {
          if (!account || !store.accountsEnabled) return conn.send({ t: 'myWorlds', worlds: [] });
          const [owned, joined] = await Promise.all([
            store.worldsByOwner(account.id).catch(() => []),
            store.worldsByMember ? store.worldsByMember(account.id).catch(() => []) : [],
          ]);
          const byCode = new Map();   // owned entries win over joined
          owned.forEach((w) => byCode.set(w.code, { code: w.code, name: w.name, savedAt: w.savedAt, owner: true, role: 'host' }));
          joined.forEach((w) => { if (!byCode.has(w.code)) byCode.set(w.code, { code: w.code, name: w.name, savedAt: w.savedAt, owner: false, role: w.role || 'player' }); });
          const worlds = Array.from(byCode.values()).sort((a, b) => b.savedAt - a.savedAt);
          return conn.send({ t: 'myWorlds', worlds });
        }
        case 'leaderboard': {   // top factories by net worth — global or friend-scoped
          let ownerIds = null, scope = 'global';
          if (m.scope === 'friends' && account && store.friendGraph) {
            const g = await store.friendGraph(account.id).catch(() => null);
            ownerIds = (g ? g.friends.map((f) => f.id) : []).concat([account.id]);
            scope = 'friends';
          }
          const rows = store.topFactories ? await store.topFactories(20, ownerIds).catch(() => []) : [];
          return conn.send({ t: 'leaderboard', rows, scope });
        }
        case 'progression': {   // signed-in: cross-world level / xp / unlocked tech
          if (!account || !store.progression) return conn.send({ t: 'progression', progression: null });
          const p = await store.progression(account.id).catch(() => null);
          return conn.send({ t: 'progression', progression: p });
        }
        case 'stats': {   // signed-in: time-series history (net worth / xp / … over time)
          if (!account || !store.statsFor) return conn.send({ t: 'stats', series: null });
          let series = await store.statsFor(account.id).catch(() => ({}));
          // seed the first point on first view so a returning player sees their
          // current standing immediately (the periodic sampler adds the rest)
          if ((!series || !Object.keys(series).length) && store.progression && store.recordStats) {
            const p = await store.progression(account.id).catch(() => null);
            if (p) { await store.recordStats(account.id, Progression.metrics(p)).catch(() => {}); series = await store.statsFor(account.id).catch(() => series); }
          }
          return conn.send({ t: 'stats', series: series || {} });
        }
        case 'achievements': {   // derived from cross-world progression (DB-6)
          if (!account || !store.progression) return conn.send({ t: 'achievements', achievements: null });
          const p = await store.progression(account.id).catch(() => null);
          const evaluated = Achievements.evaluate(p);
          // announce newly-crossed unlocks: the ledger only tracks what we've
          // already shown, so `fresh` is the diff — ownership stays derived.
          let fresh = [];
          if (store.markAchievements) {
            const unlocked = evaluated.list.filter((a) => a.unlocked).map((a) => a.key);
            fresh = await store.markAchievements(account.id, unlocked).catch(() => []);
          }
          return conn.send({ t: 'achievements', achievements: evaluated, fresh });
        }
        /* --------------------- profiles + cosmetics locker ------------------ */
        // A profile is a stored bio + equipped loadout; cosmetic OWNERSHIP is a
        // derived projection of progression (DB-6), so the locker is always in
        // sync with what you've earned and needs no ownership write path.
        case 'profile': {   // your own locker, or another player's public profile
          if (!store.getProfile) return conn.send({ t: 'profile', profile: null });
          const uname = String(m.username || '').trim();
          const target = uname ? await store.getAccountByName(uname).catch(() => null)
            : (account ? await store.getAccount(account.id).catch(() => account) : null);
          if (!target) return conn.send({ t: 'profile', profile: null });
          const mine = !uname || (account && target.id === account.id);
          const [stored, summary] = await Promise.all([
            store.getProfile(target.id).catch(() => ({ bio: '', equipped: {} })),
            store.progression ? store.progression(target.id).catch(() => null) : null,
          ]);
          const profile = {
            username: target.username, color: target.color || null,
            bio: stored.bio || '', level: (summary && summary.level) || 1,
            loadout: Cosmetics.resolve(stored.equipped, summary),
          };
          // only your OWN locker carries the full catalog (owned vs locked)
          if (mine) profile.catalog = Cosmetics.catalog(summary, stored.equipped);
          return conn.send({ t: 'profile', profile, mine: !!mine });
        }
        case 'setProfile': {   // update your bio and/or equipped loadout
          if (!account || !store.setProfile) return conn.send({ t: 'profile', profile: null });
          const summary = store.progression ? await store.progression(account.id).catch(() => null) : null;
          const patch = {};
          if (m.bio !== undefined) patch.bio = String(m.bio).slice(0, 200);
          if (m.equipped !== undefined) patch.equipped = Cosmetics.sanitize(m.equipped, summary);   // untrusted → clamp to owned
          const stored = await store.setProfile(account.id, patch).catch(() => ({ bio: '', equipped: {} }));
          const acct = await store.getAccount(account.id).catch(() => account);
          return conn.send({ t: 'profile', mine: true, profile: {
            username: acct.username, color: acct.color || null,
            bio: stored.bio || '', level: (summary && summary.level) || 1,
            loadout: Cosmetics.resolve(stored.equipped, summary),
            catalog: Cosmetics.catalog(summary, stored.equipped),
          } });
        }
        /* ---------------------------- moderation ---------------------------- */
        // Any signed-in player can file a report; the ban tools + report queue
        // are admin-only (ADMIN_USERS). Bans are enforced server-side at login /
        // session resume; issuing one bumps the target's tokenVersion so any
        // live session dies immediately.
        case 'report': {   // flag another player for admin review
          if (!account || !moderation) return conn.send({ t: 'reported', error: 'sign in to report' });
          const r = await moderation.report(account.id, account.username, m.username, m.reason);
          return conn.send({ t: 'reported', ok: !r.error, error: r.error || null });
        }
        case 'mod':
        case 'ban':
        case 'unban':
        case 'reportResolve':
        case 'flagClear': {
          if (!account || !moderation || !moderation.isAdmin(account.username)) {
            return conn.send({ t: 'mod', bans: null, reports: null, flags: null, error: 'not authorized' });
          }
          let error = null;
          if (m.t === 'ban') error = (await moderation.ban(account.username, m.username, m.reason, m.days)).error || null;
          else if (m.t === 'unban') error = (await moderation.unban(account.username, m.username)).error || null;
          else if (m.t === 'reportResolve') error = (await moderation.resolveReport(account.username, m.id, m.action)).error || null;
          else if (m.t === 'flagClear') error = (await moderation.clearFlag(account.username, m.id)).error || null;
          const [bansRes, repRes, flagRes] = await Promise.all([
            moderation.list(account.username), moderation.reports(account.username), moderation.flags(account.username)]);
          return conn.send({ t: 'mod', bans: bansRes.bans || [], reports: repRes.reports || [], flags: flagRes.flags || [], error: error || null });
        }
        /* ------------------------------ social ------------------------------ */
        case 'friends':
        case 'friendReq':
        case 'friendResp':
        case 'friendRemove':
        case 'friendBlock': {
          if (!account || !store.friendGraph) return conn.send({ t: 'friends', graph: null });
          let error = null;
          if (m.t === 'friendReq') {
            const target = await store.getAccountByName(String(m.username || '').trim()).catch(() => null);
            if (!target) error = 'no player with that name';
            else if (target.id === account.id) error = "you can't add yourself";
            else error = (await store.friendRequest(account.id, target.id).catch(() => ({ error: 'failed' }))).error || null;
          } else if (m.t === 'friendResp') {
            error = (await store.friendRespond(account.id, String(m.id || ''), !!m.accept).catch(() => ({ error: 'failed' }))).error || null;
          } else if (m.t === 'friendRemove') {
            await store.friendRemove(account.id, String(m.id || '')).catch(() => {});
          } else if (m.t === 'friendBlock') {
            await store.friendBlock(account.id, String(m.id || ''), !!m.blocked).catch(() => {});
          }
          const graph = await store.friendGraph(account.id).catch(() => null);
          // enrich with live presence so the client shows online / in-game
          if (graph && presence) {
            ['friends', 'incoming', 'outgoing'].forEach((k) => (graph[k] || []).forEach((f) => { f.presence = presence.get(f.id); }));
          }
          return conn.send({ t: 'friends', graph, error });
        }
        /* ------------------------ world invites ----------------------------- */
        case 'invite': {
          // invite a FRIEND into a world you have access to. The invite only
          // carries a code; the recipient's join still goes through the normal
          // access checks + connect-token handoff, so it can't bypass authority.
          if (!account || !invites) return conn.send({ t: 'invited', error: 'sign in first' });
          const code = String(m.code || '').toUpperCase().trim();
          const to = String(m.to || '');
          if (!code || !to) return conn.send({ t: 'invited', error: 'nothing to invite to' });
          const g = await store.friendGraph(account.id).catch(() => null);
          if (!g || !g.friends.some((f) => f.id === to)) return conn.send({ t: 'invited', error: 'you can only invite friends' });
          const inRoom = !!(room && room.code === code);
          const member = inRoom ? true : (store.membership ? await store.membership(account.id, code).catch(() => null) : null);
          if (!inRoom && !member) return conn.send({ t: 'invited', error: "you don't have access to that world" });
          const route = directory ? directory.resolve(code) : null;
          const name = inRoom ? room.name : (route ? route.name : code);
          invites.create(account.id, account.username, to, code, name);
          return conn.send({ t: 'invited', ok: true });
        }
        case 'invites':
          if (!account || !invites) return conn.send({ t: 'invites', invites: [] });
          return conn.send({ t: 'invites', invites: invites.listFor(account.id) });
        case 'inviteAccept': {
          if (!account || !invites) return conn.send({ t: 'invites', invites: [] });
          const inv = invites.get(String(m.id || ''));
          if (inv && inv.to === account.id) { invites.remove(inv.id); return conn.send({ t: 'inviteAccepted', code: inv.code }); }
          return conn.send({ t: 'invites', invites: invites.listFor(account.id) });
        }
        case 'inviteDecline': {
          if (!account || !invites) return conn.send({ t: 'invites', invites: [] });
          const inv = invites.get(String(m.id || ''));
          if (inv && inv.to === account.id) invites.remove(inv.id);
          return conn.send({ t: 'invites', invites: invites.listFor(account.id) });
        }
        case 'quickplay': {
          // "find me a game": the best public room with a free seat, else tell
          // the client to host one. The join/create still runs the normal flow.
          // An optional `region` filter hard-limits the search to one region (the
          // regional picker); otherwise this region is preferred, fuller rooms
          // first so players congregate.
          const region = config.REGION;
          const want = (m.region && m.region !== 'any') ? String(m.region) : null;
          const joinable = registry.publicRooms()
            .filter((r) => (r.maxPlayers ? r.players < r.maxPlayers : true))
            .filter((r) => (want ? r.region === want : true))
            .sort((a, b) => {
              const ra = (a.region === region ? 0 : 1), rb = (b.region === region ? 0 : 1);
              return ra !== rb ? ra - rb : b.players - a.players;
            });
          if (joinable.length) return conn.send({ t: 'quickplay', code: joinable[0].code });
          return conn.send({ t: 'quickplay', create: true });
        }
        case 'create':
          return enterRoom(async () => {
            if (config.MAINTENANCE) return conn.send({ t: 'err', reason: 'server is in maintenance — try again shortly' });
            const r = registry.create({
              name: m.roomName, public: m.public, maxPlayers: m.maxPlayers,
              ownerId: account ? account.id : null,
              seed: (m.seed !== undefined && isFinite(m.seed)) ? m.seed : undefined,
            });
            if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
            room = r;
            client = r.addPlayer(conn, identity(m), m.spectate ? 'spectator' : 'host');
            wire();
          });
        case 'join':
          return enterRoom(async () => {
            const code = String(m.code || '').toUpperCase().trim();
            if (!connectOk(m, code)) return conn.send({ t: 'err', reason: 'invalid connect token' });
            const r = registry.get(code);
            if (!r) return conn.send({ t: 'err', reason: 'room not found' });
            const asSpec = !!m.spectate;
            if (!asSpec && r.nonSpectators() >= r.maxPlayers) return conn.send({ t: 'err', reason: 'room full' });
            room = r;
            client = r.addPlayer(conn, identity(m), asSpec ? 'spectator' : restoredRole(r));
            wire();
          });
        case 'resume':
          // load a saved world back into a live room, then host it
          return enterRoom(async () => {
            if (config.MAINTENANCE) return conn.send({ t: 'err', reason: 'server is in maintenance — try again shortly' });
            const code = String(m.code || '').toUpperCase().trim();
            if (!connectOk(m, code)) return conn.send({ t: 'err', reason: 'invalid connect token' });
            const live = registry.get(code);
            if (live) {   // already live — join it with any restored role
              room = live;
              client = live.addPlayer(conn, identity(m), restoredRole(live));
              return wire();
            }
            const saved = await store.loadRoom(code).catch(() => null);
            if (!saved) return conn.send({ t: 'err', reason: 'no saved world with that code' });
            // access: the owner, OR anyone who has played it (a recorded member)
            const isMember = account && store.membership ? await store.membership(account.id, code).catch(() => null) : null;
            if (saved.meta.ownerId && (!account || (account.id !== saved.meta.ownerId && !isMember))) {
              return conn.send({ t: 'err', reason: 'that world belongs to another player' });
            }
            const r = registry.create({ code, name: saved.meta.name, public: !!m.public,
              ownerId: saved.meta.ownerId || (account && account.id),
              members: saved.meta.members || [],       // carry forward (file backend)
              snapshot: saved.snapshot });
            if (!r) return conn.send({ t: 'err', reason: 'server full (rooms)' });
            room = r;
            client = r.addPlayer(conn, identity(m), 'host');   // the resumer revives + hosts the session
            wire();
          });
        case 'rejoin':
          return enterRoom(async () => {
            const d = tokens.verify('reconnect', String(m.token || ''));
            if (!d) return conn.send({ t: 'err', reason: 'session expired' });
            const r = registry.get(d.room);
            if (!r) {
              // not on this instance — if the room moved to a live peer, redirect
              // the client there (the reconnect token verifies on any instance —
              // shared AUTH_SECRET). See docs/FUTURE_ARCHITECTURE.md §4.3.
              const route = directory ? directory.resolve(d.room) : null;
              if (route && !route.self && route.url) return conn.send({ t: 'redirect', url: route.url, code: d.room });
              return conn.send({ t: 'err', reason: 'that game is no longer available' });
            }
            // re-seat with the token's identity; a stale 'host' token can't hijack
            // an existing host — it rejoins as a player instead.
            let role = d.role;
            if (role === 'host' && r.hasHost()) role = 'player';
            room = r;
            client = r.addPlayer(conn, { name: d.name, color: d.color, gz: hello && hello.gz }, role, d.sid);
            wire();
          });
      }
      if (room && client) room.onMessage(client, m);
    };
  };
}

module.exports = { createLobby };
