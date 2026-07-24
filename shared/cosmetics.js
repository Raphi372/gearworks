/* ==========================================================================
   GEARWORKS COSMETICS — a vanity locker derived from cross-world progression.

   Cosmetics are purely decorative (guideline: never gameplay-affecting). Like
   achievements, OWNERSHIP is a DERIVED projection (guideline DB-6): a pure
   function of the account's progression summary (level / net worth / buildings
   / unlocked tech), so it needs no write path and is always fresh — you own a
   cosmetic exactly when you've met its unlock rule.

   The only genuine mutable state is your EQUIPPED loadout (which owned cosmetic
   sits in each slot) plus a short bio; that is persisted per-account through the
   store. The server sanitizes an equip request against your derived ownership,
   so an untrusted client can never equip something it hasn't earned ([C-1]).

   Slots (`kind`) hold one cosmetic each:
     - nameplate — the colour your name renders in.
     - title     — a short tag shown beside your name.

   Runs identically in the browser (to render the locker) and in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Cosmetics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // catalog: each cosmetic unlocks when a progression field reaches a target
  // (target 0 = always owned). `value` is what the slot renders — a hex colour
  // for a nameplate, the label text for a title.
  var DEFS = [
    { key: 'plate_steel',   kind: 'nameplate', name: 'Steel',   desc: 'Default nameplate',      value: '#9fb2c8', field: 'level',    target: 0 },
    { key: 'plate_copper',  kind: 'nameplate', name: 'Copper',  desc: 'Reach level 3',          value: '#e08a3c', field: 'level',    target: 3 },
    { key: 'plate_gold',    kind: 'nameplate', name: 'Gold',    desc: 'Reach level 8',          value: '#ffcf40', field: 'level',    target: 8 },
    { key: 'plate_emerald', kind: 'nameplate', name: 'Emerald', desc: '$100k net worth',        value: '#38d39f', field: 'money',    target: 100000 },

    { key: 'title_founder',       kind: 'title', name: 'Founder',       desc: 'Reach level 2',           value: 'Founder',       field: 'level',    target: 2 },
    { key: 'title_industrialist', kind: 'title', name: 'Industrialist', desc: 'Reach level 5',           value: 'Industrialist', field: 'level',    target: 5 },
    { key: 'title_tycoon',        kind: 'title', name: 'Tycoon',        desc: '$100k net worth',         value: 'Tycoon',        field: 'money',    target: 100000 },
    { key: 'title_researcher',    kind: 'title', name: 'Researcher',    desc: 'Unlock 10 technologies',  value: 'Researcher',    field: 'tech',     target: 10 },
    { key: 'title_automator',     kind: 'title', name: 'Automator',     desc: '500 buildings',           value: 'Automator',     field: 'entities', target: 500 },
  ];

  var BY_KEY = {}; DEFS.forEach(function (d) { BY_KEY[d.key] = d; });
  // distinct slots, in catalog order
  var KINDS = DEFS.reduce(function (acc, d) { if (acc.indexOf(d.kind) < 0) acc.push(d.kind); return acc; }, []);

  function vals(summary) {
    var s = summary || {};
    return { level: s.level | 0, money: s.money | 0, entities: s.entities | 0,
      tech: (s.unlockedTech || []).length, xp: s.xp | 0 };
  }
  function isOwned(def, v) { return (v[def.field] | 0) >= (def.target | 0); }

  // owned cosmetic keys, derived from progression (pure function, no write path)
  function owned(summary) {
    var v = vals(summary);
    return DEFS.filter(function (d) { return isOwned(d, v); }).map(function (d) { return d.key; });
  }

  // the full locker view: every cosmetic with unlock + equipped state, so the
  // client can render owned (equippable) vs locked (with the unlock hint).
  function catalog(summary, equipped) {
    var v = vals(summary); var eq = equipped || {};
    return DEFS.map(function (d) {
      return { key: d.key, kind: d.kind, name: d.name, desc: d.desc, value: d.value,
        unlocked: isOwned(d, v), equipped: eq[d.kind] === d.key };
    });
  }

  // clamp an equip request to what the account actually owns: keep a slot only
  // when its key exists, matches the slot's kind, and is unlocked. This is the
  // server-side guard on the untrusted client's requested loadout.
  function sanitize(equipped, summary) {
    var v = vals(summary); var out = {}; var eq = equipped || {};
    KINDS.forEach(function (kind) {
      var key = eq[kind]; var d = key && BY_KEY[key];
      if (d && d.kind === kind && isOwned(d, v)) out[kind] = key;
    });
    return out;
  }

  // resolve a (already-sanitized or raw) loadout to the values each slot renders:
  // { nameplate: '#hex'|null, title: 'label'|null }. Unowned/empty slots are null.
  function resolve(equipped, summary) {
    var eq = sanitize(equipped, summary); var out = {};
    KINDS.forEach(function (kind) { var d = eq[kind] && BY_KEY[eq[kind]]; out[kind] = d ? d.value : null; });
    return out;
  }

  return { DEFS: DEFS, KINDS: KINDS, owned: owned, catalog: catalog, sanitize: sanitize, resolve: resolve };
});
