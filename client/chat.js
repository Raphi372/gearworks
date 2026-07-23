/* ==========================================================================
   GEARWORKS CLIENT — in-game chat
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
