/* ==========================================================================
   GEARWORKS CORE — deterministic, instantiable simulation
   --------------------------------------------------------------------------
   This module contains everything that defines game STATE and how it
   evolves: world generation, the entity grid, the 20 Hz simulation
   (belts, machines, fluids, power), the economy, research, NPC company
   state, and the Command system through which ALL mutations flow.

   It runs identically in the browser (client) and in Node (authoritative
   server). Multiplayer correctness rests on three properties:

     1. DETERMINISM — given the same seed and the same ordered command
        stream, every instance computes bit-identical state. All
        state-affecting randomness goes through the seeded sim RNG;
        trigonometry in the sim uses a deterministic approximation
        (engine Math.sin implementations may differ); time is derived
        from the tick counter, never from wall clocks.

     2. COMMANDS — clients never mutate state directly. Every action
        (place, remove, rotate, paste, research, trade, …) is a command
        that is validated and ordered by the server, then applied by
        every instance at the same tick. Visual effects and sounds are
        surfaced through hooks so the sim itself stays side-effect free.

     3. SNAPSHOTS + HASHES — full state can be captured/restored (join,
        reconnect, saves) and hashed (divergence detection). The RNG
        state is part of the snapshot.

   Exported as `Core` in browsers and via module.exports in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var PROTO = 1;                       // network protocol version

/* ============================ UTIL ==================================== */
var Util = (function () {
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var TAU = Math.PI * 2;
  // deterministic hash-based value noise for infinite terrain
  function hash2(x, y, seed) {
    var h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valNoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    var c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    var u = smooth(xf), v = smooth(yf);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, seed, oct) {
    var f = 0, amp = 0.5, freq = 1, norm = 0;
    for (var i = 0; i < oct; i++) { f += amp * valNoise(x * freq, y * freq, seed + i * 97); norm += amp; amp *= 0.5; freq *= 2; }
    return f / norm;
  }
  // mulberry32 — used for the sim RNG stream; state is a 32-bit int
  function mulberry32Step(a) {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return { a: a, v: ((t ^ t >>> 14) >>> 0) / 4294967296 };
  }
  // Deterministic sine (Bhaskara I approximation). Engine Math.sin may
  // differ across browsers; the sim must not depend on it. Max error
  // ~0.0016 — irrelevant for power curves, vital for determinism.
  function dsin(x) {
    x = x % TAU; if (x < 0) x += TAU;
    var sign = 1;
    if (x > Math.PI) { x -= Math.PI; sign = -1; }
    var num = 16 * x * (Math.PI - x);
    return sign * num / (5 * Math.PI * Math.PI - 4 * x * (Math.PI - x));
  }
  // FNV-1a 32-bit over a string — state hashing for divergence detection
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.floor(n).toString();
  }
  return { clamp: clamp, lerp: lerp, TAU: TAU, hash2: hash2, valNoise: valNoise, fbm: fbm,
    mulberry32Step: mulberry32Step, dsin: dsin, fnv1a: fnv1a, fmt: fmt, smooth: smooth };
})();

