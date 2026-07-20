/* ==========================================================================
   GEARWORKS CLIENT — rendering, input, UI, audio, and the game controller
   --------------------------------------------------------------------------
   All game STATE lives in the shared core (window.Core). This file never
   mutates it directly: every player action becomes a command submitted
   through the active session (LocalSession for singleplayer, NetSession
   for multiplayer). Predicted "ghosts" cover the command round-trip so
   building feels instant even at 100+ ms latency; the core's 'applied'
   events clear ghosts and feed the per-player undo/redo stacks.
   ========================================================================== */
'use strict';

var Config = Core.Config, Util = Core.Util;   // convenience aliases
var G = null;      // active core game instance
var Sess = null;   // active session driver

/* ============================ CAMERA ================================= */
var Camera = (function () {
  var x = 0, y = 0, zoom = 1;
  var MINZ = 0.2, MAXZ = 3.2;
  var W = 0, H = 0;
  function resize(w, h) { W = w; H = h; }
  function worldToScreen(wx, wy) { return [(wx - x) * zoom + W / 2, (wy - y) * zoom + H / 2]; }
  function screenToWorld(sx, sy) { return [(sx - W / 2) / zoom + x, (sy - H / 2) / zoom + y]; }
  function pan(dxs, dys) { x -= dxs / zoom; y -= dys / zoom; }
  function zoomAt(sx, sy, factor) {
    var w = screenToWorld(sx, sy);
    zoom = Util.clamp(zoom * factor, MINZ, MAXZ);
    var n = screenToWorld(sx, sy);
    x += w[0] - n[0]; y += w[1] - n[1];
  }
  function visibleTileBounds() {
    var a = screenToWorld(0, 0), b = screenToWorld(W, H);
    var T = Config.TILE;
    return { tx0: Math.floor(a[0] / T) - 1, ty0: Math.floor(a[1] / T) - 1, tx1: Math.ceil(b[0] / T) + 1, ty1: Math.ceil(b[1] / T) + 1 };
  }
  return {
    get x() { return x; }, set x(v) { x = v; }, get y() { return y; }, set y(v) { y = v; },
    get zoom() { return zoom; }, set zoom(v) { zoom = Util.clamp(v, MINZ, MAXZ); },
    get W() { return W; }, get H() { return H; },
    resize: resize, worldToScreen: worldToScreen, screenToWorld: screenToWorld, pan: pan,
    zoomAt: zoomAt, visibleTileBounds: visibleTileBounds,
  };
})();

/* ============================ PARTICLES ============================= */
var Particles = (function () {
  var POOL = 1200;
  var p = { x: new Float32Array(POOL), y: new Float32Array(POOL), vx: new Float32Array(POOL),
    vy: new Float32Array(POOL), life: new Float32Array(POOL), max: new Float32Array(POOL),
    size: new Float32Array(POOL), type: new Uint8Array(POOL), active: new Uint8Array(POOL) };
  var cursor = 0;
  function spawn(x, y, vx, vy, life, size, type) {
    var i = cursor;
    for (var n = 0; n < POOL; n++) { if (!p.active[i]) break; i = (i + 1) % POOL; }
    cursor = (i + 1) % POOL;
    p.x[i] = x; p.y[i] = y; p.vx[i] = vx; p.vy[i] = vy; p.life[i] = life; p.max[i] = life;
    p.size[i] = size; p.type[i] = type; p.active[i] = 1;
  }
  function smoke(x, y) { spawn(x, y, (Math.random() - 0.5) * 4, -8 - Math.random() * 8, 1.2 + Math.random(), 4 + Math.random() * 4, 0); }
  function spark(x, y) { spawn(x, y, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 0.4 + Math.random() * 0.3, 1.5, 1); }
  function rainDrop(x, y) { spawn(x, y, 4, 120, 0.6, 1, 2); }
  function update(dt) {
    for (var i = 0; i < POOL; i++) {
      if (!p.active[i]) continue;
      p.life[i] -= dt; if (p.life[i] <= 0) { p.active[i] = 0; continue; }
      p.x[i] += p.vx[i] * dt; p.y[i] += p.vy[i] * dt;
      if (p.type[i] === 0) { p.vy[i] -= 6 * dt; p.vx[i] *= 0.98; }
    }
  }
  function reset() { p.active.fill(0); }
  return { p: p, POOL: POOL, smoke: smoke, spark: spark, rainDrop: rainDrop, update: update, reset: reset };
})();

/* ============================ AUDIO ================================= */
var Audio2 = (function () {
  var ctx = null, master = null, enabled = true, vol = 0.4;
  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination);
    } catch (e) { enabled = false; }
  }
  function blip(freq, dur, type, gain) {
    if (!enabled || !ctx) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.value = 0; g.gain.linearRampToValueAtTime((gain || 0.3), ctx.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur);
  }
  function noise(dur, gain) {
    if (!enabled || !ctx) return;
    var n = ctx.createBufferSource();
    var buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    var d = buf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    n.buffer = buf; var g = ctx.createGain(); g.gain.value = gain || 0.15;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
    n.connect(f); f.connect(g); g.connect(master); n.start(); n.stop(ctx.currentTime + dur);
  }
  var sounds = {
    place: function () { blip(420, 0.08, 'square', 0.25); },
    remove: function () { blip(180, 0.1, 'sawtooth', 0.2); },
    click: function () { blip(600, 0.04, 'sine', 0.2); },
    error: function () { blip(120, 0.15, 'sawtooth', 0.25); },
    build: function () { blip(330, 0.06, 'square', 0.2); setTimeout(function () { blip(440, 0.06, 'square', 0.2); }, 60); },
    research: function () { blip(523, 0.1, 'sine', 0.25); setTimeout(function () { blip(659, 0.1, 'sine', 0.25); }, 90); setTimeout(function () { blip(784, 0.15, 'sine', 0.25); }, 180); },
    sell: function () { blip(700, 0.08, 'triangle', 0.2); },
    thunder: function () { noise(0.6, 0.25); },
    join: function () { blip(392, 0.08, 'sine', 0.2); setTimeout(function () { blip(523, 0.1, 'sine', 0.2); }, 80); },
    leave: function () { blip(523, 0.08, 'sine', 0.2); setTimeout(function () { blip(392, 0.1, 'sine', 0.2); }, 80); },
  };
  function play(name) { ensure(); var s = sounds[name]; if (s) s(); }
  return { play: play, ensure: ensure,
    setEnabled: function (v) { enabled = v; }, setVol: function (v) { vol = v; if (master) master.gain.value = v; },
    get enabled() { return enabled; }, get vol() { return vol; } };
})();

