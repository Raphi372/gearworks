'use strict';
/* ==========================================================================
   anticheat.js — anomaly scoring (Phase 3).

   The server is already authoritative — every command is validated, rate-
   limited, and permission-gated, and clients self-audit against periodic state
   hashes. This module turns the anomalies that surface there into a per-player
   SCORE: rate-limit hits, sim-rejected commands, permission violations, and
   hash divergence each add weighted points. When a player's score crosses a
   threshold, a FLAG is recorded for admin review.

   The guiding rule (docs/FUTURE_ARCHITECTURE.md §6, [SEC-3]) is *score, don't
   auto-ban* — flags are a human-in-the-loop signal that lands in the same
   moderation queue as reports, never an automatic punishment. Scores decay over
   time so transient blips fade, and a subject is re-flagged at most once per
   cooldown so the queue can't be spammed.

   Only AUTHED players are scored (a flag has to point at an account an admin can
   act on); anonymous anomalies are already handled by the authoritative gates.
   Inert by default unless a store with `recordFlag` is wired and the threshold
   is non-zero.
   ========================================================================== */
function createAntiCheat(config, store, metrics) {
  const THRESH = config.ANTICHEAT_FLAG_SCORE | 0;
  const DECAY_MS = Math.max(1000, config.ANTICHEAT_DECAY_MS | 0);
  const COOLDOWN_MS = Math.max(0, config.ANTICHEAT_COOLDOWN_MS | 0);
  const WEIGHT = { rate: 10, reject: 4, perm: 12, divergence: 20 };
  const enabled = THRESH > 0 && store && typeof store.recordFlag === 'function';
  const subjects = new Map();   // 'a:<accountId>' -> { score, last, flaggedAt, name }

  function decay(s, now) {
    const dt = now - s.last;
    if (dt > 0) s.score = Math.max(0, s.score - (dt / DECAY_MS) * THRESH);
    s.last = now;
  }

  // record one anomaly for a room client. Fire-and-forget: never blocks the sim.
  function signal(kind, c, roomCode) {
    if (!enabled || !c || !c.aid) return;
    const w = WEIGHT[kind] || 0;
    if (!w) return;
    const now = Date.now();
    const k = 'a:' + c.aid;
    let s = subjects.get(k);
    if (!s) { s = { score: 0, last: now, flaggedAt: 0, name: c.name }; subjects.set(k, s); }
    s.name = c.name || s.name;
    decay(s, now);
    s.score += w;
    if (s.score >= THRESH && (now - s.flaggedAt) > COOLDOWN_MS) {
      const reached = Math.round(s.score);
      s.flaggedAt = now;
      s.score = 0;   // reset after flagging so the cooldown governs the next one
      if (metrics && metrics.recordFlag) metrics.recordFlag();
      Promise.resolve(store.recordFlag({ accountId: c.aid, name: s.name, roomCode: roomCode || null, reason: kind, score: reached })).catch(() => {});
    }
  }

  return { enabled, signal, _subjects: subjects };
}

module.exports = { createAntiCheat };
