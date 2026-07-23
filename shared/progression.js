/* ==========================================================================
   GEARWORKS PROGRESSION — cross-world account XP / levels (pure functions)
   --------------------------------------------------------------------------
   Progression is a DERIVED metagame projection: an account's level and XP are
   a pure function of the worlds it owns or has played (guideline DB-6 — never
   a second source of truth). The authoritative truth stays in each World's
   snapshot; the per-world `projection()` (money / entities / tech) feeds this
   aggregate. Because it is a pure function of that data it is always fresh and
   can be recomputed on demand — no write path in the sim loop.

   Runs identically in the browser (to render the level bar) and in Node (both
   persistence backends), so client and server never disagree about a level.

   XP model (deterministic):
     • per-world XP  = money + entities*5 + techCount*250
     • account XP    = Σ per-world XP over the account's worlds
     • level curve   = triangular: reaching level L needs 1000*L*(L-1)/2 XP
                       (L1 @ 0, L2 @ 1k, L3 @ 3k, L4 @ 6k, L5 @ 10k, …)
     • unlockedTech  = sorted union of researched tech ids across the worlds
   ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Progression = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STEP = 1000;   // XP granularity of the level curve

  // XP a single world contributes, from its derived projection.
  function worldXp(p) {
    if (!p) return 0;
    var money = Math.max(0, p.money | 0);
    var entities = Math.max(0, p.entities | 0);
    var tech = Math.max(0, (p.tech != null ? p.tech : (p.techIds ? p.techIds.length : 0)) | 0);
    return money + entities * 5 + tech * 250;
  }

  // cumulative XP required to REACH a given level (level 1 needs 0).
  function xpForLevel(level) {
    var L = Math.max(1, level | 0);
    return STEP * (L * (L - 1)) / 2;
  }

  // highest level whose XP threshold is satisfied by `xp`.
  function levelForXp(xp) {
    var x = Math.max(0, xp | 0);
    // invert xpForLevel: STEP*L*(L-1)/2 <= x  ->  L = floor((1+sqrt(1+8x/STEP))/2)
    return Math.floor((1 + Math.sqrt(1 + 8 * x / STEP)) / 2);
  }

  // Aggregate an account's worlds (each with a `projection` and optional
  // `techIds`) into a progression summary suitable for storage or display.
  function summarize(worlds) {
    var xp = 0, money = 0, entities = 0;
    var techSet = {};
    (worlds || []).forEach(function (w) {
      var p = w.projection || w;
      xp += worldXp(p);
      money += Math.max(0, p.money | 0);
      entities += Math.max(0, p.entities | 0);
      var ids = (p && p.techIds) || w.techIds;
      if (ids && ids.length) ids.forEach(function (t) { if (t) techSet[t] = 1; });
    });
    var level = levelForXp(xp);
    var unlockedTech = Object.keys(techSet).sort();
    return {
      xp: xp,
      level: level,
      money: money,                           // total net worth across worlds
      entities: entities,                     // total buildings across worlds
      unlockedTech: unlockedTech,
      xpThisLevel: xpForLevel(level),         // XP at which this level began
      xpNextLevel: xpForLevel(level + 1),     // XP needed for the next level
    };
  }

  // the time-series metrics sampled from a progression summary (one number per
  // key) — kept here so the sampler and the lobby seed agree on the mapping.
  function metrics(summary) {
    var s = summary || {};
    return {
      net_worth: s.money | 0,
      entities: s.entities | 0,
      tech: (s.unlockedTech || []).length,
      xp: s.xp | 0,
      level: s.level | 0,
    };
  }

  return { worldXp: worldXp, xpForLevel: xpForLevel, levelForXp: levelForXp, summarize: summarize, metrics: metrics, STEP: STEP };
});
