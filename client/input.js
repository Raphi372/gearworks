/* ==========================================================================
   GEARWORKS CLIENT — pointer/keyboard input handling
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
