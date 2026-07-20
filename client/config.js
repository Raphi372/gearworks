/* ==========================================================================
   Runtime configuration for the hosted client.

   GEARWORKS_DEFAULT_SERVER is the game-server address the lobby pre-fills for
   players. Leave it EMPTY in the repo so local dev and single-box self-hosting
   keep working (the lobby then defaults to the current origin, or
   ws://localhost:8080 when opened from a file/no origin).

   When the client is deployed to Cloudflare Pages, the build step
   (scripts/build-client.js) rewrites this file from the BACKEND_URL build
   environment variable, so the public site auto-points at your Cloudflare
   Tunnel — e.g. "wss://play.yourdomain.com". Players can still override the
   address in the lobby.

   This is a plain same-origin script (CSP script-src 'self'); no inline JS.
   ========================================================================== */
window.GEARWORKS_DEFAULT_SERVER = "";