/* ============================ CONFIG ================================== */
var Config = (function () {
  var TILE = 40;                 // world units per tile
  var CHUNK = 16;                // tiles per chunk edge
  var SIM_HZ = 20;               // fixed simulation rate (server-paced)

  var RES = {
    iron:   { name: 'Iron',    color: '#9aa7b4' },
    copper: { name: 'Copper',  color: '#c87c4b' },
    coal:   { name: 'Coal',    color: '#3a3f45' },
    stone:  { name: 'Stone',   color: '#8a8577' },
    oil:    { name: 'Oil',     color: '#20242a' },
    uranium:{ name: 'Uranium', color: '#5fe27a' },
    sand:   { name: 'Sand',    color: '#d8c48a' },
  };

  var ITEM = {
    iron: { name: 'Iron Ore', color: '#9aa7b4' }, copper: { name: 'Copper Ore', color: '#c87c4b' },
    coal: { name: 'Coal', color: '#3a3f45' }, stone: { name: 'Stone', color: '#8a8577' },
    sand: { name: 'Sand', color: '#d8c48a' }, uranium: { name: 'Uranium', color: '#5fe27a' },
    iron_plate: { name: 'Iron Plate', color: '#c2ccd6' }, copper_plate: { name: 'Copper Plate', color: '#e0a074' },
    steel: { name: 'Steel', color: '#7f8c99' }, glass: { name: 'Glass', color: '#9fd8e0' },
    plastic: { name: 'Plastic', color: '#d76fb0' }, electronics: { name: 'Electronics', color: '#5fd67a' },
    machine: { name: 'Machine', color: '#c9a24b' }, adv_machine: { name: 'Adv. Machine', color: '#ffd873' },
    water: { name: 'Water', color: '#3a7bd5', fluid: true }, oil: { name: 'Crude Oil', color: '#15181c', fluid: true },
  };

  var RECIPES = {
    iron_plate:   { out: 'iron_plate',   time: 20,  in: { iron: 1 },                     cat: 'smelt' },
    copper_plate: { out: 'copper_plate', time: 20,  in: { copper: 1 },                   cat: 'smelt' },
    glass:        { out: 'glass',        time: 24,  in: { sand: 1 },                     cat: 'smelt' },
    steel:        { out: 'steel',        time: 60,  in: { iron_plate: 2, coal: 1 },      cat: 'smelt' },
    plastic:      { out: 'plastic',      time: 24,  in: { oil: 2 },                      cat: 'assemble', fluidIn: true },
    electronics:  { out: 'electronics',  time: 36,  in: { plastic: 1, copper_plate: 1 }, cat: 'assemble' },
    machine:      { out: 'machine',      time: 60,  in: { electronics: 2, steel: 1 },    cat: 'assemble' },
    adv_machine:  { out: 'adv_machine',  time: 120, in: { machine: 1, electronics: 3 },  cat: 'assemble' },
  };

  var B = {
    miner:      { name: 'Miner',        w: 2, h: 2, cost: 60,  power: 0,    cat: 'produce', needsOre: true, burner: true, tool: true, tech: null },
    furnace:    { name: 'Furnace',      w: 2, h: 2, cost: 40,  power: 0,    cat: 'produce', recipeCat: 'smelt', burner: true, tool: true },
    assembler:  { name: 'Assembler',    w: 3, h: 3, cost: 120, power: -140, cat: 'produce', recipeCat: 'assemble', tool: true, tech: 'automation' },
    storage:    { name: 'Storage',      w: 2, h: 2, cost: 30,  power: 0,    cat: 'logi', store: true, tool: true },
    splitter:   { name: 'Splitter',     w: 1, h: 1, cost: 20,  power: 0,    cat: 'logi', tool: true },
    merger:     { name: 'Merger',       w: 1, h: 1, cost: 20,  power: 0,    cat: 'logi', tool: true },
    belt:       { name: 'Conveyor',     w: 1, h: 1, cost: 4,   power: 0,    cat: 'logi', belt: true, tool: true, drag: true },
    ubelt:      { name: 'U-Belt',       w: 1, h: 1, cost: 16,  power: 0,    cat: 'logi', tool: true, tech: 'logistics' },
    pump:       { name: 'Pump',         w: 1, h: 1, cost: 24,  power: -20,  cat: 'fluid', tool: true, tech: 'fluids' },
    extractor:  { name: 'Water Pump',   w: 2, h: 2, cost: 50,  power: -40,  cat: 'fluid', needsWater: true, tool: true, tech: 'fluids', produces: 'water' },
    pipe:       { name: 'Pipe',         w: 1, h: 1, cost: 5,   power: 0,    cat: 'fluid', pipe: true, tool: true, drag: true, tech: 'fluids' },
    oilrig:     { name: 'Oil Rig',      w: 3, h: 3, cost: 180, power: -120, cat: 'fluid', needsOilRes: true, tool: true, tech: 'fluids', produces: 'oil' },
    solar:      { name: 'Solar Panel',  w: 3, h: 3, cost: 90,  power: 120,  cat: 'power', tool: true, tech: 'power' },
    wind:       { name: 'Wind Turbine', w: 2, h: 2, cost: 70,  power: 80,   cat: 'power', tool: true, tech: 'power' },
    battery:    { name: 'Battery',      w: 2, h: 2, cost: 110, power: 0,    cat: 'power', batt: true, tool: true, tech: 'power' },
    nuclear:    { name: 'Nuclear Plant',w: 3, h: 3, cost: 500, power: 400,  cat: 'power', tool: true, tech: 'nuclear' },
    pole:       { name: 'Power Pole',   w: 1, h: 1, cost: 8,   power: 0,    cat: 'power', pole: true, tool: true, drag: true },
    lab:        { name: 'Research Lab', w: 3, h: 3, cost: 150, power: -100, cat: 'special', lab: true, tool: true, tech: 'automation' },
    market:     { name: 'Market',       w: 2, h: 2, cost: 100, power: -20,  cat: 'special', market: true, tool: true },
    station:    { name: 'Train Station',w: 2, h: 4, cost: 200, power: -60,  cat: 'special', tool: true, tech: 'logistics' },
    tree:       { name: 'Tree',         w: 1, h: 1, cost: 2,   power: 0,    cat: 'deco', deco: true, tool: true },
    lamp:       { name: 'Lamp',         w: 1, h: 1, cost: 6,   power: -5,   cat: 'deco', deco: true, lamp: true, tool: true },
    road:       { name: 'Road',         w: 1, h: 1, cost: 3,   power: 0,    cat: 'logi', road: true, tool: true, drag: true },
  };

  // tech tree — tiers derive from prerequisite depth
  var TECH = {
    automation: { name: 'Automation', cost: { iron_plate: 40 }, desc: 'Unlocks Assemblers & Labs', req: [] },
    blueprints: { name: 'Blueprints', cost: { iron_plate: 30 }, desc: 'Unlocks the Blueprint Library (📐)', req: [] },
    logistics:  { name: 'Logistics',  cost: { iron_plate: 60, copper_plate: 20 }, desc: 'U-Belts, Splitter priority, Stations', req: ['automation'] },
    power:      { name: 'Power Grid', cost: { copper_plate: 60, iron_plate: 40 }, desc: 'Solar, Wind, Batteries', req: ['automation'] },
    smelting2:  { name: 'Adv. Smelting', cost: { iron_plate: 50, stone: 30 }, desc: '+50% furnace speed', req: ['automation'] },
    trading:    { name: 'Trade Contracts', cost: { copper_plate: 50 }, desc: '+15% sell prices', req: ['automation'] },
    express:    { name: 'Express Belts', cost: { steel: 30, copper_plate: 40 }, desc: '+50% belt speed', req: ['logistics'] },
    fluids:     { name: 'Fluid Handling', cost: { steel: 20, copper_plate: 40 }, desc: 'Pipes, Pumps, Oil, Water', req: ['power'] },
    trading2:   { name: 'Global Markets', cost: { electronics: 25, glass: 20 }, desc: '+35% sell prices (total)', req: ['trading', 'logistics'] },
    electronics:{ name: 'Electronics', cost: { electronics: 30 }, desc: '+50% assembler speed', req: ['fluids'] },
    robotics:   { name: 'Robotics',   cost: { machine: 20, electronics: 40 }, desc: '+100% mining speed', req: ['electronics'] },
    hyper:      { name: 'Hyper Logistics', cost: { machine: 15, steel: 60 }, desc: '+100% belt speed (total)', req: ['express', 'robotics'] },
    nuclear:    { name: 'Nuclear Power', cost: { machine: 25, uranium: 20 }, desc: 'Unlocks the Nuclear Plant (400 MW)', req: ['robotics'] },
    ai_core:    { name: 'AI Core', cost: { adv_machine: 10, electronics: 60 }, desc: '+25% speed on all machines', req: ['nuclear', 'hyper'] },
  };

  var MARKET = {
    iron: 2, copper: 3, coal: 2, stone: 1, sand: 1, uranium: 40,
    iron_plate: 6, copper_plate: 8, steel: 22, glass: 7, plastic: 14,
    electronics: 40, machine: 120, adv_machine: 400, water: 1, oil: 5,
  };

  var AI_NAMES = ['Ironclad Ltd', 'NovaFab', 'Cogsworth Co', 'Vortex Industries', 'Apex Mining'];
  var AI_COLORS = ['#ff7a7a', '#7CFC9E', '#ffd873', '#4aa3ff', '#d76fb0'];

  return { TILE: TILE, CHUNK: CHUNK, SIM_HZ: SIM_HZ, RES: RES, ITEM: ITEM, RECIPES: RECIPES,
    B: B, TECH: TECH, MARKET: MARKET, AI_NAMES: AI_NAMES, AI_COLORS: AI_COLORS };
})();

