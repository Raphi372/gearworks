/* ==========================================================================
   GEARWORKS CLIENT — game controller (session wiring, prediction, lifecycle)
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
        Lobby.resumed && Lobby.resumed();
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
    // resume a live multiplayer game across a full page reload, if we hold a token
    var rtok = null; try { rtok = localStorage.getItem('gearworks_reconnect'); } catch (e) {}
    if (rtok) Lobby.resume(rtok);
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
