# Production Operations

Running Gearworks as a real online game: configuration, security, scaling,
observability.

## Configuration reference

All via environment variables (12-factor). Defaults in parentheses.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP/WS listen port |
| `HOST` | `0.0.0.0` | bind address |
| `NODE_ENV` | `development` | `production` enables JSON logs |
| `STORAGE` | `file` | `file` or `postgres` |
| `SAVE_DIR` | `saves` | file backend directory (mount a volume at `/data`) |
| `DATABASE_URL` | — | required for `STORAGE=postgres` |
| `BACKUPS` | `5` | rotating file backups kept |
| `RESTORE_ON_BOOT` | `1` | re-create recently-active worlds as live rooms on start (`0` disables) |
| `RESTORE_WINDOW_MIN` | `30` | how recent a saved world must be to be restored |
| `STAT_SAMPLE_MIN` | `60` | minutes between time-series stat samples (`0` disables) |
| `STAT_KEEP` | `168` | newest points kept per account-metric |
| `DIRECTORY` | `local` | room router: `local` (single instance) or `file` (shared, multi-instance) |
| `INSTANCE_ID` | `<host>-<pid>` | this instance's id in the directory |
| `REGION` | `local` | region label for routing/listing |
| `PUBLIC_URL` | — | this instance's reachable `ws(s)://` URL (published in the directory) |
| `DIRECTORY_DIR` | `<SAVE_DIR>/directory` | route files when `DIRECTORY=file` |
| `CONNECT_TTL_MIN` | `2` | connect-token lifetime (control-plane → instance handoff) |
| `SNAPSHOT_STORE` | `inline` | where snapshot blobs live: `inline` or `fs` (shared/mounted dir) |
| `SNAPSHOT_DIR` | `<SAVE_DIR>/snapshots` | snapshot blobs when `SNAPSHOT_STORE=fs` |
| `MAX_ROOMS` | `32` | rooms per process |
| `MAX_PLAYERS_PER_ROOM` | `16` | seats per room |
| `MAX_MSG_BYTES` | `524288` | inbound frame cap (flood guard) |
| `CMD_RATE_LIMIT` | `100` | commands/sec/client |
| `CHAT_RATE_LIMIT` | `6` | chat messages/5s/client |
| `EMPTY_ROOM_TTL_MS` | `600000` | idle-room grace before save+close |
| `HASH_INTERVAL` | `100` | ticks between divergence audits |
| `ALLOW_ORIGIN` | `*` | CORS for `/health` |
| `AUTH_SECRET` | *(ephemeral)* | **set in prod** — HMAC key signing session tokens |
| `TOKEN_TTL_DAYS` | `30` | session token lifetime |
| `RECONNECT_TTL_MIN` | `60` | reconnect-token lifetime (rejoin a live game) |
| `LOGIN_MAX_ATTEMPTS` | `8` | login attempts / 15 min / username |
| `RESET_TTL_MIN` | `45` | password-reset / email-verification code lifetime |
| `MAIL_PROVIDER` | `log` | `resend` (HTTP API) · `capture` (tests) · `log` (no send) |
| `MAIL_API_KEY` | — | required for `MAIL_PROVIDER=resend` |
| `MAIL_FROM` | *(resend.dev)* | `From:` address for recovery email |
| `APP_URL` | — | base URL for clickable reset/verify links in email |
| `MAINTENANCE` | `0` | `1` rejects new games; clients show a banner |
| `ERROR_WEBHOOK` | — | optional JSON error POST endpoint (Sentry or custom) |
| `METRICS_TOKEN` | — | optional bearer token gating `GET /metrics` (open if unset) |
| `DIVERGENCE_ALERT_PER_MIN` | `0` | alert when hash divergences/min cross this (`0` disables) |
| `GIT_SHA` | `dev` | reported by `/health` as `version` |

> **`AUTH_SECRET` must be a stable secret in production.** Without it the
> server generates an ephemeral key at boot and logs a warning — sessions then
> break on every restart. Generate one with
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
> and set it as a Fly/Railway secret.

## Security posture

- **Authority:** clients send commands, never state. Every command is validated
  server-side (funds, tech, occupancy, terrain, role, rate limit) and the issuer
  identity is stamped server-side. `ai` is server-only; weather/day-length are
  admin-gated. See [MULTIPLAYER.md](MULTIPLAYER.md).
- **Anti-cheat:** periodic state-hash audits detect any client that diverges
  (tampered sim) and force a resync; a hacked client can only corrupt its own
  view, briefly. Chat is sanitized (control chars stripped, length-capped,
  rate-limited) and rendered via `textContent` (no injection).