/* ====================================================================== */
/*  GAME FACTORY — every room/instance gets its own isolated state        */
/* ====================================================================== */
function createGame(opts) {
  opts = opts || {};
  var seed = (opts.seed !== undefined ? opts.seed : (Math.random() * 1e9) | 0) >>> 0;

  /* ------------- top-level mutable state (snapshot boundary) ---------- */
  var S = {
    tick: 0,
    money: 500,
    inv: { iron: 0, copper: 0, iron_plate: 20, copper_plate: 10 },
    weather: 'clear',
    dayLength: 120,
    moneyHistory: [500],
    stats: { produced: {}, itemsOnBelts: 0 },
  };
  var rngA = (seed ^ 0x9E3779B9) | 0;   // sim RNG state — snapshot-carried

  // hooks: pure outputs. fx(type, x, y, extra) — visual/audio effects the
  // client may render; event(name, data) — gameplay events for UI (toasts,
  // panel refreshes). The server leaves these as no-ops.
  var hooks = { fx: null, event: null };
  function fx(type, x, y, extra) { if (hooks.fx) hooks.fx(type, x, y, extra); }
  function emit(name, data) { if (hooks.event) hooks.event(name, data); }

  function rand() { var r = Util.mulberry32Step(rngA); rngA = r.a; return r.v; }
  function timeOfDay() { return ((S.tick / Config.SIM_HZ) % S.dayLength) / S.dayLength; }

  /* ============================ WORLD ================================= */
  var World = (function () {
    var chunks = new Map();
    var CH = Config.CHUNK;
    function key(cx, cy) { return cx + ',' + cy; }
    function genChunk(cx, cy) {
      var tiles = new Array(CH * CH);
      for (var ty = 0; ty < CH; ty++) {
        for (var tx = 0; tx < CH; tx++) {
          var wx = cx * CH + tx, wy = cy * CH + ty;
          var e = Util.fbm(wx * 0.03, wy * 0.03, seed, 4);
          var m = Util.fbm(wx * 0.05 + 100, wy * 0.05 + 100, seed, 3);
          var tile = { r: null, amt: 0, water: false, biome: 0 };
          if (m > 0.66 && e < 0.45) { tile.water = true; tile.biome = 2; }
          else {
            var rn = Util.fbm(wx * 0.04 + 300, wy * 0.04 + 300, seed + 7, 3);
            if (e > 0.62) tile.biome = 1;
            var patch = Util.fbm(wx * 0.08, wy * 0.08, seed + 50, 2);
            if (patch > 0.72) {
              var sel = Util.hash2(Math.floor(wx / 6), Math.floor(wy / 6), seed + 11);
              var r;
              if (sel < 0.28) r = 'iron'; else if (sel < 0.5) r = 'copper';
              else if (sel < 0.66) r = 'coal'; else if (sel < 0.8) r = 'stone';
              else if (sel < 0.9) r = 'sand'; else if (sel < 0.97) r = 'oil'; else r = 'uranium';
              tile.r = r;
              tile.amt = Math.floor(4000 + rn * 16000);
            }
          }
          tiles[ty * CH + tx] = tile;
        }
      }
      return { tiles: tiles, cx: cx, cy: cy };
    }
    function chunkAt(cx, cy) {
      var k = key(cx, cy);
      var c = chunks.get(k);
      if (!c) { c = genChunk(cx, cy); chunks.set(k, c); }
      return c;
    }
    function tileAt(tx, ty) {
      var cx = Math.floor(tx / CH), cy = Math.floor(ty / CH);
      var c = chunkAt(cx, cy);
      return c.tiles[(ty - cy * CH) * CH + (tx - cx * CH)];
    }
    function mineOre(tx, ty, n) {
      var t = tileAt(tx, ty);
      if (!t.r || t.amt <= 0) return 0;
      var got = Math.min(n, t.amt); t.amt -= got;
      if (t.amt <= 0) t.r = null;
      return got;
    }
    // save only tiles that differ from fresh generation
    function serializeDeltas() {
      var out = [];
      chunks.forEach(function (c) {
        var fresh = genChunk(c.cx, c.cy);
        for (var i = 0; i < c.tiles.length; i++) {
          if (c.tiles[i].amt !== fresh.tiles[i].amt || c.tiles[i].r !== fresh.tiles[i].r) {
            out.push([c.cx, c.cy, i, c.tiles[i].amt, c.tiles[i].r]);
          }
        }
      });
      return out;
    }
    function applyDeltas(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var c = chunkAt(d[0], d[1]); c.tiles[d[2]].amt = d[3]; c.tiles[d[2]].r = d[4];
      }
    }
    function clear() { chunks.clear(); }
    return { tileAt: tileAt, mineOre: mineOre, chunkAt: chunkAt, serializeDeltas: serializeDeltas,
      applyDeltas: applyDeltas, clear: clear };
  })();

  /* ============================ GRID ================================== */
  var Grid = (function () {
    var cells = new Map();
    var entities = new Map();
    var nextId = 1;
    function key(tx, ty) { return tx + ',' + ty; }
    function entAt(tx, ty) { var id = cells.get(key(tx, ty)); return id ? entities.get(id) : null; }
    function canPlace(tx, ty, w, h) {
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (cells.has(key(tx + x, ty + y))) return false;
      return true;
    }
    function place(ent) {
      ent.id = nextId++; entities.set(ent.id, ent);
      for (var y = 0; y < ent.h; y++) for (var x = 0; x < ent.w; x++) cells.set(key(ent.tx + x, ent.ty + y), ent.id);
      return ent;
    }
    function remove(ent) {
      if (!ent) return;
      for (var y = 0; y < ent.h; y++) for (var x = 0; x < ent.w; x++) cells.delete(key(ent.tx + x, ent.ty + y));
      entities.delete(ent.id);
    }
    function clear() { cells.clear(); entities.clear(); nextId = 1; }
    return { cells: cells, entities: entities, entAt: entAt, canPlace: canPlace, place: place, remove: remove,
      clear: clear, getNextId: function () { return nextId; }, setNextId: function (v) { nextId = v; } };
  })();

  /* ============================ ECONOMY =============================== */
  var Economy = (function () {
    var price = {}, demand = {}, history = {};
    function init() {
      for (var k in Config.MARKET) { price[k] = Config.MARKET[k]; demand[k] = 0; history[k] = [price[k]]; }
    }
    init();
    function tick() {
      for (var k in price) {
        var base = Config.MARKET[k];
        price[k] += (base - price[k]) * 0.02;
        price[k] += demand[k] * 0.004;
        demand[k] *= 0.9;
        price[k] = Util.clamp(price[k], base * 0.3, base * 3);
      }
    }
    function record() {
      for (var k in price) { var h = history[k]; h.push(price[k]); if (h.length > 120) h.shift(); }
    }
    function sellMult() { return Research.done.has('trading2') ? 1.35 : Research.done.has('trading') ? 1.15 : 1; }
    function sell(item, qty) {
      var p = price[item] || 1; var total = p * qty * sellMult();
      demand[item] -= qty;
      return total;
    }
    function buy(item, qty) {
      var p = price[item] || 1; var total = p * qty * 1.15;
      demand[item] += qty;
      return total;
    }
    return { price: price, demand: demand, history: history, tick: tick, record: record, sell: sell, buy: buy };
  })();

  /* ============================ RESEARCH ============================== */
  var Research = (function () {
    var done = new Set();
    function isUnlocked(t) { return !t || done.has(t); }
    function canResearch(id) {
      var t = Config.TECH[id]; if (!t || done.has(id)) return false;
      return t.req.every(function (r) { return done.has(r); });
    }
    return { done: done, isUnlocked: isUnlocked, canResearch: canResearch };
  })();

  /* ============================ AI STATE ============================== */
  // Company STATE lives in the deterministic sim; company DECISIONS are
  // made only by the server (AIThink below) and arrive as 'ai' commands.
  var AI = (function () {
    var companies = [];
    function init(n) {
      companies.length = 0;
      for (var i = 0; i < n; i++) {
        companies.push({
          name: Config.AI_NAMES[i % Config.AI_NAMES.length], money: 500 + i * 100, tech: 0,
          factories: 1, color: Config.AI_COLORS[i % 5],
          aggr: 0.4 + Util.hash2(i, 7, seed) * 0.5,
          tx: ((Util.hash2(i, 1, seed) * 400 - 200) | 0), ty: ((Util.hash2(i, 2, seed) * 400 - 200) | 0),
        });
      }
    }
    init(4);
    function leader() { return companies.slice().sort(function (a, b) { return b.money - a.money; }); }
    // deterministic application of server-issued AI operations
    function applyOps(ops) {
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i]; var c = companies[op[0]]; if (!c) continue;
        switch (op[1]) {
          case 'gain': c.money += op[2]; break;
          case 'trade': Economy.demand[op[2]] -= op[3]; break;
          case 'fac': c.money -= op[2]; c.factories++; break;
          case 'tech': c.money -= op[2]; c.tech++; emit('aiTech', { name: c.name, tech: c.tech }); break;
        }
      }
    }
    return { companies: companies, leader: leader, applyOps: applyOps, init: init };
  })();

  // Server-side decision making (also used by the singleplayer local loop,
  // where the client IS the server). May use nondeterministic randomness —
  // its OUTPUT travels as an ordered command, so every client applies the
  // same decisions.
  function aiThink(random) {
    random = random || Math.random;
    var ops = [];
    for (var i = 0; i < AI.companies.length; i++) {
      var c = AI.companies[i];
      var rate = c.factories * (1 + c.tech * 0.5);
      ops.push([i, 'gain', Math.round(rate * (2 + c.tech) * 100) / 100]);
      var good = ['iron_plate', 'copper_plate', 'steel', 'electronics'][c.tech % 4];
      ops.push([i, 'trade', good, Math.round(rate * 0.3 * c.aggr * 100) / 100]);
      if (c.money > 400 + c.factories * 300) ops.push([i, 'fac', 300 + c.factories * 100]);
      if (c.money > 600 && random() < 0.02 * c.aggr) ops.push([i, 'tech', 400]);
    }
    return ops;
  }

  /* ============================ SIM =================================== */
  var Sim = (function () {
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var SMELT_INPUTS = new Set(['iron', 'copper', 'sand', 'iron_plate', 'coal']);
    var powerAvail = 0, powerDemand = 0, powerSatisfied = 1, battStored = 0, battMax = 0;

    function outTile(e) {
      var ox = e.tx, oy = e.ty;
      if (e.rot === 0) { ox = e.tx + ((e.w - 1) >> 1); oy = e.ty - 1; }
      else if (e.rot === 1) { ox = e.tx + e.w; oy = e.ty + ((e.h - 1) >> 1); }
      else if (e.rot === 2) { ox = e.tx + ((e.w - 1) >> 1); oy = e.ty + e.h; }
      else { ox = e.tx - 1; oy = e.ty + ((e.h - 1) >> 1); }
      return [ox, oy];
    }

    function countProduced(item) { S.stats.produced[item] = (S.stats.produced[item] || 0) + 1; }

    function tryInsert(tx, ty, item) {
      var e = Grid.entAt(tx, ty);
      if (!e) return false;
      var B = Config.B[e.type];
      if (B.belt) {
        if (e.items.length < 4) { e.items.push({ item: item, pos: 0 }); return true; }
        return false;
      }
      if (B.road) return false;
      if (B.store) { e.buf[item] = (e.buf[item] || 0) + 1; return true; }
      if (B.market) {
        S.money += Economy.sell(item, 1); e.sold = (e.sold || 0) + 1;
        return true;
      }
      if (B.lab) { e.buf[item] = (e.buf[item] || 0) + 1; return true; }
      if (B.recipeCat || e.recipe) {
        var r = Config.RECIPES[e.recipe];
        if (r && r.in[item] !== undefined) { e.in[item] = (e.in[item] || 0) + 1; return true; }
        if (!e.recipe && B.recipeCat === 'smelt' && SMELT_INPUTS.has(item)) { e.in[item] = (e.in[item] || 0) + 1; return true; }
        return false;
      }
      if (e.type === 'splitter' || e.type === 'merger') {
        if (e.items.length < 2) { e.items.push({ item: item, pos: 0 }); return true; }
      }
      return false;
    }

    function updateBelts() {
      var onBelts = 0;
      var beltMult = Research.done.has('hyper') ? 2 : Research.done.has('express') ? 1.5 : 1;
      Grid.entities.forEach(function (e) {
        var B = Config.B[e.type];
        if (!B.belt) return;
        var speed = 0.5 * beltMult;
        onBelts += e.items.length;
        for (var i = e.items.length - 1; i >= 0; i--) {
          var it = e.items[i];
          var ahead = i < e.items.length - 1 ? e.items[i + 1].pos - 0.28 : 1;
          it.pos = Math.min(it.pos + speed * 0.1, Math.min(1, ahead));
          if (it.pos >= 1) {
            var o = outTile(e);
            if (tryInsert(o[0], o[1], it.item)) e.items.splice(i, 1);
            else it.pos = 1;
          }
        }
      });
      S.stats.itemsOnBelts = onBelts;
    }

    function splitterOutputs(e) {
      var fwd = outTile(e);
      var r = (e.rot + 1) % 4, d = DIRS[r];
      return [fwd, [e.tx + d[0], e.ty + d[1]]];
    }

    function updateSplitters() {
      Grid.entities.forEach(function (e) {
        if (e.type !== 'splitter' && e.type !== 'merger') return;
        if (e.items.length === 0) return;
        var it = e.items[0];
        it.pos = Math.min(it.pos + 0.15, 1);
        if (it.pos < 1) return;
        if (e.type === 'splitter') {
          var outs = splitterOutputs(e);
          var order = e.flip ? [outs[1], outs[0]] : [outs[0], outs[1]];
          for (var i = 0; i < order.length; i++) {
            var o = order[i];
            if (o && tryInsert(o[0], o[1], it.item)) { e.items.shift(); e.flip = !e.flip; return; }
          }
        } else {
          var o2 = outTile(e);
          if (tryInsert(o2[0], o2[1], it.item)) e.items.shift();
        }
      });
    }

    function updateUnderground() {
      Grid.entities.forEach(function (e) {
        if (e.type !== 'ubelt') return;
        if (!e.items) e.items = [];
        if (e.items.length === 0) return;
        var it = e.items[0]; it.pos = Math.min(it.pos + 0.12, 1);
        if (it.pos < 1) return;
        var d = DIRS[e.rot];
        for (var dist = 2; dist <= 6; dist++) {
          var tx = e.tx + d[0] * dist, ty = e.ty + d[1] * dist;
          var t = Grid.entAt(tx, ty);
          if (t && t.type === 'ubelt') { if (tryInsert(tx + d[0], ty + d[1], it.item)) e.items.shift(); break; }
        }
      });
    }

    // Burners run without grid power; others degrade with brownouts.
    // NOTE: uses the seeded sim RNG — this randomness affects state.
    function powered(e) { return Config.B[e.type].burner || powerSatisfied >= 1 || rand() < powerSatisfied; }

    function updateMiner(e) {
      if (!powered(e)) { e.working = false; return; }
      var t = World.tileAt(e.oreX, e.oreY);
      if (!t || !t.r || t.amt <= 0) { e.working = false; return; }
      e.working = true;
      var rate = (Research.done.has('robotics') ? 2 : 1) * (Research.done.has('ai_core') ? 1.25 : 1);
      e.prog = (e.prog || 0) + 0.1 * rate;
      if (e.prog >= 1) {
        e.prog = 0;
        var got = World.mineOre(e.oreX, e.oreY, 1);
        if (got > 0) {
          var o = outTile(e);
          if (!tryInsert(o[0], o[1], t.r)) { e.hold = (e.hold || 0) + got; if (e.hold > 50) e.hold = 50; }
          else if (e.hold > 0) e.hold--;
          countProduced(t.r);
          fx('smoke', e.cx, e.cy - e.h * Config.TILE * 0.3);
        }
      }
    }

    function updateFluidSource(e, B) {
      if (!powered(e)) { e.working = false; return; }
      e.working = true;
      e.fluid = (e.fluid || 0);
      if (e.fluid < 200) { e.fluid += B.produces === 'oil' ? 1.5 : 3; countProduced(B.produces); }
      var o = outTile(e);
      var pipe = Grid.entAt(o[0], o[1]);
      if (pipe && Config.B[pipe.type].pipe && e.fluid > 0) {
        var give = Math.min(e.fluid, 20 - (pipe.fluidAmt || 0));
        if (give > 0) { pipe.fluid = B.produces; pipe.fluidAmt = (pipe.fluidAmt || 0) + give; e.fluid -= give; }
      }
    }

    function updateCrafter(e, B) {
      if (!e.recipe) {
        if (B.recipeCat === 'smelt') {
          if ((e.in.iron || 0) > 0) e.recipe = 'iron_plate';
          else if ((e.in.copper || 0) > 0) e.recipe = 'copper_plate';
          else if ((e.in.sand || 0) > 0) e.recipe = 'glass';
          else if ((e.in.iron_plate || 0) >= 2 && (e.in.coal || 0) >= 1) e.recipe = 'steel';
        }
        if (!e.recipe) { e.working = false; return; }
      }
      var r = Config.RECIPES[e.recipe];
      if (!r) { e.working = false; return; }
      if (e.crafting) {
        if (!powered(e)) { e.working = false; return; }
        e.working = true;
        var spd = 1;
        if (B.recipeCat === 'assemble' && Research.done.has('electronics')) spd *= 1.5;
        if (B.recipeCat === 'smelt' && Research.done.has('smelting2')) spd *= 1.5;
        if (Research.done.has('ai_core')) spd *= 1.25;
        e.prog += spd / r.time;
        if (B.recipeCat === 'smelt') fx('smoke', e.cx, e.cy - e.h * Config.TILE * 0.35);
        if (e.prog >= 1) {
          e.crafting = false; e.prog = 0;
          e.out[r.out] = (e.out[r.out] || 0) + 1; countProduced(r.out);
        }
      } else {
        var ok = true;
        for (var it in r.in) {
          if (r.fluidIn && Config.ITEM[it].fluid) { if ((e.fluidBuf || 0) < r.in[it]) ok = false; }
          else if ((e.in[it] || 0) < r.in[it]) ok = false;
        }
        if (ok) {
          for (var it2 in r.in) {
            if (r.fluidIn && Config.ITEM[it2].fluid) e.fluidBuf -= r.in[it2];
            else e.in[it2] -= r.in[it2];
          }
          e.crafting = true; e.prog = 0;
        } else e.working = false;
      }
      if (r.fluidIn) {
        var need = null;
        for (var k in r.in) { if (Config.ITEM[k].fluid) { need = k; break; } }
        if ((e.fluidBuf || 0) < 10) {
          for (var di = 0; di < 4; di++) {
            var p = Grid.entAt(e.tx + DIRS[di][0], e.ty + DIRS[di][1]);
            if (p && Config.B[p.type].pipe && p.fluid === need && p.fluidAmt > 0) {
              var g = Math.min(p.fluidAmt, 5); p.fluidAmt -= g; e.fluidBuf = (e.fluidBuf || 0) + g;
            }
          }
        }
      }
      for (var oi in e.out) {
        if (e.out[oi] > 0) {
          var ot = outTile(e);
          if (tryInsert(ot[0], ot[1], oi)) e.out[oi]--;
        }
      }
    }

    function updateLab(e) { e.working = powered(e); }

    function updateMachines() {
      Grid.entities.forEach(function (e) {
        var B = Config.B[e.type];
        if (B.needsOre) { updateMiner(e); return; }
        if (B.produces === 'water' || B.produces === 'oil') { updateFluidSource(e, B); return; }
        if (B.recipeCat) { updateCrafter(e, B); return; }
        if (B.lab) { updateLab(e); return; }
      });
    }

    function updateFluids() {
      Grid.entities.forEach(function (e) {
        var B = Config.B[e.type];
        if (!B.pipe && e.type !== 'pump') return;
        if (!e.fluidAmt) e.fluidAmt = 0;
        for (var di = 0; di < 4; di++) {
          var n = Grid.entAt(e.tx + DIRS[di][0], e.ty + DIRS[di][1]);
          if (!n) continue; var NB = Config.B[n.type];
          if (!NB.pipe && n.type !== 'pump') continue;
          if (e.fluid && n.fluid && e.fluid !== n.fluid) continue;
          var total = (e.fluidAmt || 0) + (n.fluidAmt || 0);
          if (total <= 0) continue;
          var f = e.fluid || n.fluid;
          var flow = ((e.fluidAmt || 0) - (n.fluidAmt || 0)) * 0.25;
          if (e.type === 'pump') flow = Math.max(flow, (e.fluidAmt || 0) * 0.5);
          if (flow > 0) { e.fluidAmt -= flow; n.fluidAmt = (n.fluidAmt || 0) + flow; n.fluid = f; }
        }
      });
    }

    function updatePower() {
      var gen = 0, use = 0, bMax = 0, bStore = 0;
      var tod = timeOfDay();
      Grid.entities.forEach(function (e) {
        var B = Config.B[e.type];
        if (B.burner) return;
        if (B.batt) { bMax += 200; bStore += (e.stored || 0); return; }
        if (B.power > 0) {
          var p = B.power;
          if (e.type === 'solar') p *= Math.max(0, Util.dsin(tod * Math.PI));
          if (e.type === 'wind') p *= 0.5 + 0.5 * Math.abs(Util.dsin(S.tick / Config.SIM_HZ * 0.3 + e.id));
          gen += p; e.gen = p;
        } else if (B.power < 0) {
          if (e.working || e.crafting || (!B.recipeCat && !B.needsOre && !B.produces && !B.lab)) use += -B.power;
          else if (e.working !== false) use += -B.power * 0.2;
        }
      });
      powerAvail = gen; powerDemand = use; battMax = bMax; battStored = bStore;
      var net = gen - use;
      if (net >= 0) {
        powerSatisfied = 1;
        var charge = net;
        Grid.entities.forEach(function (e) {
          if (Config.B[e.type].batt) { var room = 200 - (e.stored || 0); var c = Math.min(room, charge * 0.1); e.stored = (e.stored || 0) + c; charge -= c; }
        });
      } else {
        var deficit = -net;
        Grid.entities.forEach(function (e) {
          if (Config.B[e.type].batt && (e.stored || 0) > 0) { var d = Math.min(e.stored, deficit * 0.1); e.stored -= d; deficit -= d; }
        });
        powerSatisfied = use > 0 ? Util.clamp((gen + battStored * 0.1) / use, 0, 1) : 1;
      }
    }

    function tick() {
      updateMachines();
      updateBelts();
      updateSplitters();
      updateUnderground();
      updateFluids();
      updatePower();
      // slow-cadence systems: once per sim second
      if (S.tick % Config.SIM_HZ === 0) {
        Economy.tick();
        Economy.record();
        S.moneyHistory.push(S.money);
        if (S.moneyHistory.length > 120) S.moneyHistory.shift();
      }
      S.tick++;
    }

    return { tick: tick, DIRS: DIRS, outTile: outTile, tryInsert: tryInsert,
      get powerAvail() { return powerAvail; }, get powerDemand() { return powerDemand; },
      get powerSatisfied() { return powerSatisfied; }, get battStored() { return battStored; },
      get battMax() { return battMax; }, get stats() { return S.stats; } };
  })();

  /* ============================ ENTITY helpers ======================== */
  function makeEntity(type, tx, ty, r) {
    var B = Config.B[type];
    var e = { type: type, tx: tx, ty: ty, w: B.w, h: B.h, rot: r || 0, id: 0,
      items: [], in: {}, out: {}, buf: {}, prog: 0, crafting: false, working: false };
    e.cx = (tx + B.w / 2) * Config.TILE; e.cy = (ty + B.h / 2) * Config.TILE;
    return e;
  }
  function bindOre(e) {
    var best = null, bestAmt = -1;
    for (var y = 0; y < e.h; y++) for (var x = 0; x < e.w; x++) {
      var t = World.tileAt(e.tx + x, e.ty + y);
      if (t.r && t.amt > bestAmt) { if (e.type === 'oilrig' && t.r !== 'oil') continue; bestAmt = t.amt; best = [e.tx + x, e.ty + y]; }
    }
    if (best) { e.oreX = best[0]; e.oreY = best[1]; }
  }
  // Every state-affecting entity field must survive serialization —
  // mid-craft progress included — or clients joining from a snapshot
  // would immediately diverge from the server.
  function serializeEnt(e) {
    return { t: e.type, x: e.tx, y: e.ty, r: e.rot, rec: e.recipe || null, in: e.in, out: e.out,
      buf: e.buf, items: e.items, stored: e.stored, fluid: e.fluid, fluidAmt: e.fluidAmt,
      fluidBuf: e.fluidBuf, oreX: e.oreX, oreY: e.oreY, sold: e.sold,
      prog: e.prog, cr: e.crafting, wk: e.working, hold: e.hold, flip: e.flip };
  }
  function restoreEnt(d) {
    var e = makeEntity(d.t, d.x, d.y, d.r);
    e.recipe = d.rec || undefined; e.in = d.in || {}; e.out = d.out || {}; e.buf = d.buf || {};
    e.items = d.items || []; e.stored = d.stored || 0; e.fluid = d.fluid; e.fluidAmt = d.fluidAmt || 0;
    e.fluidBuf = d.fluidBuf || 0; e.oreX = d.oreX; e.oreY = d.oreY; e.sold = d.sold || 0;
    e.prog = d.prog || 0; e.crafting = !!d.cr; e.working = !!d.wk; e.hold = d.hold || 0; e.flip = !!d.flip;
    Grid.place(e);
    return e;
  }

  /* ============================ COMMANDS ============================== */
  // Single choke point for every state mutation. `validate` answers
  // "may this player do this right now, against current state?" and is
  // what makes the server authoritative: it validates before admitting a
  // command to the tick stream, so no client-invented state can enter.
  // `apply` mutates and returns a result used for events/undo.
  var Commands = (function () {

    function canPlaceType(type, tx, ty) {
      var B = Config.B[type]; if (!B || !B.tool) return 'unknown building';
      if (B.tech && !Research.done.has(B.tech)) return 'tech locked';
      if (!Grid.canPlace(tx, ty, B.w, B.h)) return 'occupied';
      if (S.money < B.cost) return 'not enough money';
      if (B.needsOre) {
        var found = false;
        for (var y = 0; y < B.h; y++) for (var x = 0; x < B.w; x++) { var t = World.tileAt(tx + x, ty + y); if (t.r && t.amt > 0) found = true; }
        if (!found) return 'needs ore';
      }
      if (B.needsWater) {
        var fw = false;
        for (var y2 = 0; y2 < B.h; y2++) for (var x2 = 0; x2 < B.w; x2++) { if (World.tileAt(tx + x2, ty + y2).water) fw = true; }
        if (!fw) return 'needs water';
      }
      if (B.needsOilRes) {
        var fo = false;
        for (var y3 = 0; y3 < B.h; y3++) for (var x3 = 0; x3 < B.w; x3++) { var t3 = World.tileAt(tx + x3, ty + y3); if (t3.r === 'oil' && t3.amt > 0) fo = true; }
        if (!fo) return 'needs oil deposit';
      }
      if (!B.needsWater && !B.pipe) {
        for (var y4 = 0; y4 < B.h; y4++) for (var x4 = 0; x4 < B.w; x4++) { if (World.tileAt(tx + x4, ty + y4).water) return 'on water'; }
      }
      return null;
    }

    function doPlace(type, tx, ty, rot) {
      var B = Config.B[type];
      S.money -= B.cost;
      var e = makeEntity(type, tx, ty, rot);
      if (B.needsOre || B.needsOilRes) bindOre(e);
      Grid.place(e);
      fx('place', e.cx, e.cy, { type: type, cost: B.cost });
      return e;
    }

    // validate(cmd) -> null (ok) | reason string
    function validate(cmd) {
      switch (cmd.t) {
        case 'place': {
          if (!isFinite(cmd.x) || !isFinite(cmd.y)) return 'bad coords';
          return canPlaceType(cmd.type, cmd.x | 0, cmd.y | 0);
        }
        case 'remove': {
          var e = Grid.entities.get(cmd.id); if (!e) return 'gone';
          return null;
        }
        case 'removeMany': {
          if (!Array.isArray(cmd.ids)) return 'bad ids';
          return null; // per-id skip during apply
        }
        case 'restore': {
          var d = cmd.data; if (!d || !Config.B[d.t]) return 'bad data';
          var B = Config.B[d.t];
          if (!Grid.canPlace(d.x, d.y, B.w, B.h)) return 'occupied';
          if (S.money < (cmd.cost || 0)) return 'not enough money';
          return null;
        }
        case 'rotate': {
          var e2 = Grid.entities.get(cmd.id); if (!e2) return 'gone';
          return null;
        }
        case 'setRecipe': {
          var e3 = Grid.entities.get(cmd.id); if (!e3) return 'gone';
          if (cmd.recipe !== null && !Config.RECIPES[cmd.recipe]) return 'bad recipe';
          return null;
        }
        case 'collect': {
          var e4 = Grid.entities.get(cmd.id); if (!e4 || !Config.B[e4.type].store) return 'not storage';
          return null;
        }
        case 'paste': {
          if (!Array.isArray(cmd.cells) || cmd.cells.length > 400) return 'bad cells';
          return null; // per-cell validation during apply
        }
        case 'research': {
          if (!Research.canResearch(cmd.tech)) return 'prereqs not met';
          var t = Config.TECH[cmd.tech];
          for (var it in t.cost) { if ((S.inv[it] || 0) < t.cost[it]) return 'missing materials'; }
          return null;
        }
        case 'sell': {
          var q = cmd.qty | 0; if (q <= 0 || q > 1000) return 'bad qty';
          if (!Config.MARKET[cmd.item]) return 'bad item';
          if ((S.inv[cmd.item] || 0) < 1) return 'none to sell';
          return null;
        }
        case 'buy': {
          var q2 = cmd.qty | 0; if (q2 <= 0 || q2 > 1000) return 'bad qty';
          if (!Config.MARKET[cmd.item]) return 'bad item';
          if (S.money < (Economy.price[cmd.item] || 1) * q2 * 1.15) return 'not enough money';
          return null;
        }
        case 'setWeather': return ['clear', 'rain', 'fog'].indexOf(cmd.w) < 0 ? 'bad weather' : null;
        case 'setDayLen': return (cmd.v >= 30 && cmd.v <= 300) ? null : 'bad value';
        case 'ai': return Array.isArray(cmd.ops) ? null : 'bad ops';
        default: return 'unknown command';
      }
    }

    // roles allowed to issue each command type (server enforces)
    var PERMS = {
      place: 'player', remove: 'player', removeMany: 'player', restore: 'player', rotate: 'player',
      setRecipe: 'player', collect: 'player', paste: 'player', research: 'player',
      sell: 'player', buy: 'player',
      setWeather: 'admin', setDayLen: 'admin',
      ai: 'server',
    };

    // apply(cmd) -> result object (already validated). Deterministic.
    function apply(cmd) {
      switch (cmd.t) {
        case 'place': {
          var e = doPlace(cmd.type, cmd.x | 0, cmd.y | 0, (cmd.rot | 0) % 4);
          if (cmd.recipe && Config.RECIPES[cmd.recipe]) e.recipe = cmd.recipe;
          return { id: e.id, cost: Config.B[cmd.type].cost };
        }
        case 'remove': {
          var e2 = Grid.entities.get(cmd.id);
          var refund = Math.floor(Config.B[e2.type].cost * 0.5);
          S.money += refund;
          var data = serializeEnt(e2);
          Grid.remove(e2);
          fx('remove', e2.cx, e2.cy);
          return { data: data, refund: refund };
        }
        case 'removeMany': {
          var removed = [];
          for (var i = 0; i < cmd.ids.length; i++) {
            var em = Grid.entities.get(cmd.ids[i]); if (!em) continue;
            S.money += Math.floor(Config.B[em.type].cost * 0.5);
            removed.push(serializeEnt(em));
            Grid.remove(em);
          }
          return { removed: removed };
        }
        case 'restore': {
          S.money -= (cmd.cost || 0);
          var er = restoreEnt(cmd.data);
          return { id: er.id };
        }
        case 'rotate': {
          var e3 = Grid.entities.get(cmd.id);
          Grid.remove(e3);
          var old = e3.rot;
          e3.rot = (e3.rot + 1) % 4;
          // preserve original semantics: revert if footprint now collides
          if (!Grid.canPlace(e3.tx, e3.ty, e3.w, e3.h)) e3.rot = old;
          Grid.place(e3);
          return { rot: e3.rot };
        }
        case 'setRecipe': {
          var e4 = Grid.entities.get(cmd.id);
          e4.recipe = cmd.recipe || undefined; e4.crafting = false; e4.prog = 0;
          return {};
        }
        case 'collect': {
          var e5 = Grid.entities.get(cmd.id);
          var moved = {};
          for (var it in e5.buf) { if (e5.buf[it] > 0) { S.inv[it] = (S.inv[it] || 0) + e5.buf[it]; moved[it] = e5.buf[it]; e5.buf[it] = 0; } }
          return { moved: moved };
        }
        case 'paste': {
          var placed = [];
          for (var ci = 0; ci < cmd.cells.length; ci++) {
            var c = cmd.cells[ci];
            var tx = (cmd.x | 0) + (c.dx | 0), ty = (cmd.y | 0) + (c.dy | 0);
            if (canPlaceType(c.type, tx, ty) !== null) continue;
            var ep = doPlace(c.type, tx, ty, (c.rot | 0) % 4);
            if (c.recipe && Config.RECIPES[c.recipe]) ep.recipe = c.recipe;
            placed.push(ep.id);
          }
          emit('paste', { by: cmd._p, count: placed.length });
          return { ids: placed };
        }
        case 'research': {
          var t = Config.TECH[cmd.tech];
          for (var it2 in t.cost) S.inv[it2] -= t.cost[it2];
          Research.done.add(cmd.tech);
          emit('research', { tech: cmd.tech, by: cmd._p });
          return {};
        }
        case 'sell': {
          var n = Math.min(S.inv[cmd.item] || 0, cmd.qty | 0);
          S.inv[cmd.item] -= n;
          var got = Economy.sell(cmd.item, n);
          S.money += got;
          return { n: n, got: got };
        }
        case 'buy': {
          var q = cmd.qty | 0;
          var cost = Economy.buy(cmd.item, q);
          S.money -= cost;
          S.inv[cmd.item] = (S.inv[cmd.item] || 0) + q;
          return { cost: cost };
        }
        case 'setWeather': { S.weather = cmd.w; emit('weather', { w: cmd.w }); return {}; }
        case 'setDayLen': { S.dayLength = +cmd.v; return {}; }
        case 'ai': { AI.applyOps(cmd.ops); return {}; }
      }
      return {};
    }

    return { validate: validate, apply: apply, canPlaceType: canPlaceType, PERMS: PERMS };
  })();

  /* ============================ TICK DRIVER =========================== */
  // Advance exactly one tick, applying the given ordered command list
  // first. This is THE synchronization primitive: every instance calls
  // it with identical arguments in identical order.
  function tickOnce(cmds) {
    if (cmds) {
      for (var i = 0; i < cmds.length; i++) {
        var cmd = cmds[i];
        // guard: a diverged client must not crash; hash check will catch it
        try {
          var res = Commands.apply(cmd);
          emit('applied', { cmd: cmd, res: res });
        } catch (err) {
          emit('applyError', { cmd: cmd, err: String(err) });
        }
      }
    }
    Sim.tick();
  }

  /* ============================ SNAPSHOT ============================== */
  var Snapshot = (function () {
    function capture() {
      var ents = [];
      Grid.entities.forEach(function (e) { var d = serializeEnt(e); d.id = e.id; ents.push(d); });
      return {
        v: 2, proto: PROTO, seed: seed,
        tick: S.tick, money: S.money, inv: S.inv, weather: S.weather, dayLength: S.dayLength,
        moneyHistory: S.moneyHistory, stats: S.stats,
        rng: rngA,
        ents: ents, nextId: Grid.getNextId(),
        worldDeltas: World.serializeDeltas(),
        research: Array.from(Research.done),
        economy: { price: Economy.price, demand: Economy.demand, history: Economy.history },
        ai: AI.companies,
      };
    }
    function restore(d) {
      World.clear(); Grid.clear();
      S.tick = d.tick || 0; S.money = d.money || 500; S.inv = d.inv || {};
      S.weather = d.weather || 'clear'; S.dayLength = d.dayLength || 120;
      S.moneyHistory = d.moneyHistory || [S.money];
      S.stats = d.stats || { produced: {}, itemsOnBelts: 0 };
      rngA = (d.rng !== undefined ? d.rng : (seed ^ 0x9E3779B9)) | 0;
      World.applyDeltas(d.worldDeltas);
      Research.done.clear();
      (d.research || []).forEach(function (r) { Research.done.add(r); });
      for (var k in Config.MARKET) {
        Economy.price[k] = (d.economy && d.economy.price[k] !== undefined) ? d.economy.price[k] : Config.MARKET[k];
        Economy.demand[k] = (d.economy && d.economy.demand[k]) || 0;
        Economy.history[k] = (d.economy && d.economy.history && d.economy.history[k]) || [Economy.price[k]];
      }
      AI.companies.length = 0;
      (d.ai || []).forEach(function (c) { AI.companies.push(c); });
      if (!AI.companies.length) AI.init(4);
      // entities in saved (insertion) order keeps Map iteration deterministic
      for (var i = 0; i < d.ents.length; i++) restoreEnt(d.ents[i]);
      // ids were re-assigned sequentially by restoreEnt; remap to saved ids
      // (commands reference ids, so ids must survive snapshots exactly)
      var byNew = Array.from(Grid.entities.values());
      Grid.entities.clear(); Grid.cells.clear();
      for (var j = 0; j < byNew.length; j++) {
        var e = byNew[j]; e.id = d.ents[j].id || (j + 1);
        Grid.entities.set(e.id, e);
        for (var y = 0; y < e.h; y++) for (var x = 0; x < e.w; x++) Grid.cells.set((e.tx + x) + ',' + (e.ty + y), e.id);
      }
      Grid.setNextId(d.nextId || (d.ents.length + 1));
      emit('restored', {});
    }
    return { capture: capture, restore: restore };
  })();

  /* ============================ STATE HASH ============================ */
  // Cheap, order-stable digest of everything that matters. Two instances
  // at the same tick MUST produce the same hash; a mismatch triggers a
  // snapshot resync from the server.
  function stateHash() {
    var parts = [S.tick, Math.round(S.money * 100), rngA];
    var invKeys = Object.keys(S.inv).sort();
    for (var i = 0; i < invKeys.length; i++) parts.push(invKeys[i], S.inv[invKeys[i]]);
    Grid.entities.forEach(function (e) {
      parts.push(e.id, e.type, e.tx, e.ty, e.rot, Math.round((e.prog || 0) * 1000), e.items.length,
        Math.round((e.stored || 0) * 100), Math.round((e.fluidAmt || 0) * 100));
    });
    var res = Array.from(Research.done).sort();
    parts.push(res.join(','));
    for (var k in Economy.price) parts.push(Math.round(Economy.price[k] * 1000));
    for (var a = 0; a < AI.companies.length; a++) parts.push(Math.round(AI.companies[a].money), AI.companies[a].tech, AI.companies[a].factories);
    return Util.fnv1a(parts.join('|'));
  }

  /* ============================ PUBLIC API ============================ */
  return {
    seed: seed, S: S, hooks: hooks,
    World: World, Grid: Grid, Sim: Sim, Economy: Economy, Research: Research, AI: AI,
    Commands: Commands, Snapshot: Snapshot,
    makeEntity: makeEntity, serializeEnt: serializeEnt,
    aiThink: aiThink, tickOnce: tickOnce, stateHash: stateHash, timeOfDay: timeOfDay,
    getRng: function () { return rngA; },
  };
}

return { PROTO: PROTO, Util: Util, Config: Config, createGame: createGame };
});
