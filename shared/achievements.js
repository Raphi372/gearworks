/* ==========================================================================
   GEARWORKS ACHIEVEMENTS — goals derived from cross-world progression.

   Achievements are a DERIVED projection (guideline DB-6), exactly like
   progression: a pure function of the account's progression summary
   (level / net worth / buildings / unlocked tech), never a second source of
   truth. So they are always fresh and need no write path — the server computes
   them on demand from `store.progression(...)`. A durable "unlocked at"
   timestamp (for notifications / reward grants) is a later, additive increment.

   Runs identically in the browser (to render the panel) and in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Achievements = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // catalog: each goal maps a progression field to a threshold.
  var DEFS = [
    { key: 'level2', name: 'Getting Started', desc: 'Reach level 2', field: 'level', target: 2 },
    { key: 'level5', name: 'Industrialist', desc: 'Reach level 5', field: 'level', target: 5 },
    { key: 'level10', name: 'Captain of Industry', desc: 'Reach level 10', field: 'level', target: 10 },
    { key: 'worth100k', name: 'Tycoon', desc: '$100k net worth across your worlds', field: 'money', target: 100000 },
    { key: 'build500', name: 'Automator', desc: '500 buildings across your worlds', field: 'entities', target: 500 },
    { key: 'tech10', name: 'Researcher', desc: 'Unlock 10 technologies', field: 'tech', target: 10 },
  ];

  // evaluate a progression summary → { total, unlocked, list:[{key,name,desc,value,target,unlocked,progress}] }
  function evaluate(summary) {
    var s = summary || {};
    var vals = {
      level: s.level | 0,
      money: s.money | 0,
      entities: s.entities | 0,
      tech: (s.unlockedTech || []).length,
      xp: s.xp | 0,
    };
    var list = DEFS.map(function (d) {
      var v = vals[d.field] | 0, target = d.target | 0;
      return { key: d.key, name: d.name, desc: d.desc, value: v, target: target,
        unlocked: v >= target, progress: target ? Math.min(1, v / target) : 1 };
    });
    return { total: list.length, unlocked: list.filter(function (x) { return x.unlocked; }).length, list: list };
  }

  return { DEFS: DEFS, evaluate: evaluate };
});