/* ============================ RENDERER ============================= */
var Renderer = (function () {
  var wc, wctx, fc, fctx, mm, mmctx;
  var dpr = 1;
  function init() {
    wc = document.getElementById('world'); wctx = wc.getContext('2d');
    fc = document.getElementById('fx'); fctx = fc.getContext('2d');
    mm = document.getElementById('mmcanvas'); mmctx = mm.getContext('2d');
    resize();
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth, h = window.innerHeight;
    [wc, fc].forEach(function (c) { c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px'; });
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0); fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Camera.resize(w, h);
  }

  function ambient() {
    var t = G ? G.timeOfDay() : 0.35;
    return 0.35 + 0.65 * Math.max(0, Math.sin(t * Math.PI));
  }

  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, r * f) | 0; g = Math.min(255, g * f) | 0; b = Math.min(255, b * f) | 0;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawTerrain() {
    var T = Config.TILE, z = Camera.zoom;
    var vb = Camera.visibleTileBounds();
    var b = ambient();
    for (var ty = vb.ty0; ty < vb.ty1; ty++) {
      for (var tx = vb.tx0; tx < vb.tx1; tx++) {
        var tile = G.World.tileAt(tx, ty);
        var s0 = Camera.worldToScreen(tx * T, ty * T);
        var s = T * z + 1;
        var col;
        if (tile.water) col = '#1c4a7a';
        else if (tile.biome === 1) col = '#3a4048';
        else col = '#2a3a28';
        wctx.fillStyle = shade(col, b);
        wctx.fillRect(s0[0], s0[1], s, s);
        if (tile.r && tile.amt > 0) {
          wctx.fillStyle = shade(Config.RES[tile.r].color, b);
          var inset = s * 0.14;
          wctx.globalAlpha = 0.85;
          wctx.fillRect(s0[0] + inset, s0[1] + inset, s - inset * 2, s - inset * 2);
          wctx.globalAlpha = 1;
        }
      }
    }
    if (z > 0.6) {
      wctx.strokeStyle = 'rgba(255,255,255,0.04)'; wctx.lineWidth = 1;
      wctx.beginPath();
      for (var gx = vb.tx0; gx < vb.tx1; gx++) { var sx = Camera.worldToScreen(gx * T, 0)[0]; wctx.moveTo(sx, 0); wctx.lineTo(sx, Camera.H); }
      for (var gy = vb.ty0; gy < vb.ty1; gy++) { var sy = Camera.worldToScreen(0, gy * T)[1]; wctx.moveTo(0, sy); wctx.lineTo(Camera.W, sy); }
      wctx.stroke();
    }
  }

  function buildingColor(t) {
    var map = { miner: '#7a6a4a', furnace: '#8a4a3a', assembler: '#4a6a8a', storage: '#5a5a5a',
      splitter: '#4a7a5a', merger: '#4a7a5a', ubelt: '#3a5a7a', pump: '#3a6a8a', extractor: '#3a6a9a',
      oilrig: '#2a2a2a', solar: '#20408a', wind: '#e0e0e0', battery: '#4a7a3a', lab: '#7a4a8a',
      market: '#8a7a2a', station: '#6a4a2a', lamp: '#8a8a4a', nuclear: '#3a8a5a',
      belt: '#33383e', pipe: '#556066', road: '#3d3f44' };
    return map[t] || '#5a5a5a';
  }

  function drawEntities() {
    var T = Config.TILE, z = Camera.zoom, b = ambient();
    var vb = Camera.visibleTileBounds();
    G.Grid.entities.forEach(function (e) {
      if (e.tx + e.w < vb.tx0 || e.ty + e.h < vb.ty0 || e.tx > vb.tx1 || e.ty > vb.ty1) return;
      var s = Camera.worldToScreen(e.tx * T, e.ty * T);
      drawBuilding(wctx, e, s[0], s[1], e.w * T * z, e.h * T * z, z, b);
    });
  }

  function drawBuilding(ctx, e, x, y, w, h, z, b) {
    var B = Config.B[e.type];
    ctx.save();
    if (Game.pendingRemove.has(e.id)) ctx.globalAlpha = 0.45;   // predicted removal
    if (z > 0.4 && !B.belt && !B.road && !B.pole && !B.pipe) {
      var sunA = (G.timeOfDay() - 0.5) * Math.PI;
      var off = Math.cos(sunA) * 6 * z;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + off, y + 4 * z, w, h);
    }
    if (B.belt) { drawBelt(ctx, e, x, y, w, h, z, b); ctx.restore(); return; }
    if (B.road) { ctx.fillStyle = shade('#3d3f44', b); ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(255,220,80,0.3)'; ctx.setLineDash([6 * z, 6 * z]); ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.stroke(); ctx.setLineDash([]); ctx.restore(); return; }
    if (B.pipe) { drawPipe(ctx, e, x, y, w, h, z, b); ctx.restore(); return; }
    if (B.pole) { ctx.fillStyle = shade('#6b5a3a', b); ctx.fillRect(x + w * 0.35, y + h * 0.35, w * 0.3, h * 0.3); drawPowerLines(ctx, e, z); ctx.restore(); return; }
    if (B.deco && e.type === 'tree') { drawTree(ctx, x, y, w, h, b); ctx.restore(); return; }

    ctx.fillStyle = shade(buildingColor(e.type), b);
    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 4 * z); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    drawGlyph(ctx, e, x, y, w, h, z, b);
    if (z > 0.5 && (B.needsOre || B.recipeCat || e.type === 'splitter' || e.type === 'merger' || B.produces)) drawArrow(ctx, e, x, y, w, h, z);
    if ((e.crafting || e.working) && z > 0.5) {
      var p = e.prog || 0;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x + 4, y + h - 7 * z, w - 8, 4 * z);
      ctx.fillStyle = '#7CFC9E'; ctx.fillRect(x + 4, y + h - 7 * z, (w - 8) * Util.clamp(p, 0, 1), 4 * z);
    }
    if (e.type === 'lamp' && (G.timeOfDay() < 0.25 || G.timeOfDay() > 0.78)) {
      var g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w * 2);
      g.addColorStop(0, 'rgba(255,230,150,0.4)'); g.addColorStop(1, 'rgba(255,230,150,0)');
      ctx.fillStyle = g; ctx.fillRect(x - w, y - h, w * 3, h * 3);
    }
    ctx.restore();
  }

  function drawGlyph(ctx, e, x, y, w, h, z, b) {
    if (z < 0.45) return;
    ctx.save(); ctx.translate(x + w / 2, y + h / 2);
    var s = Math.min(w, h) * 0.5; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = Math.max(1, z * 1.4);
    switch (e.type) {
      case 'miner': ctx.beginPath(); ctx.moveTo(-s * 0.4, s * 0.4); ctx.lineTo(0, -s * 0.4); ctx.lineTo(s * 0.4, s * 0.4); ctx.stroke(); break;
      case 'furnace': ctx.fillStyle = e.crafting ? '#ffb000' : '#663322'; ctx.beginPath(); ctx.arc(0, 0, s * 0.35, 0, 7); ctx.fill(); break;
      case 'assembler': ctx.strokeRect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7); ctx.beginPath(); ctx.arc(0, 0, s * 0.18, 0, 7); ctx.stroke(); if (e.crafting) { ctx.save(); ctx.rotate(Game.animT * 4); ctx.beginPath(); ctx.moveTo(-s * 0.25, 0); ctx.lineTo(s * 0.25, 0); ctx.stroke(); ctx.restore(); } break;
      case 'solar': ctx.strokeStyle = 'rgba(120,180,255,0.7)'; for (var i = -1; i < 2; i++) ctx.strokeRect(i * s * 0.28 - s * 0.12, -s * 0.35, s * 0.24, s * 0.7); break;
      case 'wind': ctx.save(); ctx.rotate(Game.animT * 3); for (var j = 0; j < 3; j++) { ctx.rotate(Util.TAU / 3); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 0.45); ctx.stroke(); } ctx.restore(); break;
      case 'battery': ctx.strokeRect(-s * 0.3, -s * 0.35, s * 0.6, s * 0.7); var st = (e.stored || 0) / 200; ctx.fillStyle = '#7CFC9E'; ctx.fillRect(-s * 0.26, s * 0.31 - (s * 0.62 * st), s * 0.52, s * 0.62 * st); break;
      case 'lab': ctx.beginPath(); ctx.arc(0, 0, s * 0.32, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(0, 0); ctx.lineTo(s * 0.28, s * 0.2); ctx.stroke(); break;
      case 'market': ctx.font = (s * 0.8 | 0) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', 0, 0); break;
      case 'storage': ctx.strokeRect(-s * 0.32, -s * 0.32, s * 0.64, s * 0.64); ctx.beginPath(); ctx.moveTo(-s * 0.32, -s * 0.1); ctx.lineTo(s * 0.32, -s * 0.1); ctx.stroke(); break;
      case 'extractor': case 'pump': ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, 7); ctx.stroke(); ctx.fillStyle = '#3a7bd5'; ctx.beginPath(); ctx.arc(0, 0, s * 0.15, 0, 7); ctx.fill(); break;
      case 'oilrig': ctx.beginPath(); ctx.moveTo(-s * 0.3, s * 0.4); ctx.lineTo(0, -s * 0.4); ctx.lineTo(s * 0.3, s * 0.4); ctx.stroke(); break;
      case 'station': ctx.strokeRect(-s * 0.35, -s * 0.2, s * 0.7, s * 0.4); break;
      case 'nuclear': ctx.beginPath(); ctx.arc(0, 0, s * 0.12, 0, 7); ctx.fill();
        for (var k = 0; k < 3; k++) { ctx.save(); ctx.rotate(k * Math.PI / 3); ctx.beginPath(); ctx.ellipse(0, 0, s * 0.42, s * 0.16, 0, 0, 7); ctx.stroke(); ctx.restore(); } break;
    }
    ctx.restore();
  }

  function drawArrow(ctx, e, x, y, w, h, z) {
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(e.rot * Math.PI / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    var s = Math.min(w, h) * 0.12;
    ctx.beginPath(); ctx.moveTo(0, -h * 0.42); ctx.lineTo(-s, -h * 0.42 + s * 1.4); ctx.lineTo(s, -h * 0.42 + s * 1.4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawBelt(ctx, e, x, y, w, h, z, b) {
    ctx.fillStyle = shade('#33383e', b); ctx.fillRect(x, y, w, h);
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(e.rot * Math.PI / 2);
    var anim = (Game.animT * 40) % (h * 0.5 || 20);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(1, z * 1.5);
    for (var i = -1; i < 3; i++) {
      var yy = -h / 2 + ((i * h * 0.5 + anim) % (h * 1.5));
      ctx.beginPath(); ctx.moveTo(-w * 0.22, yy + h * 0.1); ctx.lineTo(0, yy - h * 0.05); ctx.lineTo(w * 0.22, yy + h * 0.1); ctx.stroke();
    }
    ctx.restore();
    for (var k = 0; k < e.items.length; k++) {
      var it = e.items[k];
      var d = G.Sim.DIRS[e.rot];
      var cx = x + w / 2 + d[0] * (it.pos - 0.5) * w;
      var cy = y + h / 2 + d[1] * (it.pos - 0.5) * h;
      ctx.fillStyle = Config.ITEM[it.item] ? Config.ITEM[it.item].color : '#fff';
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, w * 0.16), 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  function drawPipe(ctx, e, x, y, w, h, z, b) {
    ctx.fillStyle = shade('#556066', b);
    ctx.fillRect(x + w * 0.3, y + h * 0.3, w * 0.4, h * 0.4);
    for (var i = 0; i < 4; i++) {
      var d = G.Sim.DIRS[i];
      var n = G.Grid.entAt(e.tx + d[0], e.ty + d[1]);
      if (n && (Config.B[n.type].pipe || Config.B[n.type].produces || Config.B[n.type].recipeCat)) {
        ctx.fillRect(x + w * 0.3 + d[0] * w * 0.35, y + h * 0.3 + d[1] * h * 0.35, w * 0.4, h * 0.4);
      }
    }
    if (e.fluidAmt > 0 && e.fluid) {
      ctx.fillStyle = Config.ITEM[e.fluid] ? Config.ITEM[e.fluid].color : '#3a7bd5';
      ctx.globalAlpha = Util.clamp(e.fluidAmt / 20, 0.2, 0.9);
      ctx.fillRect(x + w * 0.36, y + h * 0.36, w * 0.28, h * 0.28); ctx.globalAlpha = 1;
    }
  }

  function drawPowerLines(ctx, e, z) {
    ctx.strokeStyle = 'rgba(255,220,120,0.35)'; ctx.lineWidth = Math.max(1, z);
    var T = Config.TILE;
    var c = Camera.worldToScreen((e.tx + 0.5) * T, (e.ty + 0.5) * T);
    G.Grid.entities.forEach(function (o) {
      if (o !== e && Config.B[o.type].pole && o.id > e.id && Math.hypot(o.tx - e.tx, o.ty - e.ty) <= 6) {
        var s = Camera.worldToScreen((o.tx + 0.5) * T, (o.ty + 0.5) * T);
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      }
    });
  }

  function drawTree(ctx, x, y, w, h, b) {
    ctx.fillStyle = shade('#4a3520', b); ctx.fillRect(x + w * 0.42, y + h * 0.5, w * 0.16, h * 0.5);
    ctx.fillStyle = shade('#2f6a35', b); ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.42, w * 0.35, 0, 7); ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2); ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawGhost() {
    if (!Game.tool || Game.deleteMode) return;
    var B = Config.B[Game.tool]; if (!B) return;
    var T = Config.TILE, z = Camera.zoom;
    var t = Game.hoverTile; if (!t) return;
    var s = Camera.worldToScreen(t.tx * T, t.ty * T);
    var w = B.w * T * z, h = B.h * T * z;
    var ok = Game.canPlaceTool(t.tx, t.ty);
    wctx.globalAlpha = 0.5;
    wctx.fillStyle = ok ? 'rgba(120,255,150,0.4)' : 'rgba(255,90,90,0.4)';
    wctx.fillRect(s[0], s[1], w, h);
    wctx.strokeStyle = ok ? '#7CFC9E' : '#ff5a5a'; wctx.lineWidth = 2; wctx.strokeRect(s[0], s[1], w, h);
    wctx.save(); wctx.translate(s[0] + w / 2, s[1] + h / 2); wctx.rotate((Game.rot) * Math.PI / 2);
    wctx.fillStyle = 'rgba(255,255,255,0.8)'; wctx.beginPath(); wctx.moveTo(0, -h * 0.4); wctx.lineTo(-6, -h * 0.4 + 10); wctx.lineTo(6, -h * 0.4 + 10); wctx.fill(); wctx.restore();
    wctx.globalAlpha = 1;
  }

  // predicted placements not yet confirmed by the server
  function drawPending() {
    var T = Config.TILE, z = Camera.zoom;
    Game.pending.forEach(function (g) {
      if (g.kind === 'place') {
        var B = Config.B[g.type];
        var s = Camera.worldToScreen(g.x * T, g.y * T);
        wctx.globalAlpha = 0.45;
        wctx.fillStyle = shade(buildingColor(g.type), 1);
        wctx.fillRect(s[0] + 2, s[1] + 2, B.w * T * z - 4, B.h * T * z - 4);
        wctx.globalAlpha = 1;
        wctx.strokeStyle = 'rgba(120,180,255,0.8)'; wctx.setLineDash([4, 3]);
        wctx.strokeRect(s[0], s[1], B.w * T * z, B.h * T * z); wctx.setLineDash([]);
      } else if (g.kind === 'paste') {
        for (var i = 0; i < g.cells.length; i++) {
          var c = g.cells[i]; var CB = Config.B[c.type];
          var s2 = Camera.worldToScreen((g.x + c.dx) * T, (g.y + c.dy) * T);
          wctx.globalAlpha = 0.35;
          wctx.fillStyle = 'rgba(120,180,255,0.4)';
          wctx.fillRect(s2[0], s2[1], CB.w * T * z, CB.h * T * z);
          wctx.globalAlpha = 1;
        }
      }
    });
  }

  function drawSelection() {
    var e = Game.selected; if (!e) return;
    var T = Config.TILE, z = Camera.zoom;
    var s = Camera.worldToScreen(e.tx * T, e.ty * T);
    wctx.strokeStyle = '#4aa3ff'; wctx.lineWidth = 2; wctx.setLineDash([6, 4]);
    wctx.strokeRect(s[0] - 2, s[1] - 2, e.w * T * z + 4, e.h * T * z + 4); wctx.setLineDash([]);
  }

  function drawClipboard() {
    if (!Game.pasteMode || !Game.clipboard) return;
    var T = Config.TILE, z = Camera.zoom; var t = Game.hoverTile; if (!t) return;
    wctx.globalAlpha = 0.5;
    for (var i = 0; i < Game.clipboard.cells.length; i++) {
      var c = Game.clipboard.cells[i];
      var s = Camera.worldToScreen((t.tx + c.dx) * T, (t.ty + c.dy) * T);
      var B = Config.B[c.type];
      wctx.fillStyle = 'rgba(120,180,255,0.35)';
      wctx.fillRect(s[0], s[1], B.w * T * z, B.h * T * z);
    }
    wctx.globalAlpha = 1;
  }

  // other players' cursors: interpolated, name-tagged, colored
  function drawCursors() {
    if (!Sess || Sess.mode !== 'net') return;
    var now = performance.now();
    Sess.cursors.forEach(function (c, id) {
      var p = Sess.playersMap.get(id); if (!p) return;
      if (now - c.t > 4000) return;
      var k = Util.clamp((now - c.t) / 120, 0, 1);
      var wx = Util.lerp(c.px, c.x, k), wy = Util.lerp(c.py, c.y, k);
      var s = Camera.worldToScreen(wx, wy);
      if (s[0] < -60 || s[1] < -60 || s[0] > Camera.W + 60 || s[1] > Camera.H + 60) return;
      wctx.save();
      wctx.translate(s[0], s[1]);
      wctx.fillStyle = p.color; wctx.strokeStyle = 'rgba(0,0,0,0.5)';
      wctx.beginPath(); wctx.moveTo(0, 0); wctx.lineTo(11, 15); wctx.lineTo(4.5, 14); wctx.lineTo(0, 20); wctx.closePath();
      wctx.fill(); wctx.stroke();
      wctx.font = 'bold 11px sans-serif'; wctx.textAlign = 'left';
      var label = p.name + (p.role === 'spectator' ? ' 👁' : '');
      var tw = wctx.measureText(label).width;
      wctx.fillStyle = 'rgba(10,14,20,0.8)';
      wctx.fillRect(12, 16, tw + 10, 16);
      wctx.fillStyle = p.color;
      wctx.fillText(label, 17, 28);
      wctx.restore();
    });
  }

  function drawFX() {
    fctx.clearRect(0, 0, Camera.W, Camera.H);
    var z = Camera.zoom;
    var p = Particles.p;
    for (var i = 0; i < Particles.POOL; i++) {
      if (!p.active[i]) continue;
      var s = Camera.worldToScreen(p.x[i], p.y[i]);
      var a = Util.clamp(p.life[i] / p.max[i], 0, 1);
      if (p.type[i] === 0) { fctx.fillStyle = 'rgba(150,150,150,' + (a * 0.4) + ')'; fctx.beginPath(); fctx.arc(s[0], s[1], p.size[i] * z * (1.5 - a * 0.5), 0, 7); fctx.fill(); }
      else if (p.type[i] === 1) { fctx.fillStyle = 'rgba(255,200,80,' + a + ')'; fctx.fillRect(s[0], s[1], p.size[i] * z, p.size[i] * z); }
      else if (p.type[i] === 2) { fctx.strokeStyle = 'rgba(150,180,220,' + (a * 0.5) + ')'; fctx.lineWidth = 1; fctx.beginPath(); fctx.moveTo(s[0], s[1]); fctx.lineTo(s[0] - 2, s[1] + 8 * z); fctx.stroke(); }
    }
    var b = ambient();
    if (b < 0.85) { fctx.fillStyle = 'rgba(10,15,40,' + ((0.85 - b) * 0.9) + ')'; fctx.fillRect(0, 0, Camera.W, Camera.H); }
    if (G && G.S.weather === 'fog') { fctx.fillStyle = 'rgba(180,190,200,0.18)'; fctx.fillRect(0, 0, Camera.W, Camera.H); }
  }

  function frame() {
    wctx.clearRect(0, 0, Camera.W, Camera.H);
    if (!G) return;
    drawTerrain();
    drawEntities();
    drawPending();
    drawGhost();
    drawClipboard();
    drawSelection();
    drawCursors();
    drawFX();
    drawMinimap();
  }

  var mmTimer = 0;
  function drawMinimap() {
    mmTimer++; if (mmTimer % 6 !== 0) return;
    mmctx.fillStyle = '#0b0f14'; mmctx.fillRect(0, 0, 150, 150);
    var scale = 1.4;
    var cx = Camera.x / Config.TILE, cy = Camera.y / Config.TILE;
    for (var py = 0; py < 150; py += 2) {
      for (var px = 0; px < 150; px += 2) {
        var t = G.World.tileAt(Math.floor(cx + (px - 75) * scale), Math.floor(cy + (py - 75) * scale));
        if (t.water) { mmctx.fillStyle = '#1c4a7a'; mmctx.fillRect(px, py, 2, 2); }
        else if (t.r && t.amt > 0) { mmctx.fillStyle = Config.RES[t.r].color; mmctx.fillRect(px, py, 2, 2); }
      }
    }
    mmctx.fillStyle = '#4aa3ff';
    G.Grid.entities.forEach(function (e) {
      var px = 75 + (e.tx - cx) / scale, py = 75 + (e.ty - cy) / scale;
      if (px >= 0 && px < 150 && py >= 0 && py < 150) mmctx.fillRect(px, py, 2, 2);
    });
    for (var i = 0; i < G.AI.companies.length; i++) {
      var c = G.AI.companies[i];
      var ax = 75 + (c.tx - cx) / scale, ay = 75 + (c.ty - cy) / scale;
      if (ax >= 0 && ax < 150 && ay >= 0 && ay < 150) { mmctx.fillStyle = c.color; mmctx.fillRect(ax - 1, ay - 1, 3, 3); }
    }
    mmctx.strokeStyle = 'rgba(255,255,255,0.6)'; mmctx.lineWidth = 1;
    var vw = Camera.W / Config.TILE / Camera.zoom / scale, vh = Camera.H / Config.TILE / Camera.zoom / scale;
    mmctx.strokeRect(75 - vw / 2, 75 - vh / 2, vw, vh);
  }

  return { init: init, resize: resize, frame: frame, buildingColor: buildingColor };
})();

/* ============================ BLUEPRINTS ============================ */
var BPLib = (function () {
  var KEY = 'gearworks_blueprints_v1';
  var BUILTINS = [
    { name: 'Smelter Line', builtin: true, cells: [
      { dx: 0, dy: 0, type: 'miner', rot: 1 }, { dx: 2, dy: 0, type: 'belt', rot: 1 }, { dx: 3, dy: 0, type: 'belt', rot: 1 },
      { dx: 4, dy: 0, type: 'belt', rot: 1 }, { dx: 5, dy: 0, type: 'belt', rot: 1 }, { dx: 6, dy: 0, type: 'furnace', rot: 1 },
      { dx: 8, dy: 0, type: 'belt', rot: 1 }, { dx: 9, dy: 0, type: 'belt', rot: 1 }, { dx: 10, dy: 0, type: 'storage', rot: 1 }] },
    { name: 'Solar Farm', builtin: true, cells: [
      { dx: 0, dy: 0, type: 'solar', rot: 0 }, { dx: 3, dy: 0, type: 'solar', rot: 0 }, { dx: 0, dy: 3, type: 'solar', rot: 0 },
      { dx: 3, dy: 3, type: 'solar', rot: 0 }, { dx: 6, dy: 0, type: 'battery', rot: 0 }, { dx: 6, dy: 2, type: 'battery', rot: 0 },
      { dx: 6, dy: 4, type: 'pole', rot: 0 }, { dx: 7, dy: 4, type: 'pole', rot: 0 }] },
  ];
  var list = null;
  function load() {
    if (list) return list;
    try { var raw = localStorage.getItem(KEY); list = raw ? JSON.parse(raw) : []; }
    catch (e) { list = []; }
    return list;
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (e) { UI.toast('Could not store blueprints', 'bad'); } }
  return {
    all: function () { return BUILTINS.concat(load()); },
    add: function (name, cells) {
      load().push({ name: name || ('Blueprint ' + (load().length + 1)),
        cells: cells.map(function (c) { return { dx: c.dx, dy: c.dy, type: c.type, rot: c.rot, recipe: c.recipe || null }; }) });
      persist();
    },
    remove: function (i) { var l = load(); if (i >= 0 && i < l.length) { l.splice(i, 1); persist(); } },
    get saved() { return load(); },
  };
})();

/* ============================ SAVE (singleplayer) =================== */
var Save = (function () {
  var KEY = 'gearworks_save_v2';
  function save() {
    if (!G) return false;
    try {
      var data = { snap: G.Snapshot.capture(), cam: { x: Camera.x, y: Camera.y, z: Camera.zoom } };
      localStorage.setItem(KEY, btoa(unescape(encodeURIComponent(JSON.stringify(data)))));
      return true;
    } catch (e) { UI.toast('Save failed: ' + e.message, 'bad'); return false; }
  }
  function loadData() {
    try {
      var raw = localStorage.getItem(KEY); if (!raw) return null;
      return JSON.parse(decodeURIComponent(escape(atob(raw))));
    } catch (e) { return null; }
  }
  function exportFile() {
    var data = { snap: G.Snapshot.capture(), cam: { x: Camera.x, y: Camera.y, z: Camera.zoom } };
    var blob = new Blob([btoa(unescape(encodeURIComponent(JSON.stringify(data))))], { type: 'text/plain' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'gearworks-save-' + Date.now() + '.txt'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    UI.toast('Exported save file', 'good');
  }
  function importFile() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,.json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return; var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(decodeURIComponent(escape(atob(rd.result))));
          Game.startLocal(d); UI.toast('Imported save', 'good');
        } catch (e) { UI.toast('Invalid file', 'bad'); }
      };
      rd.readAsText(f);
    };
    inp.click();
  }
  return { save: save, loadData: loadData, hasSave: function () { return !!localStorage.getItem(KEY); },
    exportFile: exportFile, importFile: importFile };
})();

