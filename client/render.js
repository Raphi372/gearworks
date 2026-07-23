/* ==========================================================================
   GEARWORKS CLIENT — rendering (camera, particles, audio, canvas renderer)
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
