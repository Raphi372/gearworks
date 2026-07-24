'use strict';
/* Unit: cosmetic OWNERSHIP is a pure function of the progression summary
   (derived, DB-6), and equip requests are clamped to what's owned. */
const { test } = require('node:test');
const assert = require('node:assert');
const Cosmetics = require('../shared/cosmetics.js');

const NEW = { level: 1, money: 0, entities: 0, unlockedTech: [] };
const RICH = { level: 8, money: 120000, entities: 600, unlockedTech: new Array(12) };

test('ownership is derived from progression thresholds', () => {
  // a brand-new account owns only the target-0 default nameplate
  assert.deepStrictEqual(Cosmetics.owned(NEW), ['plate_steel']);
  // a maxed account owns the whole catalog
  const all = Cosmetics.owned(RICH);
  Cosmetics.DEFS.forEach((d) => assert.ok(all.includes(d.key), `owns ${d.key}`));
});

test('sanitize keeps only owned cosmetics in the right slot', () => {
  // requesting locked cosmetics as a new account → nothing survives
  assert.deepStrictEqual(Cosmetics.sanitize({ nameplate: 'plate_gold', title: 'title_tycoon' }, NEW), {});
  // a rich account keeps them
  assert.deepStrictEqual(Cosmetics.sanitize({ nameplate: 'plate_gold', title: 'title_tycoon' }, RICH),
    { nameplate: 'plate_gold', title: 'title_tycoon' });
  // a cosmetic placed in the wrong slot, or an unknown key, is dropped
  assert.deepStrictEqual(Cosmetics.sanitize({ nameplate: 'title_tycoon', title: 'bogus' }, RICH), {});
});

test('resolve maps a loadout to render values, ignoring unowned', () => {
  assert.deepStrictEqual(Cosmetics.resolve({ nameplate: 'plate_gold', title: 'title_tycoon' }, RICH),
    { nameplate: '#ffcf40', title: 'Tycoon' });
  // unowned slots resolve to null
  assert.deepStrictEqual(Cosmetics.resolve({ nameplate: 'plate_gold' }, NEW), { nameplate: null, title: null });
});

test('catalog reports unlock + equipped state for every cosmetic', () => {
  const cat = Cosmetics.catalog(RICH, { nameplate: 'plate_gold' });
  assert.strictEqual(cat.length, Cosmetics.DEFS.length);
  assert.ok(cat.every((c) => c.unlocked), 'rich account: all unlocked');
  assert.strictEqual(cat.find((c) => c.key === 'plate_gold').equipped, true);
  assert.strictEqual(cat.find((c) => c.key === 'plate_steel').equipped, false);
  // a new account sees locked entries with the unlock hint intact
  const locked = Cosmetics.catalog(NEW, {}).find((c) => c.key === 'title_tycoon');
  assert.strictEqual(locked.unlocked, false);
  assert.ok(locked.desc);
});