/* ============================ UI ==================================== */
var UI = (function () {
  var activeModal = null;

  function toast(msg, kind) {
    var el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(function () { el.remove(); }, 400); }, 2600);
  }

  function topBar() {
    if (!G) return;
    var el = document.getElementById('topbar');
    var showItems = ['iron_plate', 'copper_plate', 'steel', 'plastic', 'electronics', 'machine', 'adv_machine'];
    var html = '<div class="res"><span id="money">$' + Util.fmt(G.S.money) + '</span></div>';
    var sat = G.Sim.powerSatisfied;
    var pcol = sat >= 0.99 ? '#7CFC9E' : sat > 0.5 ? '#ffd873' : '#ff7a7a';
    html += '<div class="res"><span id="power" style="color:' + pcol + '">⚡' + Util.fmt(G.Sim.powerAvail) + '/' + Util.fmt(G.Sim.powerDemand) + '</span></div>';
    for (var i = 0; i < showItems.length; i++) {
      var it = showItems[i];
      html += '<div class="res"><span class="ic" style="background:' + Config.ITEM[it].color + '"></span><b>' + Util.fmt(G.S.inv[it] || 0) + '</b></div>';
    }
    if (Sess && Sess.mode === 'net') {
      var cls = Sess.status === 'online' ? 'on' : (Sess.status === 'reconnecting' ? 'warn' : 'off');
      html += '<div class="res" title="Connection"><span class="netdot ' + cls + '"></span>&nbsp;' + (Sess.rtt || 0) + 'ms</div>';
      html += '<div class="res" style="color:#8aa">' + esc(Sess.code || '') + '</div>';
      if (Sess.role === 'spectator') html += '<div class="res"><span class="rolebadge spectator">Spectator</span></div>';
    }
    el.innerHTML = html;
  }

  var CATS = [['produce', 'Produce'], ['logi', 'Logistics'], ['fluid', 'Fluids'], ['power', 'Power'], ['special', 'Special'], ['deco', 'Deco']];
  var buildCat = 'produce';
  function buildBar() {
    var el = document.getElementById('buildbar');
    if (!G) return;
    if (Sess && Sess.role === 'spectator') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    var html = '<div style="display:flex;flex-direction:column;gap:2px;margin-right:4px;justify-content:center">';
    CATS.forEach(function (c) { html += '<div class="tab ' + (c[0] === buildCat ? 'sel' : '') + '" data-cat="' + c[0] + '" style="border:none;padding:2px 6px">' + c[1] + '</div>'; });
    html += '</div>';
    for (var key in Config.B) {
      var B = Config.B[key];
      if (!B.tool || B.cat !== buildCat) continue;
      var locked = B.tech && !G.Research.done.has(B.tech);
      html += '<div class="tool ' + (Game.tool === key ? 'sel' : '') + (locked ? ' locked' : '') + '" data-tool="' + key + '">' +
        '<canvas class="gi" width="26" height="26" data-icon="' + key + '"></canvas>' +
        '<div class="nm">' + B.name + '</div><div class="ct">$' + B.cost + '</div></div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('canvas[data-icon]').forEach(function (c) { drawToolIcon(c, c.dataset.icon); });
  }
  function drawToolIcon(canvas, type) {
    var ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 26, 26);
    var B = Config.B[type];
    ctx.fillStyle = type === 'belt' ? '#33383e' : (type === 'road' ? '#3d3f44' : (type === 'pipe' ? '#556066' : '#4a6a8a'));
    if (!B.belt && !B.road && !B.pipe) ctx.fillStyle = '#' + (({ miner: '7a6a4a', furnace: '8a4a3a', assembler: '4a6a8a', storage: '5a5a5a', solar: '20408a', wind: '888', battery: '4a7a3a', lab: '7a4a8a', market: '8a7a2a', nuclear: '3a8a5a' })[type] || '5a6a7a');
    ctx.fillRect(3, 3, 20, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var gl = { miner: '⛏', furnace: '🔥', assembler: '⚙', storage: '📦', splitter: '⑃', merger: '⑂', belt: '▶', ubelt: '⇊', pump: '◉', extractor: '💧', pipe: '│', oilrig: '🛢', solar: '☀', wind: '🌀', battery: '🔋', pole: '⌇', lab: '🔬', market: '$', station: '🚉', tree: '🌲', lamp: '💡', road: '▤', nuclear: '☢' }[type] || '?';
    ctx.fillText(gl, 13, 14);
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]; }); }

  function selInfo() {
    var e = Game.selected; var panel = document.getElementById('selinfo');
    if (!e || !G.Grid.entities.has(e.id)) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var B = Config.B[e.type];
    document.getElementById('selttl').textContent = B.name;
    var h = '';
    if (B.needsOre) { var t = G.World.tileAt(e.oreX, e.oreY); h += '<div><span class="k">Mining:</span> ' + (t && t.r ? Config.ITEM[t.r].name + ' (' + Util.fmt(t.amt) + ')' : 'depleted') + '</div>'; }
    if (B.recipeCat) {
      h += '<div><span class="k">Recipe:</span> ' + (e.recipe ? Config.ITEM[Config.RECIPES[e.recipe].out].name : 'auto/none') + '</div>';
      if (B.recipeCat === 'assemble' && Sess.role !== 'spectator') {
        h += '<div class="reclist">';
        for (var rid in Config.RECIPES) {
          if (Config.RECIPES[rid].cat !== 'assemble') continue;
          h += '<div class="recopt ' + (e.recipe === rid ? 'sel' : '') + '" data-rec="' + rid + '"><span class="ic" style="display:inline-block;width:10px;height:10px;background:' + Config.ITEM[Config.RECIPES[rid].out].color + '"></span><br>' + Config.ITEM[Config.RECIPES[rid].out].name + '</div>';
        }
        h += '</div>';
      }
      var inbuf = Object.entries(e.in || {}).filter(function (x) { return x[1] > 0; }).map(function (x) { return Config.ITEM[x[0]].name + ':' + x[1]; }).join(', ');
      if (inbuf) h += '<div><span class="k">In:</span> ' + inbuf + '</div>';
    }
    if (B.store || B.lab) {
      var items = Object.entries(e.buf || {}).filter(function (x) { return x[1] > 0; });
      h += '<div><span class="k">Contents:</span> ' + (items.length ? items.map(function (x) { return Config.ITEM[x[0]].name + ':' + Util.fmt(x[1]); }).join(', ') : 'empty') + '</div>';
      if (B.store && Sess.role !== 'spectator') h += '<button class="btn" style="margin-top:6px" data-collect="' + e.id + '">Collect All</button>';
    }
    if (B.market) h += '<div><span class="k">Sold:</span> ' + Util.fmt(e.sold || 0) + ' items</div>';
    if (B.batt) h += '<div><span class="k">Charge:</span> ' + Util.fmt(e.stored || 0) + '/200</div><div class="bar"><i style="width:' + ((e.stored || 0) / 2) + '%"></i></div>';
    if (B.power > 0) h += '<div><span class="k">Output:</span> ' + Util.fmt(e.gen || 0) + ' MW</div>';
    if (B.produces) h += '<div><span class="k">Fluid:</span> ' + Util.fmt(e.fluid || 0) + '</div>';
    if (Sess.role !== 'spectator') {
      h += '<button class="btn gray" style="margin-top:8px" data-rot2="1">Rotate ↻</button> ';
      h += '<button class="btn red" style="margin-top:8px" data-del2="1">Remove</button>';
    }
    document.getElementById('selbody').innerHTML = h;
  }

  function openModal(id) {
    closeModal();
    var m = document.getElementById(id); m.classList.remove('hidden'); activeModal = m;
    if (id === 'researchModal') renderResearch();
    if (id === 'marketModal') renderMarket();
    if (id === 'statsModal') renderStats();
    if (id === 'settingsModal') renderSettings();
    if (id === 'blueprintModal') renderBlueprints();
    if (id === 'playersModal') renderPlayers();
    Audio2.play('click');
  }
  function closeModal() { if (activeModal) { activeModal.classList.add('hidden'); activeModal = null; } }

  function techTier(id) {
    var t = Config.TECH[id];
    return t.req.length ? 1 + Math.max.apply(null, t.req.map(techTier)) : 1;
  }
  function renderResearch() {
    var el = document.getElementById('researchBody');
    var h = '<p style="font-size:11px;color:#8aa;margin-bottom:8px">Spend produced items to unlock technology. Research is shared by the whole team.</p>';
    var ids = Object.keys(Config.TECH).sort(function (a, b) { return techTier(a) - techTier(b); });
    var cur = 0;
    ids.forEach(function (id) {
      var tier = techTier(id);
      if (tier !== cur) { cur = tier; h += '<h3 style="border:none;padding:8px 0 3px;color:#4aa3ff">Tier ' + tier + '</h3>'; }
      var t = Config.TECH[id]; var done = G.Research.done.has(id); var can = G.Research.canResearch(id);
      var cost = Object.entries(t.cost).map(function (x) { return Util.fmt(G.S.inv[x[0]] || 0) + '/' + x[1] + ' ' + Config.ITEM[x[0]].name; }).join(', ');
      h += '<div class="tech"><div class="ti"><div class="tn">' + t.name + (done ? ' ✓' : '') + '</div><div class="td">' + t.desc + '</div><div class="tc">' + cost + '</div>' +
        (t.req.length ? '<div class="td">Requires: ' + t.req.map(function (r) { return Config.TECH[r].name; }).join(', ') + '</div>' : '') + '</div>' +
        (done ? '<button class="btn gray" disabled>Done</button>'
          : '<button class="btn" data-tech="' + id + '" ' + ((can && Sess.role !== 'spectator') ? '' : 'disabled') + '>Research</button>') + '</div>';
    });
    el.innerHTML = h;
  }

  function renderMarket() {
    var el = document.getElementById('marketBody');
    var h = '<p style="font-size:11px;color:#8aa;margin-bottom:8px">Buy &amp; sell resources. Prices react to supply &amp; demand and to NPC trading. Money and inventory are shared by the team.</p>';
    h += '<div style="max-height:52vh;overflow:auto">';
    for (var it in Config.MARKET) {
      var p = G.Economy.price[it]; var base = Config.MARKET[it];
      var trend = p > base * 1.05 ? '▲' : p < base * 0.95 ? '▼' : '▬';
      var tc = p > base * 1.05 ? '#7CFC9E' : p < base * 0.95 ? '#ff7a7a' : '#8aa';
      var dis = Sess.role === 'spectator' ? 'disabled' : '';
      h += '<div class="statrow"><span><span class="ic" style="display:inline-block;width:10px;height:10px;background:' + Config.ITEM[it].color + ';border-radius:2px"></span> ' + Config.ITEM[it].name + ' ×' + Util.fmt(G.S.inv[it] || 0) + '</span>' +
        '<span><span style="color:' + tc + '">' + trend + ' $' + p.toFixed(1) + '</span> ' +
        '<button class="btn gray" style="padding:2px 6px" data-buy="' + it + '" ' + dis + '>Buy</button> ' +
        '<button class="btn" style="padding:2px 6px" data-sell="' + it + '" ' + dis + '>Sell</button></span></div>';
    }
    h += '</div><p style="font-size:11px;color:#8aa;margin-top:8px">Tap sell to sell 10; buy to buy 10.</p>';
    h += '<div class="graphwrap"><div class="lbl">Electronics price history</div><canvas id="mktgraph" width="520" height="70" style="width:100%;background:#0e141b;border-radius:6px"></canvas></div>';
    el.innerHTML = h;
    drawSpark('mktgraph', G.Economy.history.electronics, '#5fd67a');
  }

  function renderStats() {
    var el = document.getElementById('statsBody');
    var s = G.Sim.stats;
    var h = '';
    h += '<div class="statrow"><span>Mode</span><span>' + (Sess.mode === 'net' ? 'Multiplayer (' + esc(Sess.roomName || '') + ')' : 'Singleplayer') + '</span></div>';
    h += '<div class="statrow"><span>Sim tick</span><span>' + G.S.tick + '</span></div>';
    if (Sess.mode === 'net') h += '<div class="statrow"><span>Latency</span><span>' + (Sess.rtt || 0) + ' ms</span></div>';
    h += '<div class="statrow"><span>Active entities</span><span>' + Util.fmt(G.Grid.entities.size) + '</span></div>';
    h += '<div class="statrow"><span>Items on belts</span><span>' + Util.fmt(s.itemsOnBelts) + '</span></div>';
    h += '<div class="statrow"><span>Power</span><span>' + Util.fmt(G.Sim.powerAvail) + ' / ' + Util.fmt(G.Sim.powerDemand) + ' MW</span></div>';
    h += '<div class="statrow"><span>Battery</span><span>' + Util.fmt(G.Sim.battStored) + ' / ' + Util.fmt(G.Sim.battMax) + '</span></div>';
    h += '<div class="statrow"><span>FPS</span><span>' + Game.fps.toFixed(0) + '</span></div>';
    h += '<h3 style="margin-top:10px;border:none;padding-left:0">Total Produced</h3>';
    Object.entries(s.produced).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (pr) {
      if (!Config.ITEM[pr[0]]) return;
      h += '<div class="statrow"><span><span class="ic" style="display:inline-block;width:9px;height:9px;background:' + Config.ITEM[pr[0]].color + '"></span> ' + Config.ITEM[pr[0]].name + '</span><span>' + Util.fmt(pr[1]) + '</span></div>';
    });
    h += '<h3 style="margin-top:10px;border:none;padding-left:0">Competitors</h3>';
    h += '<div class="statrow"><span style="color:#4aa3ff">Team</span><span>$' + Util.fmt(G.S.money) + '</span></div>';
    G.AI.leader().forEach(function (c) {
      h += '<div class="statrow"><span style="color:' + c.color + '">' + c.name + ' (' + c.factories + ' fac, T' + c.tech + ')</span><span>$' + Util.fmt(c.money) + '</span></div>';
    });
    h += '<div class="graphwrap"><div class="lbl">Money over time</div><canvas id="moneygraph" width="520" height="70" style="width:100%;background:#0e141b;border-radius:6px"></canvas></div>';
    el.innerHTML = h;
    drawSpark('moneygraph', G.S.moneyHistory, '#7CFC9E');
  }

  function renderSettings() {
    var el = document.getElementById('settingsBody');
    var isNet = Sess.mode === 'net';
    var canAdmin = !isNet || Sess.role === 'host' || Sess.role === 'admin';
    var h =
      '<label class="row"><span>Sound</span><input type="checkbox" id="set-sound" ' + (Audio2.enabled ? 'checked' : '') + '></label>' +
      '<label class="row"><span>Volume</span><input class="slider" type="range" id="set-vol" min="0" max="1" step="0.05" value="' + Audio2.vol + '"></label>' +
      '<label class="row"><span>Weather ' + (canAdmin ? '' : '(admin)') + '</span><select id="set-weather" class="txt" ' + (canAdmin ? '' : 'disabled') + '><option value="clear">Clear</option><option value="rain">Rain</option><option value="fog">Fog</option></select></label>' +
      '<label class="row"><span>Day length (s) ' + (canAdmin ? '' : '(admin)') + '</span><input class="slider" type="range" id="set-day" min="30" max="300" step="10" value="' + G.S.dayLength + '" ' + (canAdmin ? '' : 'disabled') + '></label>';
    if (!isNet) {
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">' +
        '<button class="btn" id="set-save">Save Game</button>' +
        '<button class="btn gray" id="set-export">Export File</button>' +
        '<button class="btn gray" id="set-import">Import File</button>' +
        '<button class="btn red" id="set-new">New World</button>' +
        '<button class="btn gray" id="set-menu">Main Menu</button>' +
        '</div>' +
        '<p style="font-size:11px;color:#8aa;margin-top:10px">Auto-saves every 60s to your browser. Export downloads a save file you can re-import.</p>';
    } else {
      h += '<div class="divider"></div><b style="font-size:13px">Server</b>';
      if (canAdmin) {
        h += '<label class="row"><span>Autosave (seconds)</span><input class="txt" type="number" id="set-autosave" min="15" max="600" value="' + Sess.autosaveSec + '" style="width:80px"></label>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn" id="set-srvsave">Save Now (server)</button></div>';
      }
      h += '<p style="font-size:11px;color:#8aa;margin-top:10px">Saves live on the server with rotating backups — players never own the world file.</p>' +
        '<div style="display:flex;gap:6px;margin-top:8px"><button class="btn red" id="set-leave">Leave Game</button></div>';
    }
    el.innerHTML = h;
    document.getElementById('set-weather').value = G.S.weather;
    document.getElementById('set-sound').onchange = function (e) { Audio2.setEnabled(e.target.checked); };
    document.getElementById('set-vol').oninput = function (e) { Audio2.setVol(+e.target.value); };
    if (canAdmin) {
      document.getElementById('set-weather').onchange = function (e) { Game.submit({ t: 'setWeather', w: e.target.value }); };
      document.getElementById('set-day').onchange = function (e) { Game.submit({ t: 'setDayLen', v: +e.target.value }); };
    }
    if (!isNet) {
      document.getElementById('set-save').onclick = function () { if (Save.save()) toast('Game saved', 'good'); };
      document.getElementById('set-export').onclick = Save.exportFile;
      document.getElementById('set-import').onclick = Save.importFile;
      document.getElementById('set-new').onclick = function () { if (confirm('Start a new world? Unsaved progress is lost.')) Game.startLocal(null); };
      document.getElementById('set-menu').onclick = function () { Save.save(); location.reload(); };
    } else {
      var sv = document.getElementById('set-srvsave');
      if (sv) sv.onclick = function () { Sess.saveNow(); };
      var au = document.getElementById('set-autosave');
      if (au) au.onchange = function (e) { Sess.setAutosave(+e.target.value); };
      document.getElementById('set-leave').onclick = function () { Sess.leave(); location.reload(); };
    }
  }

  function renderBlueprints() {
    var el = document.getElementById('blueprintBody');
    var h = '<p style="font-size:11px;color:#8aa;margin-bottom:8px">Copy buildings with ⧉ (C), then save the copy here. Blueprints persist across worlds; placing one pays each building’s cost.</p>';
    if (Game.clipboard && !Game.clipboard.fromLib) {
      h += '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<input id="bp-name" placeholder="Name this copy…" maxlength="40" class="txt" style="flex:1">' +
        '<button class="btn" id="bp-save">Save Copy (' + Game.clipboard.cells.length + ')</button></div>';
    } else {
      h += '<p style="font-size:11px;color:#667;margin-bottom:10px">No fresh copy on the clipboard — use ⧉ (C) on your factory first.</p>';
    }
    var all = BPLib.all(); var nBuilt = all.length - BPLib.saved.length;
    all.forEach(function (bp, i) {
      var cost = bp.cells.reduce(function (s, c) { return s + (Config.B[c.type] ? Config.B[c.type].cost : 0); }, 0);
      h += '<div class="tech"><canvas width="64" height="48" data-bpprev="' + i + '" style="background:#0e141b;border-radius:5px;align-self:center;flex-shrink:0"></canvas>' +
        '<div class="ti"><div class="tn">' + esc(bp.name) + (bp.builtin ? ' <span style="color:#667;font-size:9px">built-in</span>' : '') + '</div>' +
        '<div class="td">' + bp.cells.length + ' buildings — $' + Util.fmt(cost) + '</div></div>' +
        '<div style="display:flex;flex-direction:column;gap:4px;justify-content:center">' +
        '<button class="btn" data-bpplace="' + i + '">Place</button>' +
        (bp.builtin ? '' : '<button class="btn gray" data-bpdel="' + (i - nBuilt) + '">Delete</button>') + '</div></div>';
    });
    el.innerHTML = h;
    el.querySelectorAll('canvas[data-bpprev]').forEach(function (c) { drawBpPreview(c, all[+c.dataset.bpprev]); });
    var sv = document.getElementById('bp-save');
    if (sv) sv.onclick = function () {
      BPLib.add(document.getElementById('bp-name').value.trim(), Game.clipboard.cells);
      renderBlueprints(); toast('Blueprint saved', 'good'); Audio2.play('build');
    };
  }
  function drawBpPreview(c, bp) {
    var ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    bp.cells.forEach(function (cl) {
      var B = Config.B[cl.type]; if (!B) return;
      x0 = Math.min(x0, cl.dx); y0 = Math.min(y0, cl.dy); x1 = Math.max(x1, cl.dx + B.w); y1 = Math.max(y1, cl.dy + B.h);
    });
    if (!isFinite(x0)) return;
    var s = Math.min(c.width / (x1 - x0), c.height / (y1 - y0), 8);
    var ox = (c.width - (x1 - x0) * s) / 2, oy = (c.height - (y1 - y0) * s) / 2;
    bp.cells.forEach(function (cl) {
      var B = Config.B[cl.type]; if (!B) return;
      ctx.fillStyle = Renderer.buildingColor(cl.type);
      ctx.fillRect(ox + (cl.dx - x0) * s + 0.5, oy + (cl.dy - y0) * s + 0.5, B.w * s - 1, B.h * s - 1);
    });
  }

  function renderPlayers() {
    var el = document.getElementById('playersBody');
    if (Sess.mode !== 'net') { el.innerHTML = '<p style="color:#8aa;font-size:12px">Singleplayer.</p>'; return; }
    var iAmHost = Sess.role === 'host';
    var iAmAdmin = iAmHost || Sess.role === 'admin';
    var h = '<div style="font-size:12px;color:#8aa;margin-bottom:4px">Invite code — tap to copy</div>' +
      '<div id="invitecode" title="Copy">' + esc(Sess.code || '') + '</div>';
    h += '<div style="font-size:12px;color:#8aa;margin:10px 0 4px">' + Sess.players().length + ' connected</div>';
    Sess.players().forEach(function (p) {
      var initial = (p.name || '?').charAt(0).toUpperCase();
      h += '<div class="plrow"><span class="avatar" style="background:' + p.color + '">' + esc(initial) + '</span>' +
        '<span style="flex:1">' + esc(p.name) + (p.id === Sess.myId ? ' <span style="color:#667">(you)</span>' : '') + '</span>' +
        '<span class="rolebadge ' + p.role + '">' + p.role + '</span>';
      if (p.id !== Sess.myId && p.role !== 'host') {
        if (iAmHost) {
          if (p.role !== 'admin') h += '<button class="btn gray" style="padding:2px 6px" data-mkrole="admin" data-pid="' + p.id + '">Admin</button>';
          if (p.role !== 'spectator') h += '<button class="btn gray" style="padding:2px 6px" data-mkrole="spectator" data-pid="' + p.id + '">Spec</button>';
          else h += '<button class="btn gray" style="padding:2px 6px" data-mkrole="player" data-pid="' + p.id + '">Player</button>';
        }
        if (iAmAdmin) h += '<button class="btn red" style="padding:2px 6px" data-kick="' + p.id + '">Kick</button>';
      }
      h += '</div>';
    });
    el.innerHTML = h;
    var inv = document.getElementById('invitecode');
    if (inv) inv.onclick = function () {
      try { navigator.clipboard.writeText(Sess.code); toast('Invite code copied', 'good'); } catch (e) {}
    };
  }

  function drawSpark(id, data, color) {
    var c = document.getElementById(id); if (!c || !data || !data.length) return;
    var ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
    var mn = Math.min.apply(null, data), mx = Math.max.apply(null, data); if (mx - mn < 1e-6) mx = mn + 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = i / (data.length - 1) * c.width;
      var y = c.height - ((data[i] - mn) / (mx - mn)) * (c.height - 8) - 4;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#8aa'; ctx.font = '9px sans-serif'; ctx.fillText(Util.fmt(mx), 2, 10); ctx.fillText(Util.fmt(mn), 2, c.height - 3);
  }

  function refresh() {
    topBar();
    if (!document.getElementById('selinfo').classList.contains('hidden')) selInfo();
  }

  return { toast: toast, topBar: topBar, buildBar: buildBar, selInfo: selInfo, openModal: openModal,
    closeModal: closeModal, renderResearch: renderResearch, renderMarket: renderMarket, renderStats: renderStats,
    renderSettings: renderSettings, renderBlueprints: renderBlueprints, renderPlayers: renderPlayers, refresh: refresh, esc: esc,
    get buildCat() { return buildCat; }, set buildCat(v) { buildCat = v; },
    get activeModalId() { return activeModal ? activeModal.id : null; } };
})();

