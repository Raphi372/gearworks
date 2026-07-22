/* ==========================================================================
   Runtime configuration for the hosted client.

   GEARWORKS_DEFAULT_SERVER — the game-server address the lobby pre-fills.
   GEARWORKS_DISCOVERY_URL  — optional pointer the client fetches on load to
                              auto-discover the CURRENT server address (so a
                              rotating quick-tunnel URL never needs re-typing).

   Both are EMPTY in the repo so local dev and single-box self-hosting keep
   working (the lobby then defaults to the current origin, or ws://localhost:8080
   when opened from a file/no origin). At deploy time the build step
   (scripts/build-client.js) rewrites this file from the BACKEND_URL and
   DISCOVERY_URL build environment variables. Discovery, when set, wins: the
   client fetches it and connects to whatever address it returns, so you point
   Cloudflare Pages at a STABLE pointer once and never touch it again — the
   pointer's contents are what the tunnel script keeps up to date.

   Players can always override the address in the lobby. Plain same-origin
   script (CSP script-src 'self'); no inline JS.
   ========================================================================== */
window.GEARWORKS_DEFAULT_SERVER = "";
window.GEARWORKS_DISCOVERY_URL = "";
