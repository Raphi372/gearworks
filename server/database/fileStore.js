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
        .filter((f) => /\.json$/.test(f) && !/\.bak\d+\./.test(f))
        .map((f) => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
  }

  return {
    kind: 'file',
    ready: () => Promise.resolve(),
    saveRoom,                              // synchronous
    loadRoom: (code) => Promise.resolve(loadRoom(code)),
    loadFile: (p) => Promise.resolve(loadFile(p)),
    listRoomCodes: () => Promise.resolve(listRoomCodes()),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    // account/world APIs are Postgres-only; file backend is single-world-per-file
    accountsEnabled: false,
  };
}

module.exports = { createFileStore };