/* ============================ INPUT ================================ */
var Input = (function () {
  var dragging = false, dragMoved = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  var pinch = null;
  var longTimer = null;

  function init() {
    var c = document.getElementById('game');
    c.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove', onTouchMove, { passive: false });
    c.addEventListener('touchend', onTouchEnd, { passive: false });
    c.addEventListener('touchcancel', onTouchEnd, { passive: false });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); var w = Camera.screenToWorld(e.clientX, e.clientY); Game.rightClickAt(w[0], w[1]); });
  }
  function onDown(e) { if (e.button !== 0) return; startDrag(e.clientX, e.clientY); }
  function onMove(e) { if (!dragging && !Game.tool) { updateHover(e.clientX, e.clientY); return; } moveDrag(e.clientX, e.clientY); updateHover(e.clientX, e.clientY); }
  function onUp(e) { endDrag(e.clientX, e.clientY); }
  function onWheel(e) { e.preventDefault(); Camera.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89); }
  function startDrag(x, y) {
    dragging = true; dragMoved = false; lastX = downX = x; lastY = downY = y;
    longTimer = setTimeout(function () { if (!dragMoved) { var w = Camera.screenToWorld(x, y); Game.longPressAt(w[0], w[1]); } }, 500);
  }
  function moveDrag(x, y) {
    if (!dragging) return;
    var dx = x - lastX, dy = y - lastY;
    if (Math.abs(x - downX) + Math.abs(y - downY) > 6) { dragMoved = true; clearTimeout(longTimer); }
    if (Game.tool && Config.B[Game.tool] && Config.B[Game.tool].drag && dragMoved && !Game.deleteMode) {
      var w = Camera.screenToWorld(x, y); Game.dragPlaceAt(w[0], w[1]);
    } else if (Game.deleteMode && dragMoved) {
      var w2 = Camera.screenToWorld(x, y); Game.deleteAt(w2[0], w2[1]);
    } else {
      Camera.pan(dx, dy);
    }
    lastX = x; lastY = y;
  }
  function endDrag(x, y) {
    clearTimeout(longTimer);
    if (dragging && !dragMoved) { var w = Camera.screenToWorld(x, y); Game.tapAt(w[0], w[1]); }
    dragging = false;
  }
  function updateHover(x, y) { var w = Camera.screenToWorld(x, y); Game.updateHover(w[0], w[1]); }
  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) { var t = e.touches[0]; startDrag(t.clientX, t.clientY); updateHover(t.clientX, t.clientY); }
    else if (e.touches.length === 2) { dragging = false; clearTimeout(longTimer); pinch = touchPinch(e); }
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2 && pinch) {
      var np = touchPinch(e);
      Camera.zoomAt(np.cx, np.cy, np.d / pinch.d);
      Camera.pan(np.cx - pinch.cx, np.cy - pinch.cy);
      pinch = np;
    } else if (e.touches.length === 1 && dragging) {
      var t = e.touches[0]; moveDrag(t.clientX, t.clientY); updateHover(t.clientX, t.clientY);
    }
  }
  function onTouchEnd(e) {
    if (pinch && e.touches.length < 2) pinch = null;
    if (e.touches.length === 0 && dragging) { var t = e.changedTouches[0]; endDrag(t.clientX, t.clientY); }
  }
  function touchPinch(e) {
    var a = e.touches[0], b = e.touches[1];
    return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
  }
  return { init: init };
})();