- **Transport:** flood guard (frame-size + buffer caps), heartbeat ping/timeout,
  malformed-JSON disconnect, path-traversal-guarded static serving.
- **HTTP headers** (server and Cloudflare edge): CSP (`script-src 'self'`, no
  inline scripts — the client has none), HSTS, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` (geolocation/camera/mic/… disabled),
  `Cross-Origin-Opener-Policy: same-origin`.
- **Secrets:** never in the repo. `.env` is gitignored; `.env.example`
  documents keys. Deploy secrets (`FLY_API_TOKEN`, Cloudflare tokens,
  `DATABASE_URL`) live in the platform's secret store / GitHub Actions secrets.
- **Process:** runs as a non-root user in the container; graceful `SIGTERM`
  saves all rooms before exit.

## Observability

- `GET /health` → `{ ok, uptime, proto, version, rooms, connections, metrics }`.
  Wired as the Docker `HEALTHCHECK` and the Fly `[[http_service.checks]]`; the
  `metrics` block mirrors the counters below for a quick eyeball.
- `GET /metrics` → **Prometheus** text exposition (`server/metrics.js`). Series
  (all prefixed `gearworks_`): `rooms`, `connections`, `ticks_total`,
  `ticks_per_second`, `commands_total`, `messages_total`, `connections_total`,
  `divergences_total`, `resyncs_total`, `errors_total`, `rtt_ms_p50`,
  `rtt_ms_p95`, `uptime_seconds`. RTT is the client-measured round trip echoed
  on its ping. Scrape it from Prometheus/Grafana Agent/Fly metrics and alert on
  `ticks_per_second` dropping, `rtt_ms_p95` climbing, or `divergences_total`
  rising. Set `METRICS_TOKEN` to require `Authorization: Bearer <token>`.
- Structured JSON logs in production (one line per event) — ship to the
  platform's log drain (Fly/Railway both aggregate stdout).
- Divergence events log at `warn` with the room and tick — a spike is a
  cheating or determinism signal. Set `DIVERGENCE_ALERT_PER_MIN` and a burst
  beyond it warns and fires `ERROR_WEBHOOK` (`divergence_spike`) once per minute.
- **Error tracking:** set `ERROR_WEBHOOK` to a URL and uncaught
  errors/rejections are POSTed as JSON (`server/monitoring.js`) — no SDK, no
  dependency. Point it at a Sentry ingestion endpoint or your own collector.
  For a full Sentry SDK integration instead, add `@sentry/node` and initialise
  it in `server/server.js`; keep it out of the default install to preserve the
  zero-dependency runtime.
- **Analytics (frontend):** to add privacy-friendly analytics (e.g. Plausible),
  drop its script tag into `index.html` and extend the CSP `script-src`/
  `connect-src` in `public/_headers` and `network/httpServer.js` to allow the
  analytics host. Left out by default to keep the strict CSP and zero external
  requests.

## Scaling

**Vertical (now):** one process handles many rooms; cost scales with *active
entities*, not connections. A `shared-cpu-1x` / 512 MB Fly machine handles a
healthy population; bump `[[vm]]` memory/CPU and `MAX_ROOMS` as needed.

**Horizontal (next):** because a room is a self-contained authoritative unit,
scaling out is a **room-router**: hash the invite code → a server instance, with
a shared directory (Postgres `World` table or Redis) mapping code → host. New
players are routed to the room's owner. No sim change required. This is P3 in
the [architecture review](ARCHITECTURE_REVIEW.md).

**Auto-suspend:** `fly.toml` suspends the machine when idle and wakes it on
connect, so a low-traffic game costs near zero.

## Runbook

- **Deploy backend:** push to `main` (CI) or `fly deploy`. Every room final-saves
  on the old process's `SIGTERM`, and the new process **restores recently-active
  worlds on boot** (`RESTORE_ON_BOOT`, within `RESTORE_WINDOW_MIN`), so an ongoing
  world stays live and joinable across a restart/deploy — owners don't have to
  manually Resume, and public worlds reappear in the browser. Note: seamless
  *auto-reconnect* of the exact seat still needs durable sessions (roadmap P1.2);
  today players rejoin the still-live room by code / the public browser.
- **Resume a world:** `node server/server.js --load /data/<CODE>.json`.
- **Rollback:** redeploy the previous image tag (`fly releases` / Railway
  history). Client rollback: redeploy the previous Pages build.
- **Investigate divergence:** grep logs for `DIVERGENCE`; correlate with a
  client version. Frequent mismatches from one client = tampering.
