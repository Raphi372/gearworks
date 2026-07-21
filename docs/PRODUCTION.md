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
| `LOGIN_MAX_ATTEMPTS` | `8` | login attempts / 15 min / username |
| `RESET_TTL_MIN` | `45` | password-reset / email-verification code lifetime |
| `MAIL_PROVIDER` | `log` | `resend` (HTTP API) · `capture` (tests) · `log` (no send) |
| `MAIL_API_KEY` | — | required for `MAIL_PROVIDER=resend` |
| `MAIL_FROM` | *(resend.dev)* | `From:` address for recovery email |
| `APP_URL` | — | base URL for clickable reset/verify links in email |
| `MAINTENANCE` | `0` | `1` rejects new games; clients show a banner |
| `ERROR_WEBHOOK` | — | optional JSON error POST endpoint (Sentry or custom) |
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

- `GET /health` → `{ ok, uptime, proto, version, rooms, sessions }`. Wired as
  the Docker `HEALTHCHECK` and the Fly `[[http_service.checks]]`.
- Structured JSON logs in production (one line per event) — ship to the
  platform's log drain (Fly/Railway both aggregate stdout).
- Divergence events log at `warn` with the room and tick — a spike is a
  cheating or determinism signal worth alerting on.
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

- **Deploy backend:** push to `main` (CI) or `fly deploy`. Rooms save on the old
  machine's `SIGTERM` and reload on the new one only if `--load` / Postgres is
  used; otherwise in-flight rooms end (announce maintenance, or drain first).
- **Resume a world:** `node server/server.js --load /data/<CODE>.json`.
- **Rollback:** redeploy the previous image tag (`fly releases` / Railway
  history). Client rollback: redeploy the previous Pages build.
- **Investigate divergence:** grep logs for `DIVERGENCE`; correlate with a
  client version. Frequent mismatches from one client = tampering.