/* ============================ GAME (controller) ==================== */
var Game = (function () {
  var tool = null, rot = 0, deleteMode = false, pasteMode = false;
  var selected = null, hoverTile = null, hoverWorld = null;
  var clipboard = null;
  var fps = 60, animT = 0;
  // prediction state
  var pending = new Map();        // seq -> ghost {kind,...}
  var pendingRemove = new Set();  // entity ids awaiting confirmed removal
  var metaBySeq = new Map();      // seq -> {kind:'user'|'undo'|'redo', gid, n}
  var groups = new Map();         // gid -> {kind, expect, got, inv:[]}
  var gidN = 1;
  var undoStack = [], redoStack = [];

  /* -------------------- command submission ------------------------- */
  function submit(cmd, meta) {
    if (Sess.role === 'spectator') { UI.toast('Spectators cannot act', 'warn'); Audio2.play('error'); return -1; }
    var seq = Sess.submit(cmd);
    if (meta) metaBySeq.set(seq, meta);
    return seq;
  }
  function submitGroup(cmds, kind) {
    var gid = gidN++;
    groups.set(gid, { kind: kind, expect: cmds.length, got: 0, inv: [] });
    cmds.forEach(function (c) { submit(c, { kind: kind, gid: gid }); });
    return gid;
  }

  function inverseOf(cmd, res) {
    switch (cmd.t) {
      case 'place': return [{ t: 'remove', id: res.id }];
      case 'remove': return [{ t: 'restore', data: res.data, cost: res.refund }];
      case 'restore': return [{ t: 'remove', id: res.id }];
      case 'paste': return res.ids.length ? [{ t: 'removeMany', ids: res.ids }] : [];
      case 'removeMany': return res.removed.map(function (d) { return { t: 'restore', data: d, cost: Math.floor(Config.B[d.t].cost * 0.5) }; });
      default: return [];
    }
  }

  // core 'applied' events: clear ghosts, collect undo/redo inverses
  function onApplied(cmd, res) {
    if (cmd._p !== Sess.myId) { onRemoteApplied(cmd, res); return; }
    if (cmd._q !== undefined) {
      pending.delete(cmd._q);
      if (cmd.t === 'remove') pendingRemove.delete(cmd.id);
      var meta = metaBySeq.get(cmd._q);
      metaBySeq.delete(cmd._q);
      if (meta && meta.gid !== undefined) {
        var grp = groups.get(meta.gid);
        if (grp) {
          grp.got++;
          grp.inv = grp.inv.concat(inverseOf(cmd, res));
          if (grp.got >= grp.expect) {
            groups.delete(meta.gid);
            if (grp.inv.length) {
              var entry = { cmds: grp.inv.reverse() };
              if (grp.kind === 'user') { undoStack.push(entry); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
              else if (grp.kind === 'undo') redoStack.push(entry);
              else if (grp.kind === 'redo') undoStack.push(entry);
            }
          }
        }
      }
    }
    UI.topBar();
  }
  function onRemoteApplied(cmd) {
    // another player (or the AI) changed the world; invalidate stale local UI
    if (selected && !G.Grid.entities.has(selected.id)) clearSelection();
  }
  function onReject(seq, reason) {
    var g = pending.get(seq);
    pending.delete(seq);
    if (g && g.kind === 'remove') pendingRemove.delete(g.id);
    var meta = metaBySeq.get(seq); metaBySeq.delete(seq);
    if (meta && meta.gid !== undefined) {
      var grp = groups.get(meta.gid);
      if (grp) { grp.expect--; if (grp.got >= grp.expect && grp.expect >= 0) { /* flush handled on next applied */ } }
    }
    if (reason !== 'gone') { UI.toast('Rejected: ' + reason, 'warn'); Audio2.play('error'); }
  }

  function undo() {
    var entry = undoStack.pop(); if (!entry) return;
    submitGroup(entry.cmds, 'undo');
  }
  function redo() {
    var entry = redoStack.pop(); if (!entry) return;
    submitGroup(entry.cmds, 'redo');
  }

  /* ----------------------- placement helpers ----------------------- */
  function canPlaceTool(tx, ty) {
    if (!tool) return false;
    if (G.Commands.canPlaceType(tool, tx, ty) !== null) return false;
    // also blocked by our own predicted (not yet applied) placements
    var B = Config.B[tool];
    var blocked = false;
    pending.forEach(function (g) {
      if (g.kind !== 'place') return;
      var GB = Config.B[g.type];
      if (tx < g.x + GB.w && tx + B.w > g.x && ty < g.y + GB.h && ty + B.h > g.y) blocked = true;
    });
    return !blocked;
  }

  function placeAt(tx, ty) {
    var seq = submit({ t: 'place', type: tool, x: tx, y: ty, rot: rot }, { kind: 'user', gid: gidN, n: 1 });
    if (seq < 0) return;
    groups.set(gidN, { kind: 'user', expect: 1, got: 0, inv: [] }); gidN++;
    pending.set(seq, { kind: 'place', type: tool, x: tx, y: ty, rot: rot });
    Audio2.play(Config.B[tool].cost > 50 ? 'build' : 'place');
  }

  /* --------------------------- interaction ------------------------- */
  function tileFromWorld(wx, wy) { return { tx: Math.floor(wx / Config.TILE), ty: Math.floor(wy / Config.TILE) }; }
  function updateHover(wx, wy) { hoverTile = tileFromWorld(wx, wy); hoverWorld = [wx, wy]; }

  function tapAt(wx, wy) {
    var t = tileFromWorld(wx, wy);
    if (pasteMode && clipboard) { doPaste(t.tx, t.ty); return; }
    if (deleteMode) { deleteAt(wx, wy); return; }
    if (tool && Sess.role !== 'spectator') {
      if (canPlaceTool(t.tx, t.ty)) placeAt(t.tx, t.ty);
      else {
        var why = G.Commands.canPlaceType(tool, t.tx, t.ty);
        Audio2.play('error');
        if (why === 'not enough money') UI.toast('Not enough money', 'bad');
      }
      return;
    }
    var e = G.Grid.entAt(t.tx, t.ty);
    if (e) { selected = e; UI.selInfo(); Audio2.play('click'); }
    else clearSelection();
  }

  function dragPlaceAt(wx, wy) {
    if (!tool || Sess.role === 'spectator') return;
    var t = tileFromWorld(wx, wy);
    if (canPlaceTool(t.tx, t.ty)) placeAt(t.tx, t.ty);
  }
  function deleteAt(wx, wy) {
    var t = tileFromWorld(wx, wy);
    var e = G.Grid.entAt(t.tx, t.ty);
    if (e && !pendingRemove.has(e.id)) {
      var seq = submit({ t: 'remove', id: e.id }, { kind: 'user', gid: gidN });
      if (seq < 0) return;
      groups.set(gidN, { kind: 'user', expect: 1, got: 0, inv: [] }); gidN++;
      pending.set(seq, { kind: 'remove', id: e.id });
      pendingRemove.add(e.id);
      Audio2.play('remove');
    }
  }
  function longPressAt(wx, wy) {
    var t = tileFromWorld(wx, wy); var e = G.Grid.entAt(t.tx, t.ty);
    if (e) { selected = e; UI.selInfo(); UI.toast('Selected ' + Config.B[e.type].name, ''); }
  }
  function rightClickAt(wx, wy) { deleteAt(wx, wy); }

  /* ------------------------- copy / paste --------------------------- */
  function startCopy() {
    var center = selected || { tx: hoverTile ? hoverTile.tx : 0, ty: hoverTile ? hoverTile.ty : 0 };
    var R = 4; var cells = []; var seen = new Set();
    for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) {
      var e = G.Grid.entAt(center.tx + dx, center.ty + dy);
      if (e && !seen.has(e.id)) { seen.add(e.id); cells.push({ dx: e.tx - center.tx, dy: e.ty - center.ty, type: e.type, rot: e.rot, recipe: e.recipe }); }
    }
    if (cells.length) { clipboard = { cells: cells, fromLib: false }; pasteMode = true; tool = null; UI.buildBar(); UI.toast('Copied ' + cells.length + ' buildings — tap to paste, or save in 📐', 'good'); }
    else UI.toast('Nothing to copy near selection', 'warn');
  }
  function doPaste(tx, ty) {
    var seq = submit({ t: 'paste', cells: clipboard.cells, x: tx, y: ty }, { kind: 'user', gid: gidN });
    if (seq < 0) return;
    groups.set(gidN, { kind: 'user', expect: 1, got: 0, inv: [] }); gidN++;
    pending.set(seq, { kind: 'paste', cells: clipboard.cells, x: tx, y: ty });
  }
  function placeBlueprint(i) {
    var bp = BPLib.all()[i]; if (!bp) return;
    clipboard = { cells: bp.cells, fromLib: true };
    pasteMode = true; tool = null; deleteMode = false;
    document.getElementById('btn-delete').classList.remove('on');
    UI.closeModal(); UI.buildBar();
    UI.toast('Placing "' + bp.name + '" — tap the map (Esc to stop)', 'good');
  }
  function openBlueprints() {
    if (!G.Research.done.has('blueprints')) { UI.toast('Locked — research Blueprints (Tier 1) first', 'warn'); Audio2.play('error'); return; }
    UI.openModal('blueprintModal');
  }

  /* ------------------------- tool selection ------------------------- */
  function selectTool(t) {
    if (t && Config.B[t].tech && !G.Research.done.has(Config.B[t].tech)) {
      UI.toast('Locked — research ' + Config.TECH[Config.B[t].tech].name, 'warn'); Audio2.play('error'); return;
    }
    tool = tool === t ? null : t; deleteMode = false; pasteMode = false; clearSelection(); UI.buildBar();
    document.getElementById('btn-delete').classList.remove('on');
    Audio2.play('click');
  }
  function toggleDelete() {
    deleteMode = !deleteMode; tool = null; pasteMode = false; UI.buildBar();
    document.getElementById('btn-delete').classList.toggle('on', deleteMode);
  }
  function rotate() {
    rot = (rot + 1) % 4;
    if (selected) submit({ t: 'rotate', id: selected.id });
    Audio2.play('click');
  }
  function clearSelection() { selected = null; UI.selInfo(); }

  /* ------------------------- fx / event hooks ----------------------- */
  function visible(x, y) {
    var s = Camera.worldToScreen(x, y);
    return s[0] > -100 && s[1] > -100 && s[0] < Camera.W + 100 && s[1] < Camera.H + 100;
  }
  function bindHooks() {
    G.hooks.fx = function (type, x, y, extra) {
      if (!visible(x, y)) return;
      if (type === 'smoke') { if (Math.random() < 0.25) Particles.smoke(x, y); }
      else if (type === 'place') { if (extra && extra.cost > 50) Particles.spark(x, y); }
      else if (type === 'remove') { /* handled by local sfx on submit */ }
    };
    G.hooks.event = function (name, d) {
      if (name === 'applied') onApplied(d.cmd, d.res);
      else if (name === 'research') {
        var by = d.by === Sess.myId ? 'You' : playerName(d.by);
        UI.toast(by + ' researched: ' + Config.TECH[d.tech].name, 'good');
        Audio2.play('research'); UI.buildBar();
        if (UI.activeModalId === 'researchModal') UI.renderResearch();
      }
      else if (name === 'aiTech') UI.toast(d.name + ' advanced to Tech ' + d.tech, '');
      else if (name === 'weather') { /* settings modal reflects on reopen */ }
      else if (name === 'paste' && d.by !== Sess.myId && d.count) UI.toast(playerName(d.by) + ' pasted ' + d.count + ' buildings', '');
      else if (name === 'restored') { clearSelection(); UI.buildBar(); UI.topBar(); }
    };
  }
  function playerName(id) {
    if (Sess.mode !== 'net') return 'You';
    var p = Sess.playersMap.get(id);
    return p ? p.name : (id === 0 ? 'Server' : 'Player ' + id);
  }

  /* --------------------------- lifecycle ---------------------------- */
  function findStart() {
    for (var r = 0; r < 40; r++) {
      for (var a = 0; a < r * 4 + 1; a++) {
        var ang = a / (r * 4 + 1) * Util.TAU;
        var tx = Math.round(Math.cos(ang) * r), ty = Math.round(Math.sin(ang) * r);
        var t = G.World.tileAt(tx, ty);
        if (t.r === 'iron' && t.amt > 0) { Camera.x = tx * Config.TILE; Camera.y = ty * Config.TILE; return; }
      }
    }
  }

  function resetLocalUI() {
    pending.clear(); pendingRemove.clear(); metaBySeq.clear(); groups.clear();
    undoStack.length = 0; redoStack.length = 0;
    tool = null; deleteMode = false; pasteMode = false; clipboard = null; selected = null;
    Particles.reset();
  }

  function enterGame() {
    document.getElementById('mainmenu').classList.add('hidden');
    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('loadingscr').style.display = 'none';
    document.getElementById('btn-players').classList.toggle('hidden', Sess.mode !== 'net');
    var spec = Sess.role === 'spectator';
    document.getElementById('edittools').classList.toggle('hidden', spec);
    Chat.show(Sess.mode === 'net');
    UI.buildBar(); UI.topBar();
    // legacy globals for tooling/tests
    window.G = G; window.Sess = Sess;
    window.World = G.World; window.Grid = G.Grid; window.Sim = G.Sim;
    window.Economy = G.Economy; window.Research = G.Research; window.AI = G.AI;
  }

  function startLocal(saveData) {
    resetLocalUI();
    G = Core.createGame({ seed: saveData ? saveData.snap.seed : undefined });
    if (saveData) G.Snapshot.restore(saveData.snap);
    bindHooks();
    Sess = LocalSession(G, {
      reject: function (seq, reason) { onReject(seq, reason); },
    });
    if (saveData && saveData.cam) { Camera.x = saveData.cam.x; Camera.y = saveData.cam.y; Camera.zoom = saveData.cam.z; }
    else findStart();
    enterGame();
    UI.toast(saveData ? 'World loaded' : 'New world generated', 'good');
  }

  function startNet(url, intent) {
    resetLocalUI();
    G = null;
    var sess;
    sess = NetSession(null, url, {
      ensureGame: function (seed) {
        if (!G || G.seed !== seed) {
          G = Core.createGame({ seed: seed });
          bindHooks();
        }
        return G;
      },
      game: function () { return G; },
      joined: function () {
        // the snapshot decompresses asynchronously; only enter the game
        // world once BOTH the welcome and the restored state are in hand
        Sess = sess;
        joinedReady = true;
        document.getElementById('reconn').classList.add('hidden');
        if (G) finishJoin();
      },
      snapshot: function (why) {
        if (why === 'desync') UI.toast('State resynced from server', 'warn');
        if (!hasCentered) { centerAfterSnap(); hasCentered = true; }
        if (joinedReady && !inWorld) finishJoin();
        else { UI.buildBar(); UI.topBar(); }
      },
      reject: function (seq, reason) { onReject(seq, reason); },
      status: function (s) { UI.topBar(); },
      lobby: function (rooms) { Lobby.onRooms(rooms); },
      fail: function (reason) { Lobby.onFail(reason); },
      reconnecting: function (attempt, delay) {
        document.getElementById('reconn').classList.remove('hidden');
        document.getElementById('reconn-msg').textContent =
          'Reconnecting — attempt ' + attempt + ' (next in ' + Math.round(delay / 1000) + 's)…';
      },
      players: function (kind, p) {
        if (kind === 'join' && p) { UI.toast(p.name + ' joined', 'good'); Chat.system(p.name + ' joined the game'); Audio2.play('join'); }
        if (kind === 'leave' && p) { UI.toast(p.name + ' left', ''); Chat.system(p.name + ' left the game'); Audio2.play('leave'); }
        if (kind === 'role' && p) { UI.toast(p.name + ' is now ' + p.role, ''); Chat.system(p.name + ' is now ' + p.role); }
        if (p && p.id === sess.myId) { UI.buildBar(); document.getElementById('edittools').classList.toggle('hidden', sess.role === 'spectator'); }
        if (UI.activeModalId === 'playersModal') UI.renderPlayers();
        UI.topBar();
      },
      chat: function (m) { Chat.append(m.name, m.color, m.text, m.id === sess.myId); },
      saved: function (by) { UI.toast('Server saved the world (' + by + ')', 'good'); },
      kicked: function () { UI.toast('You were kicked from the game', 'bad'); setTimeout(function () { location.reload(); }, 1500); },
      desync: function () {},
      rtt: function () { UI.topBar(); },
      ticked: function () {},
      pollCursor: function () {
        if (hoverWorld) sess.sendCursor(Math.round(hoverWorld[0]), Math.round(hoverWorld[1]));
        if (++viewCounter % 20 === 0) {
          var a = Camera.screenToWorld(0, 0), b = Camera.screenToWorld(Camera.W, Camera.H);
          sess.sendView([Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1])]);
        }
      },
    });
    var hasCentered = false, viewCounter = 0, joinedReady = false, inWorld = false;
    function finishJoin() {
      inWorld = true;
      enterGame();
      // replay recent chat that arrived in the welcome payload (enterGame cleared the log)
      (sess.chatHistory || []).forEach(function (c) { Chat.append(c.name, c.color, c.text, false); });
      UI.toast('Joined "' + sess.roomName + '" as ' + sess.role, 'good');
      Audio2.play('join');
    }
    function centerAfterSnap() {
      var first = null;
      G.Grid.entities.forEach(function (e) { if (!first) first = e; });
      if (first) { Camera.x = first.cx; Camera.y = first.cy; }
      else findStart();
    }
    sess.begin(intent);
    return sess;
  }

  /* --------------------------- main loop ---------------------------- */
  var lastT = 0, fpsT = 0, fpsC = 0, uiT = 0, autosaveT = 0;
  function loop(t) {
    var dt = Math.min(50, t - lastT) / 1000; lastT = t;
    animT += dt;
    if (G && Sess) {
      Sess.pump(t);
      Particles.update(dt);
      if (G.S.weather === 'rain') {
        spawnRain();
        if (Math.random() < 0.002) Audio2.play('thunder');
      }
      Renderer.frame();
      uiT += dt; if (uiT >= 0.25) { uiT = 0; UI.refresh(); if (UI.activeModalId === 'statsModal') UI.renderStats(); }
      if (Sess.mode === 'local') {
        autosaveT += dt;
        if (autosaveT >= 60) { autosaveT = 0; if (Save.save()) UI.toast('Auto-saved', 'good'); }
      }
    }
    fpsC++; fpsT += dt; if (fpsT >= 0.5) { fps = fpsC / fpsT; fpsC = 0; fpsT = 0; }
    requestAnimationFrame(loop);
  }
  function spawnRain() {
    var vb = Camera.visibleTileBounds();
    for (var i = 0; i < 4; i++) {
      var wx = (vb.tx0 + Math.random() * (vb.tx1 - vb.tx0)) * Config.TILE;
      var wy = (vb.ty0 + Math.random() * (vb.ty1 - vb.ty0)) * Config.TILE - 300;
      Particles.rainDrop(wx, wy);
    }
  }

  /* --------------------------- UI wiring ---------------------------- */
  function bindUI() {
    document.getElementById('btn-build').onclick = function () { document.getElementById('buildbar').classList.toggle('hidden'); Audio2.play('click'); };
    document.getElementById('btn-blueprints').onclick = openBlueprints;
    document.getElementById('btn-research').onclick = function () { UI.openModal('researchModal'); };
    document.getElementById('btn-market').onclick = function () { UI.openModal('marketModal'); };
    document.getElementById('btn-stats').onclick = function () { UI.openModal('statsModal'); };
    document.getElementById('btn-players').onclick = function () { UI.openModal('playersModal'); };
    document.getElementById('btn-settings').onclick = function () { UI.openModal('settingsModal'); };
    document.getElementById('btn-rotate').onclick = rotate;
    document.getElementById('btn-copy').onclick = startCopy;
    document.getElementById('btn-undo').onclick = undo;
    document.getElementById('btn-redo').onclick = redo;
    document.getElementById('btn-delete').onclick = toggleDelete;
    document.getElementById('sel-close').onclick = clearSelection;   // was an inline onclick (removed for CSP)
    document.getElementById('buildbar').addEventListener('click', function (e) {
      var cat = e.target.closest('[data-cat]'); if (cat) { UI.buildCat = cat.dataset.cat; UI.buildBar(); return; }
      var t = e.target.closest('[data-tool]'); if (t) selectTool(t.dataset.tool);
    });
    document.getElementById('selbody').addEventListener('click', function (e) {
      var rec = e.target.closest('[data-rec]');
      if (rec && selected) { submit({ t: 'setRecipe', id: selected.id, recipe: rec.dataset.rec }); return; }
      if (e.target.dataset.rot2) { rotate(); return; }
      if (e.target.dataset.del2 && selected) {
        var id = selected.id;
        if (!pendingRemove.has(id)) {
          var seq = submit({ t: 'remove', id: id }, { kind: 'user', gid: gidN });
          if (seq >= 0) { groups.set(gidN, { kind: 'user', expect: 1, got: 0, inv: [] }); gidN++; pending.set(seq, { kind: 'remove', id: id }); pendingRemove.add(id); Audio2.play('remove'); }
        }
        clearSelection(); return;
      }
      var col = e.target.closest('[data-collect]');
      if (col && selected) { submit({ t: 'collect', id: selected.id }); UI.toast('Collected to team inventory', 'good'); }
    });
    document.body.addEventListener('click', function (e) {
      if (e.target.dataset && e.target.dataset.close !== undefined) { UI.closeModal(); return; }
      var tech = e.target.closest('[data-tech]'); if (tech) { submit({ t: 'research', tech: tech.dataset.tech }); return; }
      var sell = e.target.closest('[data-sell]'); if (sell) { submit({ t: 'sell', item: sell.dataset.sell, qty: 10 }); Audio2.play('sell'); setTimeout(UI.renderMarket, 120); return; }
      var buy = e.target.closest('[data-buy]'); if (buy) { submit({ t: 'buy', item: buy.dataset.buy, qty: 10 }); setTimeout(UI.renderMarket, 120); return; }
      var bpp = e.target.closest('[data-bpplace]'); if (bpp) { placeBlueprint(+bpp.dataset.bpplace); return; }
      var bpd = e.target.closest('[data-bpdel]'); if (bpd) { BPLib.remove(+bpd.dataset.bpdel); UI.renderBlueprints(); Audio2.play('remove'); return; }
      var mk = e.target.closest('[data-mkrole]'); if (mk) { Sess.admin('role', +mk.dataset.pid, mk.dataset.mkrole); return; }
      var kk = e.target.closest('[data-kick]'); if (kk) { Sess.admin('kick', +kk.dataset.kick); return; }
    });
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (!G) return;
      switch (e.key.toLowerCase()) {
        case 'r': rotate(); break;
        case 'c': startCopy(); break;
        case 'z': undo(); break;
        case 'y': redo(); break;
        case 'x': toggleDelete(); break;
        case 'b': openBlueprints(); break;
        case 'enter': case 't':
          if (Sess && Sess.mode === 'net' && !UI.activeModalId) { Chat.open(); e.preventDefault(); }
          break;
        case 'escape':
          tool = null; deleteMode = false; pasteMode = false; clearSelection(); UI.buildBar(); UI.closeModal();
          document.getElementById('btn-delete').classList.remove('on');
          break;
      }
    });
    window.addEventListener('resize', function () { Renderer.resize(); });
  }

  /* ----------------------------- boot ------------------------------- */
  function boot() {
    Renderer.init();
    Input.init();
    bindUI();
    Chat.init();
    Lobby.init();
    document.getElementById('loadingscr').style.display = 'none';
    document.getElementById('mainmenu').classList.remove('hidden');
    var cont = document.getElementById('mm-continue');
    if (!Save.hasSave()) { cont.disabled = true; cont.style.opacity = 0.4; }
    cont.onclick = function () { var d = Save.loadData(); if (d) startLocal(d); };
    document.getElementById('mm-new').onclick = function () { startLocal(null); };
    document.getElementById('mm-multi').onclick = function () { Lobby.show(); };
    lastT = performance.now();
    requestAnimationFrame(loop);
  }

  return {
    boot: boot, startLocal: startLocal, startNet: startNet, submit: submit,
    tapAt: tapAt, dragPlaceAt: dragPlaceAt, deleteAt: deleteAt, longPressAt: longPressAt,
    rightClickAt: rightClickAt, updateHover: updateHover, selectTool: selectTool, rotate: rotate,
    startCopy: startCopy, undo: undo, redo: redo, toggleDelete: toggleDelete,
    clearSelection: clearSelection, canPlaceTool: canPlaceTool, placeBlueprint: placeBlueprint,
    openBlueprints: openBlueprints,
    pending: pending, pendingRemove: pendingRemove,
    get tool() { return tool; }, set tool(v) { tool = v; },
    get rot() { return rot; }, set rot(v) { rot = v; },
    get deleteMode() { return deleteMode; }, get pasteMode() { return pasteMode; },
    get selected() { return selected; }, get hoverTile() { return hoverTile; },
    get clipboard() { return clipboard; },
    get fps() { return fps; }, get animT() { return animT; },
    get undoStack() { return undoStack; }, get redoStack() { return redoStack; },
  };
})();

