/* ==========================================================================
   GEARWORKS CLIENT — module exposition + boot
   Same-origin split module (P1.3): no bundler, shares global scope with the
   other client scripts loaded in index.html. Load order is fixed there.
   ========================================================================== */
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
