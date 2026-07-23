/* ==========================================================================
   GEARWORKS CLIENT — UI, HUD, blueprints, and local save/load
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