/* ============================ CHAT ================================= */
// In-game text chat for multiplayer. Chat is NOT part of the deterministic
// simulation — it's a reliable side channel relayed by the server. The log
// fades when idle and expands (input focused) on Enter / the 💬 button.
var Chat = (function () {
  var wrap, logEl, inputEl, fadeTimer = null, expanded = false;
  function init() {
    wrap = document.getElementById('chat');
    logEl = document.getElementById('chatlog');
    inputEl = document.getElementById('chatinput');
    document.getElementById('btn-chat').onclick = function () { expanded ? collapse() : open(); };
    inputEl.addEventListener('keydown', function (e) {
      e.stopPropagation();   // don't let game shortcuts see keys typed into chat
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
      else if (e.key === 'Escape') { e.preventDefault(); collapse(); }
    });
    inputEl.addEventListener('blur', function () { if (expanded) collapse(); });
  }
  function show(isNet) {
    document.getElementById('btn-chat').classList.toggle('hidden', !isNet);
    wrap.classList.toggle('hidden', !isNet);
    logEl.innerHTML = '';
    if (isNet) { expanded = false; wrap.classList.remove('open'); logEl.style.opacity = '1'; scheduleFade(); }
  }
  function open() {
    if (wrap.classList.contains('hidden')) return;
    expanded = true; wrap.classList.add('open');
    clearTimeout(fadeTimer); logEl.style.opacity = '1';
    inputEl.focus();
  }
  function collapse() {
    expanded = false; wrap.classList.remove('open');
    inputEl.value = ''; inputEl.blur();
    scheduleFade();
  }
  function sendMsg() {
    var t = inputEl.value.trim();
    if (t && Sess && Sess.sendChat) Sess.sendChat(t);
    collapse();
  }
  function scheduleFade() {
    clearTimeout(fadeTimer);
    logEl.style.opacity = '1';
    fadeTimer = setTimeout(function () { if (!expanded) logEl.style.opacity = '0'; }, 12000);
  }
  // append a message. Text/name are set via textContent — never innerHTML —
  // so hostile chat content can't inject markup.
  function append(name, color, text, mine) {
    if (!logEl) return;
    var row = document.createElement('div');
    row.className = 'cmsg';
    var nm = document.createElement('span');
    nm.className = 'cn'; nm.style.color = color || '#4aa3ff';
    nm.textContent = name + ': ';
    if (mine) row.style.opacity = '0.85';   // subtle marker for your own lines
    row.appendChild(nm);
    row.appendChild(document.createTextNode(text));
    push(row);
  }
  function system(text) {
    if (!logEl) return;
    var row = document.createElement('div');
    row.className = 'cmsg sys';
    row.textContent = text;
    push(row);
  }
  function push(row) {
    logEl.appendChild(row);
    while (logEl.childElementCount > 60) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    if (!expanded) scheduleFade();
  }
  return { init: init, show: show, open: open, append: append, system: system };
})();

