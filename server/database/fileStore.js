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

function createFileStore(config) {
  const { SAVE_DIR, BACKUPS, log } = config;
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
      fs.writeFileSync(file, JSON.stringify(data));
      return true;
    } catch (e) { log.error(`file save failed for room ${code}: ${e.message}`); return false; }
  }

  function loadRoom(code) {
    try { return JSON.parse(fs.readFileSync(roomPath(code), 'utf8')); }
    catch (e) { return null; }
  }

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
          public: !!d.meta.public, snapshot: d.snapshot, savedAt: d.meta.saved || 0 });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  // saved worlds owned by an account: scan room saves' meta.ownerId
  function worldsByOwner(ownerId) {
    const out = [];
    for (const code of listRoomCodes()) {
      const d = loadRoom(code);
      if (d && d.meta && d.meta.ownerId === ownerId) {
        out.push({ code, name: d.meta.name, savedAt: d.meta.saved || 0 });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  return {
    kind: 'file',
    accountsEnabled: true,
    ready: () => Promise.resolve(),
    saveRoom,                              // synchronous
    loadRoom: (code) => Promise.resolve(loadRoom(code)),
    loadFile: (p) => Promise.resolve(loadFile(p)),
    listRoomCodes: () => Promise.resolve(listRoomCodes()),
    worldsByOwner: (ownerId) => Promise.resolve(worldsByOwner(ownerId)),
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
