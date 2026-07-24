'use strict';
/* ==========================================================================
   database/fileStore.js — default, zero-dependency persistence backend.

   Stores each room as SAVE_DIR/<code>.json with rotating .bakN backups.
   This is the backend the game uses out of the box: `node server/server.js`
   needs no npm install and no external database. Room snapshot writes are
   synchronous so a SIGTERM/SIGINT can flush to disk before the process exits.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Progression = require('../../shared/progression.js');

function createFileStore(config, snapshots) {
  const { SAVE_DIR, BACKUPS, log } = config;
  const STAT_KEEP = config.STAT_KEEP || 168;
  snapshots = snapshots || { external: false };   // snapshot blob store (inline by default)
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

  function roomPath(code) { return path.join(SAVE_DIR, `${code}.json`); }

  /* -------- accounts (JSON map on disk; fine for self-host scale) -------- */
  const accountsPath = path.join(SAVE_DIR, 'accounts.json');
  let accounts = null;                 // { byId, byName: {lower:id}, byEmail: {lower:id} }
  function loadAccounts() {
    if (accounts) return accounts;
    try { accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8')); }
    catch (e) { accounts = { byId: {}, byName: {}, byEmail: {} }; }
    if (!accounts.byId) accounts = { byId: {}, byName: {}, byEmail: {} };
    if (!accounts.byEmail) accounts.byEmail = {};
    return accounts;
  }
  function persistAccounts() {
    try { fs.writeFileSync(accountsPath, JSON.stringify(loadAccounts())); }
    catch (e) { log.error(`account save failed: ${e.message}`); }
  }

  function saveRoom(code, data) {
    try {
      const file = roomPath(code);
      // rotate backups: .json -> .bak1 -> .bak2 ... (BACKUPS kept)
      for (let i = BACKUPS - 1; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.bak${i - 1}`;
        const to = `${file}.bak${i}`;
        if (fs.existsSync(from) && i > 1) fs.renameSync(from, to);
        else if (i === 1 && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak1`);
      }
      // externalize the (large) snapshot blob when a snapshot store is active,
      // keeping only a small snapshotRef in the room save; else inline as before.
      let toWrite = data;
      if (snapshots.external) {
        const ref = snapshots.put(code, data.snapshot);
        toWrite = { meta: Object.assign({}, data.meta, { snapshotRef: ref }), snapshot: null };
      }
      fs.writeFileSync(file, JSON.stringify(toWrite));
      return true;
    } catch (e) { log.error(`file save failed for room ${code}: ${e.message}`); return false; }
  }

  // read a room save's METADATA (fast; the snapshot may be an external ref).
  function loadMeta(code) {
    try { return JSON.parse(fs.readFileSync(roomPath(code), 'utf8')); }
    catch (e) { return null; }
  }
  // fill in the snapshot blob from its external ref if the save only holds a ref.
  function hydrate(d) {
    if (d && d.meta && d.meta.snapshotRef && d.snapshot == null) d.snapshot = snapshots.get(d.meta.snapshotRef);
    return d;
  }
  // the full room (metadata + snapshot) — used by resume / boot restore.
  function loadRoom(code) { return hydrate(loadMeta(code)); }

  function loadFile(absPath) {
    try { return JSON.parse(fs.readFileSync(absPath, 'utf8')); }
    catch (e) { return null; }
  }

  function listRoomCodes() {
    try {
      return fs.readdirSync(SAVE_DIR)
        .filter((f) => /\.json$/.test(f) && f !== 'accounts.json' && !/\.bak\d+\./.test(f))
        .map((f) => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
  }

  // worlds saved at/after `sinceMs` — for restoring live games on boot
  function recentRooms(sinceMs) {
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadRoom(code);
      if (d && d.meta && (d.meta.saved || 0) >= sinceMs) {
        out.push({ code, name: d.meta.name, ownerId: d.meta.ownerId || null,
          public: !!d.meta.public, snapshot: d.snapshot, members: d.meta.members || [],
          savedAt: d.meta.saved || 0 });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  // leaderboard: read each save's derived projection, sort by net worth.
  // ownerIds (optional) restricts it to a set of accounts (friend-scoped).
  function topFactories(limit, ownerIds) {
    const set = ownerIds && ownerIds.length ? new Set(ownerIds) : null;
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadMeta(code);
      if (!d || !d.meta) continue;
      if (set && !set.has(d.meta.ownerId)) continue;
      const p = d.meta.projection || {};
      out.push({ code, name: d.meta.name, ownerId: d.meta.ownerId || null,
        money: p.money | 0, tech: p.tech | 0, entities: p.entities | 0, savedAt: d.meta.saved || 0 });
    }
    out.sort((a, b) => b.money - a.money);
    const top = out.slice(0, limit);
    const accts = loadAccounts();
    top.forEach((f) => { f.ownerName = f.ownerId && accts.byId[f.ownerId] ? accts.byId[f.ownerId].username : null; });
    return top;
  }

  // saved worlds owned by an account: scan room saves' meta.ownerId
  function worldsByOwner(ownerId) {
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadMeta(code);
      if (d && d.meta && d.meta.ownerId === ownerId) {
        out.push({ code, name: d.meta.name, savedAt: d.meta.saved || 0 });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  // worlds an account has played (recorded in meta.members), with its last role
  function worldsByMember(aid) {
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadMeta(code);
      const mem = d && d.meta && Array.isArray(d.meta.members) ? d.meta.members.find((x) => x.aid === aid) : null;
      if (mem) out.push({ code, name: d.meta.name, ownerId: d.meta.ownerId || null, role: mem.role || 'player', savedAt: d.meta.saved || 0 });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }
  // an account's stored role in one world, or null if never a member
  function membership(aid, code) {
    const d = loadMeta(code);
    const mem = d && d.meta && Array.isArray(d.meta.members) ? d.meta.members.find((x) => x.aid === aid) : null;
    return mem ? { role: mem.role || 'player' } : null;
  }

  // every world an account owns or has played, with its derived projection —
  // the raw material for the cross-world progression aggregate
  function accountWorlds(aid) {
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadMeta(code);
      if (!d || !d.meta) continue;
      const owns = d.meta.ownerId === aid;
      const member = Array.isArray(d.meta.members) && d.meta.members.some((x) => x.aid === aid);
      if (owns || member) out.push({ code, projection: d.meta.projection || {} });
    }
    return out;
  }
  // cross-world level / xp / unlocked tech — derived on demand (like the
  // leaderboard), always fresh, never a separate source of truth
  function progression(aid) { return Progression.summarize(accountWorlds(aid)); }

  /* -------- time-series stats (bounded ring per account+key) -------- */
  const statsPath = path.join(SAVE_DIR, 'stats.json');
  let statsCache = null;
  function loadStats() {
    if (statsCache) return statsCache;
    try { statsCache = JSON.parse(fs.readFileSync(statsPath, 'utf8')); }
    catch (e) { statsCache = {}; }
    if (!statsCache || typeof statsCache !== 'object') statsCache = {};
    return statsCache;
  }
  // append one point per metric for an account, trimmed to the last STAT_KEEP
  function recordStats(accountId, samples, at) {
    if (!accountId || !samples) return;
    const s = loadStats();
    const acct = s[accountId] || (s[accountId] = {});
    const t = at || Date.now();
    for (const key of Object.keys(samples)) {
      const arr = acct[key] || (acct[key] = []);
      arr.push({ t, v: Number(samples[key]) || 0 });
      if (arr.length > STAT_KEEP) arr.splice(0, arr.length - STAT_KEEP);
    }
    try { fs.writeFileSync(statsPath, JSON.stringify(s)); }
    catch (e) { log.error(`stats save failed: ${e.message}`); }
  }
  function statsFor(accountId) { return loadStats()[accountId] || {}; }

  /* -------- social graph: friends / requests / blocks (JSON on disk) -------- */
  const friendsPath = path.join(SAVE_DIR, 'friends.json');
  let friends = null;
  function loadFriends() {
    if (friends) return friends;
    try { friends = JSON.parse(fs.readFileSync(friendsPath, 'utf8')); } catch (e) { friends = {}; }
    if (!friends || typeof friends !== 'object') friends = {};
    return friends;
  }
  function persistFriends() {
    try { fs.writeFileSync(friendsPath, JSON.stringify(loadFriends())); }
    catch (e) { log.error(`friends save failed: ${e.message}`); }
  }
  // per-account adjacency: fr(iends), out(going req), in(coming req), bl(ocked)
  function rec(g, id) { return g[id] || (g[id] = { fr: {}, out: {}, in: {}, bl: {} }); }
  function uname(id) { const a = loadAccounts().byId[id]; return a ? a.username : null; }
  function resolveIds(map) { return Object.keys(map || {}).map((id) => ({ id, username: uname(id) })).filter((x) => x.username); }

  function friendGraph(id) {
    const me = rec(loadFriends(), id);
    return { friends: resolveIds(me.fr), incoming: resolveIds(me.in), outgoing: resolveIds(me.out), blocked: resolveIds(me.bl) };
  }
  function acceptInner(g, me, other) {
    const a = rec(g, me), b = rec(g, other);
    delete a.in[other]; delete b.out[me]; delete a.out[other]; delete b.in[me];
    a.fr[other] = Date.now(); b.fr[me] = Date.now();
    persistFriends(); return { ok: true };
  }
  function friendRequest(from, to) {
    if (!from || !to || from === to) return { error: 'invalid target' };
    const g = loadFriends(); const a = rec(g, from), b = rec(g, to);
    if (a.bl[to] || b.bl[from]) return { error: 'unavailable' };
    if (a.fr[to]) return { ok: true };                 // already friends
    if (a.in[to]) return acceptInner(g, from, to);     // they already asked → accept
    a.out[to] = Date.now(); b.in[from] = Date.now();
    persistFriends(); return { ok: true };
  }
  function friendRespond(me, other, accept) {
    const g = loadFriends(); const a = rec(g, me), b = rec(g, other);
    if (!a.in[other]) return { error: 'no pending request' };
    if (accept) return acceptInner(g, me, other);
    delete a.in[other]; delete b.out[me]; persistFriends(); return { ok: true };
  }
  function friendRemove(me, other) {
    const g = loadFriends(); const a = rec(g, me), b = rec(g, other);
    delete a.fr[other]; delete b.fr[me]; delete a.out[other]; delete b.in[me]; delete a.in[other]; delete b.out[me];
    persistFriends(); return { ok: true };
  }
  function friendBlock(me, other, blocked) {
    if (!other || me === other) return { error: 'invalid target' };
    const g = loadFriends(); const a = rec(g, me), b = rec(g, other);
    if (blocked) { a.bl[other] = Date.now(); delete a.fr[other]; delete b.fr[me]; delete a.out[other]; delete b.in[me]; delete a.in[other]; delete b.out[me]; }
    else delete a.bl[other];
    persistFriends(); return { ok: true };
  }

  /* -------- profiles: bio + equipped cosmetic loadout (JSON on disk) -------- */
  // Only the equipped loadout + bio are stored; cosmetic OWNERSHIP is derived
  // from progression (see shared/cosmetics.js), never persisted here.
  const profilesPath = path.join(SAVE_DIR, 'profiles.json');
  let profiles = null;
  function loadProfiles() {
    if (profiles) return profiles;
    try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (e) { profiles = {}; }
    if (!profiles || typeof profiles !== 'object') profiles = {};
    return profiles;
  }
  function getProfile(id) {
    const p = loadProfiles()[id];
    return { bio: (p && p.bio) || '', equipped: (p && p.equipped) || {} };
  }
  function setProfile(id, patch) {
    const all = loadProfiles();
    const cur = all[id] || { bio: '', equipped: {} };
    if (patch.bio !== undefined) cur.bio = patch.bio;
    if (patch.equipped !== undefined) cur.equipped = patch.equipped;
    all[id] = cur;
    try { fs.writeFileSync(profilesPath, JSON.stringify(all)); }
    catch (e) { log.error(`profile save failed: ${e.message}`); }
    return getProfile(id);
  }

  /* -------- moderation: account bans (JSON on disk) -------- */
  const bansPath = path.join(SAVE_DIR, 'bans.json');
  let bans = null;
  function loadBans() {
    if (bans) return bans;
    try { bans = JSON.parse(fs.readFileSync(bansPath, 'utf8')); } catch (e) { bans = {}; }
    if (!bans || typeof bans !== 'object') bans = {};
    return bans;
  }
  function persistBans() {
    try { fs.writeFileSync(bansPath, JSON.stringify(loadBans())); }
    catch (e) { log.error(`bans save failed: ${e.message}`); }
  }
  function active(b) { return b && (!b.until || b.until > Date.now()); }   // until 0 = permanent
  function banAccount(id, ban) { loadBans()[id] = { reason: ban.reason || '', by: ban.by || '', at: ban.at || Date.now(), until: ban.until || 0 }; persistBans(); return { ok: true }; }
  function unbanAccount(id) { const b = loadBans(); if (b[id]) { delete b[id]; persistBans(); } return { ok: true }; }
  // active ban for an account, or null (a lapsed ban is cleared lazily)
  function getBan(id) {
    const b = loadBans()[id];
    if (!b) return null;
    if (!active(b)) { unbanAccount(id); return null; }
    return b;
  }
  function listBans() {
    const b = loadBans(); const accts = loadAccounts(); const out = [];
    for (const id of Object.keys(b)) {
      if (!active(b[id])) continue;
      out.push({ id, username: accts.byId[id] ? accts.byId[id].username : null,
        reason: b[id].reason, by: b[id].by, at: b[id].at, until: b[id].until });
    }
    return out.sort((x, y) => y.at - x.at);
  }

  /* -------- moderation: player reports (JSON on disk) -------- */
  const reportsPath = path.join(SAVE_DIR, 'reports.json');
  let reports = null;
  function loadReports() {
    if (reports) return reports;
    try { reports = JSON.parse(fs.readFileSync(reportsPath, 'utf8')); } catch (e) { reports = {}; }
    if (!reports || typeof reports !== 'object') reports = {};
    return reports;
  }
  function persistReports() {
    try { fs.writeFileSync(reportsPath, JSON.stringify(loadReports())); }
    catch (e) { log.error(`reports save failed: ${e.message}`); }
  }
  // one report per (reporter, target): re-reporting reopens/updates the same row
  function createReport(r) {
    const all = loadReports();
    let id = Object.keys(all).find((k) => all[k].reporterId === r.reporterId && all[k].targetId === r.targetId);
    if (!id) id = crypto.randomBytes(12).toString('hex');
    all[id] = { reporterId: r.reporterId, targetId: r.targetId, reason: String(r.reason || '').slice(0, 300), status: 'open', at: Date.now() };
    persistReports(); return { ok: true, id };
  }
  function listReports() {
    const all = loadReports(); const accts = loadAccounts(); const out = [];
    const uname = (id) => (accts.byId[id] ? accts.byId[id].username : null);
    for (const id of Object.keys(all)) {
      const r = all[id];
      if (r.status !== 'open') continue;
      out.push({ id, reporterId: r.reporterId, reporter: uname(r.reporterId),
        targetId: r.targetId, target: uname(r.targetId), reason: r.reason, at: r.at });
    }
    return out.sort((x, y) => y.at - x.at);
  }
  function resolveReport(id, status) {
    const all = loadReports();
    if (all[id]) { all[id].status = status === 'resolved' ? 'resolved' : 'dismissed'; persistReports(); }
    return { ok: true };
  }

  /* -------- anti-cheat flags: one row per account, latest wins (JSON) -------- */
  const flagsPath = path.join(SAVE_DIR, 'flags.json');
  let flags = null;
  function loadFlags() {
    if (flags) return flags;
    try { flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8')); } catch (e) { flags = {}; }
    if (!flags || typeof flags !== 'object') flags = {};
    return flags;
  }
  function persistFlags() {
    try { fs.writeFileSync(flagsPath, JSON.stringify(loadFlags())); }
    catch (e) { log.error(`flags save failed: ${e.message}`); }
  }
  function recordFlag(f) {
    const all = loadFlags();
    const cur = all[f.accountId] || { count: 0, at: 0 };
    all[f.accountId] = { name: f.name || cur.name || null, roomCode: f.roomCode || null,
      reason: f.reason || '', score: f.score | 0, count: (cur.count | 0) + 1, at: Date.now() };
    persistFlags(); return { ok: true };
  }
  function listFlags() {
    const all = loadFlags(); const accts = loadAccounts(); const out = [];
    for (const id of Object.keys(all)) {
      const f = all[id];
      out.push({ id, name: f.name || (accts.byId[id] ? accts.byId[id].username : null),
        roomCode: f.roomCode, reason: f.reason, score: f.score, count: f.count, at: f.at });
    }
    return out.sort((x, y) => y.at - x.at);
  }
  function clearFlag(id) { const all = loadFlags(); if (all[id]) { delete all[id]; persistFlags(); } return { ok: true }; }

  return {
    kind: 'file',
    accountsEnabled: true,
    ready: () => Promise.resolve(),
    saveRoom,                              // synchronous
    loadRoom: (code) => Promise.resolve(loadRoom(code)),
    loadFile: (p) => Promise.resolve(loadFile(p)),
    listRoomCodes: () => Promise.resolve(listRoomCodes()),
    worldsByOwner: (ownerId) => Promise.resolve(worldsByOwner(ownerId)),
    worldsByMember: (aid) => Promise.resolve(worldsByMember(aid)),
    membership: (aid, code) => Promise.resolve(membership(aid, code)),
    progression: (aid) => Promise.resolve(progression(aid)),
    recordStats: (aid, samples, at) => { recordStats(aid, samples, at); return Promise.resolve(); },
    statsFor: (aid) => Promise.resolve(statsFor(aid)),
    friendGraph: (id) => Promise.resolve(friendGraph(id)),
    friendRequest: (from, to) => Promise.resolve(friendRequest(from, to)),
    friendRespond: (me, other, accept) => Promise.resolve(friendRespond(me, other, accept)),
    friendRemove: (me, other) => Promise.resolve(friendRemove(me, other)),
    friendBlock: (me, other, blocked) => Promise.resolve(friendBlock(me, other, blocked)),
    getProfile: (id) => Promise.resolve(getProfile(id)),
    setProfile: (id, patch) => Promise.resolve(setProfile(id, patch)),
    banAccount: (id, ban) => Promise.resolve(banAccount(id, ban)),
    unbanAccount: (id) => Promise.resolve(unbanAccount(id)),
    getBan: (id) => Promise.resolve(getBan(id)),
    listBans: () => Promise.resolve(listBans()),
    createReport: (r) => Promise.resolve(createReport(r)),
    listReports: () => Promise.resolve(listReports()),
    resolveReport: (id, status) => Promise.resolve(resolveReport(id, status)),
    recordFlag: (f) => Promise.resolve(recordFlag(f)),
    listFlags: () => Promise.resolve(listFlags()),
    clearFlag: (id) => Promise.resolve(clearFlag(id)),
    topFactories: (limit, ownerIds) => Promise.resolve(topFactories(limit || 20, ownerIds)),
    recentRooms: (sinceMs) => Promise.resolve(recentRooms(sinceMs)),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),

    /* ---- accounts ---- */
    getAccountByName(name) {
      const a = loadAccounts();
      const id = a.byName[String(name).toLowerCase()];
      return Promise.resolve(id ? a.byId[id] : null);
    },
    getAccountByEmail(email) {
      const a = loadAccounts();
      const id = a.byEmail[String(email).toLowerCase()];
      return Promise.resolve(id ? a.byId[id] : null);
    },
    getAccount(id) { return Promise.resolve(loadAccounts().byId[id] || null); },
    createAccount(acct) {
      const a = loadAccounts();
      const key = acct.username.toLowerCase();
      if (a.byName[key]) return Promise.resolve(null);   // taken
      a.byId[acct.id] = acct; a.byName[key] = acct.id;
      if (acct.email) a.byEmail[String(acct.email).toLowerCase()] = acct.id;
      persistAccounts();
      return Promise.resolve(acct);
    },
    updateAccount(id, patch) {
      const a = loadAccounts();
      const acct = a.byId[id];
      if (!acct) return Promise.resolve(null);
      if (patch.email !== undefined) {   // keep the email index in sync
        if (acct.email) delete a.byEmail[String(acct.email).toLowerCase()];
        if (patch.email) a.byEmail[String(patch.email).toLowerCase()] = id;
      }
      Object.assign(acct, patch);
      persistAccounts();
      return Promise.resolve(acct);
    },
  };
}

module.exports = { createFileStore };