/* ============================ LOBBY ================================= */
var Lobby = (function () {
  var COLORS = ['#4aa3ff', '#7CFC9E', '#ffd873', '#ff7a7a', '#d76fb0', '#9fd8e0', '#e0a074', '#b39ddb'];
  var color = COLORS[0];
  var browserSess = null;     // lobby connection (auth + room browser)
  var account = null;         // { id, username, color, guest } or null
  var authToken = null;       // persisted session token
  var authTab = 'guest';      // guest | login | register

  function el(id) { return document.getElementById(id); }
  function esc(s) { return UI.esc(s); }

  function init() {
    var sw = el('lb-colors');
    COLORS.forEach(function (c, i) {
      var d = document.createElement('div');
      d.className = 'swatch' + (i === 0 ? ' sel' : ''); d.style.background = c;
      d.onclick = function () {
        sw.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('sel'); });
        d.classList.add('sel'); color = c; savePrefs();
      };
      sw.appendChild(d);
    });
    try {
      var prefs = JSON.parse(localStorage.getItem('gearworks_prefs') || '{}');
      if (prefs.name) el('lb-name').value = prefs.name;
      if (prefs.color && COLORS.includes(prefs.color)) {
        color = prefs.color;
        sw.querySelectorAll('.swatch').forEach(function (x, i) { x.classList.toggle('sel', COLORS[i] === color); });
      }
      if (prefs.server) el('lb-server').value = prefs.server;
      authToken = localStorage.getItem('gearworks_token') || null;
    } catch (e) {}
    if (!el('lb-server').value) {
      el('lb-server').value = location.protocol.startsWith('http')
        ? location.origin.replace(/^http/, 'ws') : 'ws://localhost:8080';
    }
    el('lb-back').onclick = function () { hide(); el('mainmenu').classList.remove('hidden'); };
    el('lb-refresh').onclick = function () { reconnectBrowser(); };
    el('lb-create').onclick = function () {
      go({ kind: 'create', roomName: el('lb-roomname').value || 'Factory World',
        public: el('lb-public').checked, maxPlayers: +el('lb-max').value || 8,
        spectate: el('lb-spectate').checked });
    };
    el('lb-join').onclick = function () {
      var code = el('lb-code').value.trim().toUpperCase();
      if (code.length !== 6) { err('Enter a 6-character invite code'); return; }
      go({ kind: 'join', code: code, spectate: el('lb-spectate').checked });
    };
    el('lb-rooms').addEventListener('click', function (e) {
      var b = e.target.closest('[data-roomcode]');
      if (b) go({ kind: 'join', code: b.dataset.roomcode, spectate: el('lb-spectate').checked });
    });
    el('lb-myworlds').addEventListener('click', function (e) {
      var b = e.target.closest('[data-resume]');
      if (b) go({ kind: 'resume', code: b.dataset.resume, public: false });
    });
    el('reconn-leave').onclick = function () { location.reload(); };
    renderAccount();
  }

  function savePrefs() {
    try {
      localStorage.setItem('gearworks_prefs', JSON.stringify({
        name: el('lb-name').value, color: color, server: el('lb-server').value }));
    } catch (e) {}
  }

  function show() {
    el('mainmenu').classList.add('hidden');
    el('lobby').classList.remove('hidden');
    err('');
    reconnectBrowser();
  }
  function hide() {
    el('lobby').classList.add('hidden');
    if (browserSess) { browserSess.leave(); browserSess = null; }
  }
  function err(s) { el('lb-err').textContent = s || ''; }
  function setDot(cls) { var d = el('lb-conndot'); if (d) d.className = 'netdot ' + cls; }

  /* --------------------------- account UI --------------------------- */
  function renderAccount() {
    var host = el('lb-account');
    if (account) {
      host.innerHTML = '<div class="acc-signed"><span class="avatar" style="background:' + account.color + '">' +
        esc((account.username || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span style="flex:1">Signed in as <b>' + esc(account.username) + '</b>' + (account.guest ? ' <span style="color:#8aa">(guest)</span>' : '') + '</span>' +
        '<button class="btn gray" id="acc-logout">Log out</button></div>' +
        '<div class="acc-guest">Your worlds are saved to this account and appear below.</div>';
      el('acc-logout').onclick = logout;
      // identity comes from the account now
      el('lb-name').value = account.username; el('lb-name').disabled = true;
    } else {
      el('lb-name').disabled = false;
      var t = authTab;
      var h = '<div class="acc-tabs">' +
        '<div class="acc-tab ' + (t === 'guest' ? 'sel' : '') + '" data-atab="guest">Guest</div>' +
        '<div class="acc-tab ' + (t === 'login' ? 'sel' : '') + '" data-atab="login">Log in</div>' +
        '<div class="acc-tab ' + (t === 'register' ? 'sel' : '') + '" data-atab="register">Register</div></div>';
      if (t === 'guest') {
        h += '<div class="acc-guest">Play instantly. Sign up to keep your worlds across devices.</div>' +
          '<button class="btn" id="acc-go" style="width:100%;margin-top:6px">Continue as Guest</button>';
      } else {
        h += '<input class="txt" id="acc-user" placeholder="username" maxlength="20" autocomplete="username">' +
          '<input class="txt" id="acc-pass" type="password" placeholder="password (8+ chars)" maxlength="200" autocomplete="' + (t === 'register' ? 'new-password' : 'current-password') + '">' +
          '<button class="btn" id="acc-go" style="width:100%;margin-top:4px">' + (t === 'register' ? 'Create account' : 'Log in') + '</button>';
      }
      h += '<div class="acc-err" id="acc-err"></div>';
      host.innerHTML = h;
      host.querySelectorAll('[data-atab]').forEach(function (x) {
        x.onclick = function () { authTab = x.dataset.atab; renderAccount(); };
      });
      el('acc-go').onclick = doAuth;
      var pass = el('acc-pass'); if (pass) pass.onkeydown = function (e) { if (e.key === 'Enter') doAuth(); };
    }
  }

  function accErr(s) { var e = el('acc-err'); if (e) e.textContent = s || ''; }

  function doAuth() {
    if (!browserSess) { reconnectBrowser(); }
    if (!browserSess) { accErr('Not connected to a server'); return; }
    if (authTab === 'guest') {
      browserSess.sendAuth('guest', { username: el('lb-name').value || 'Guest', color: color });
    } else {
      var u = (el('acc-user').value || '').trim(), p = el('acc-pass').value || '';
      if (!u || !p) { accErr('Enter a username and password'); return; }
      accErr('…');
      browserSess.sendAuth(authTab, { username: u, password: p, color: color });
    }
  }

  function onAuth(m) {
    if (!m.ok) { accErr(m.error || 'failed'); return; }
    account = m.account;
    authToken = m.token;
    try { localStorage.setItem('gearworks_token', authToken); } catch (e) {}
    renderAccount();
    if (browserSess) browserSess.requestMyWorlds();
  }

  function logout() {
    account = null; authToken = null;
    try { localStorage.removeItem('gearworks_token'); } catch (e) {}
    if (browserSess) browserSess.sendLogout();
    renderAccount();
    el('lb-myworlds').innerHTML = '';
  }

  function onMyWorlds(worlds) {
    var host = el('lb-myworlds');
    if (!account || !worlds || !worlds.length) { host.innerHTML = ''; return; }
    var h = '<div class="divider"></div><b style="font-size:13px">Your saved worlds</b>';
    worlds.forEach(function (w) {
      var when = w.savedAt ? new Date(w.savedAt).toLocaleString() : '';
      h += '<div class="world-row"><div><div class="wn">' + esc(w.name) + '</div>' +
        '<div class="wd">' + esc(w.code) + (when ? ' • ' + esc(when) : '') + '</div></div>' +
        '<button class="btn" data-resume="' + esc(w.code) + '">Resume</button></div>';
    });
    host.innerHTML = h;
  }

  /* --------------------------- room browser ------------------------- */
  function reconnectBrowser() {
    if (browserSess) { browserSess.listRooms(); if (account) browserSess.requestMyWorlds(); return; }
    savePrefs();
    setDot('warn');
    browserSess = NetSession(null, el('lb-server').value, {
      ensureGame: function () { return null; },
      game: function () { return null; },
      lobby: function (rooms, m) {
        setDot('on');
        if (m && m.maintenance) el('lb-maint').classList.remove('hidden'); else el('lb-maint').classList.add('hidden');
        if (m && m.account) { account = m.account; renderAccount(); browserSess.requestMyWorlds(); }
        onRooms(rooms);
      },
      auth: function (m) { onAuth(m); },
      myWorlds: function (worlds) { onMyWorlds(worlds); },
      fail: function (reason) { setDot('off'); onFail(reason); browserSess = null; },
      status: function (s) { if (s === 'offline') setDot('off'); },
    });
    // auto-login with a stored token so returning players are signed in
    browserSess.begin({ kind: 'browse', name: el('lb-name').value || 'Engineer', color: color, authToken: authToken });
  }

  function onRooms(rooms) {
    var host = el('lb-rooms');
    if (!rooms || !rooms.length) { host.innerHTML = '<p style="color:#667;font-size:12px">No public games yet — host one below!</p>'; return; }
    var h = '';
    rooms.forEach(function (r) {
      h += '<div class="roomrow"><div><div class="rn">' + esc(r.name) + '</div>' +
        '<div class="rd">' + r.players + '/' + r.maxPlayers + ' players' + (r.spectators ? ' +' + r.spectators + ' 👁' : '') + ' • code ' + esc(r.code) + '</div></div>' +
        '<button class="btn" data-roomcode="' + esc(r.code) + '">Join</button></div>';
    });
    host.innerHTML = h;
  }
  // A first-connect failure is expected on a static host whose origin isn't a
  // game server — show a neutral hint, not an alarming "Connection failed".
  function onFail(reason) { err(reason && reason !== 'connection failed' ? reason : 'Not connected — check the server address, then Refresh.'); }

  function go(intent) {
    savePrefs();
    if (browserSess) { browserSess.leave(); browserSess = null; }
    intent.name = account ? account.username : (el('lb-name').value || 'Engineer');
    intent.color = color;
    intent.authToken = authToken;
    err('Connecting…');
    Game.startNet(el('lb-server').value, intent);
  }

  return { init: init, show: show, hide: hide, onRooms: onRooms, onFail: onFail };
})();

/* expose + launch */
window.Game = Game; window.UI = UI; window.Camera = Camera; window.Save = Save;
window.BPLib = BPLib; window.Audio2 = Audio2; window.Renderer = Renderer; window.Particles = Particles;
window.Chat = Chat;
window.addEventListener('load', function () {
  try { Game.boot(); }
  catch (e) {
    document.getElementById('loadingscr').innerHTML = '<h1>Error</h1><p>' + e.message + '</p>';
    console.error(e);
  }
});
