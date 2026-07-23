'use strict';
/* ==========================================================================
   server/invites.js — pending world invites (a friend → your world).

   An invite is short-lived and disposable (a friend asks another to join a
   specific world), so — like presence — it stays OUT of the relational store:
   'local' (in-memory, single-instance default) or 'file' (a small file per
   invite in a shared dir, so a friend on another instance still sees it). Each
   invite carries an expiry; stale invites are ignored and swept.

   The invite only routes the recipient to a world code — the actual join still
   goes through the connect-token handoff and the room's own access checks, so an
   invite can never bypass authority. No sim, no gameplay.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function memoryBackend() {
  const m = new Map();
  return { put: (id, v) => m.set(id, v), get: (id) => m.get(id) || null, del: (id) => m.delete(id), all: () => Array.from(m.values()) };
}
function fileBackend(dir, log) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* lazy */ }
  const file = (id) => path.join(dir, `${id}.inv.json`);
  return {
    put(id, v) { try { fs.writeFileSync(file(id), JSON.stringify(v)); } catch (e) { log.error(`invite write ${id}: ${e.message}`); } },
    get(id) { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (e) { return null; } },
    del(id) { try { fs.unlinkSync(file(id)); } catch (e) { /* gone */ } },
    all() {
      let out = [];
      try { for (const n of fs.readdirSync(dir).filter((f) => f.endsWith('.inv.json'))) { try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch (e) {} } } catch (e) {}
      return out;
    },
  };
}

function createInvites(config) {
  const mode = config.INVITES === 'file' ? 'file' : 'local';
  const TTL = config.INVITE_TTL_MS | 0 || 3600000;
  const dir = config.INVITE_DIR || path.join(config.SAVE_DIR || 'saves', 'invites');
  const backend = mode === 'file' ? fileBackend(dir, config.log) : memoryBackend();
  const fresh = (v) => !!v && (v.exp || 0) > Date.now();

  return {
    mode,
    create(from, fromName, to, code, name) {
      if (!from || !to || !code || from === to) return null;
      const id = crypto.randomBytes(9).toString('hex');
      const inv = { id, from, fromName: fromName || null, to, code, name: name || code, createdAt: Date.now(), exp: Date.now() + TTL };
      backend.put(id, inv);
      return inv;
    },
    get(id) { const v = backend.get(id); return fresh(v) ? v : null; },
    remove(id) { backend.del(id); },
    // fresh invites addressed to an account (also sweeps expired ones it sees)
    listFor(to) {
      const out = [];
      for (const v of backend.all()) {
        if (!fresh(v)) { if (v && v.id) backend.del(v.id); continue; }
        if (v.to === to) out.push({ id: v.id, from: v.from, fromName: v.fromName, code: v.code, name: v.name, createdAt: v.createdAt });
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    },
  };
}

module.exports = { createInvites };
