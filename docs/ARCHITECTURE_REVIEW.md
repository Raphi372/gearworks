# Gearworks — Architecture Review

A senior-engineer audit of the repository, the reasoning behind the production
refactor in this change, and a prioritized roadmap. Written to be honest about
what was **already** sound (and deliberately left alone) versus what needed
building.

---

## 1. Current state (as audited)

Gearworks is a Factorio-style factory game. Its multiplayer was **already**
server-authoritative deterministic lockstep — the correct model for a sim with
tens of thousands of moving belt items, and the same model Factorio itself
uses. The audit found a genuinely solid foundation, not a demo:

| Concern | Finding |
|---|---|
| **Simulation ownership** | ✅ Authoritative on the server. The deterministic core (`shared/core.js`) runs identically on client and server; clients only ever send **commands**, never state. |
| **Client trust** | ✅ Every command is validated server-side against real state (funds, tech gates, occupancy, terrain, role, rate limit) before entering the tick stream. Identity is stamped server-side. NPC decisions are server-only. |
| **Determinism** | ✅ Seeded RNG (snapshot-carried), deterministic trig, tick-derived time, ordered-command Map population. 100-tick state-hash audits with automatic snapshot resync on divergence. |
| **Prediction / reconciliation** | ✅ Client renders predicted "ghosts"; the server echo/reject reconciles them. Rendering (60 fps) is decoupled from the 20 Hz tick. |
| **Bandwidth** | ✅ Commands *are* the delta compression; idle factories cost ~4 heartbeats/s regardless of size. Snapshots gzip'd. Lossy cursor channel with interest management. |
| **Reconnect** | ✅ Session tokens; exponential-backoff auto-reconnect; host migration. |
| **Networking transport** | ✅ Zero-dependency inline RFC 6455 WebSocket. |

**Conclusion:** Phase 2's "make the server authoritative" was *already true*.
The right engineering call was **not to rewrite** the working sim/net layers,
but to (a) make them maintainable and deployable at scale, and (b) add the
production concerns that were genuinely missing.

## 2. Technical debt & gaps found

1. **Monolith server file** — `server.js` was one ~600-line file mixing
   transport, rooms, sessions, persistence, HTTP, and boot. Works, but hard to
   evolve and test in isolation. → **Fixed:** split into `network/`,
   `simulation/`, `players/`, `world/`, `database/`.
2. **No persistence abstraction** — saves were inline `fs` calls. Fine for a
   single box, but blocks a managed database and horizontal scale. → **Fixed:**
   `database/` store interface with a zero-dependency file backend (default)
   and a prepared Postgres/Prisma backend.
3. **No configuration surface** — constants were literals; only two CLI flags.
   → **Fixed:** `config.js` reads env vars (12-factor) with flag overrides and
   structured JSON logging in production.
4. **No production infrastructure** — no Dockerfile, no health-gated deploy, no
   security headers, no graceful `SIGTERM`. → **Fixed:** Dockerfile (non-root,
   healthcheck), `fly.toml`, Cloudflare Pages `_headers`/`_redirects`/404, CSP
   + HSTS + friends, `SIGTERM`/`SIGINT` graceful shutdown.
5. **No CI beyond a Pages deploy** — → **Fixed:** validate/test workflow +
   secret-gated backend (Fly) and frontend (Cloudflare) deploy pipelines.
6. **Lobby first-run wart** — the client auto-connects its room browser to the
   *page origin*, which on a static host is never a game server (scary
   "Connection failed"). → **Documented** in the roadmap; low-risk client fix
   deferred to keep this change server/infra-focused.
7. **No accounts / cross-session progression** — state is per-room only. →
   **Prepared:** Prisma schema for accounts, worlds, membership, progression,
   stats (not yet wired into gameplay — see roadmap).

## 3. Recommended architecture (implemented here)

```
                         Cloudflare  (DNS · CDN · HTTPS · edge headers)
                                     │
                 ┌───────────────────┴────────────────────┐
                 ▼                                         ▼
        Cloudflare Pages                          Fly.io / Railway
       (static client, dist/)   ── wss:// ──▶   authoritative game server
                                                 (Docker, this repo)
                                                         │
                                                  Postgres (optional)
                                                  Neon / Supabase
```

- **Client** is a dependency-free static bundle (no framework, no build tooling
  beyond a deterministic copy). Served from the CDN edge; connects over
  `wss://` to a game server the player selects.
- **Server** is one stateless-per-process authoritative host. All room state is
  in memory (that's what makes 20 Hz lockstep cheap); durability comes from
  snapshot persistence to the store.
- **Persistence** is pluggable: file backend for self-hosting/dev, Postgres for
  managed production + the future account metagame.
- **Shared** deterministic core is the contract both sides honor.

## 4. Module layout (server)

```
server/
├── server.js              entry: wiring, boot, graceful shutdown
├── config.js              env/flag config + structured logging
├── network/
│   ├── websocket.js       RFC 6455 transport (zero-dep)
│   └── httpServer.js      /health, static files, WS upgrade, security headers
├── players/
│   ├── sessions.js        reconnect session tokens
│   └── lobby.js           create / join / rejoin handshake
├── simulation/
│   └── room.js            one authoritative deterministic game
├── world/
│   └── registry.js        live rooms + invite codes + browser listing
└── database/
    ├── index.js           store abstraction (dispatch)
    ├── fileStore.js       default zero-dependency backend
    └── postgresStore.js   optional Prisma backend
```

Dependencies flow one way (no cycles): `server → {registry → room, lobby} →
{database, sessions, network}`. Room receives its dependencies by injection, so
it never imports the registry back.

## 5. Prioritized roadmap

**P0 — ship the foundation (this change).** Modular server, persistence
abstraction, Docker/Fly/Cloudflare infra, CI/CD, security headers, docs. Done.

**P1 — connect the managed backend.** Provision Neon Postgres + Fly app, set
secrets, flip `STORAGE=postgres`. The code path exists; it needs accounts.

**P2 — accounts & progression.** Wire the Prisma models into the lobby
(guest + email accounts), persist worlds to `World`, project leaderboards from
`Factory`/`Stat`. Schema is ready.

**P3 — horizontal scale.** Today one process holds all rooms (fine to
thousands of *players* across many rooms on one box, since cost is per active
entity, not per connection). To scale beyond one machine, add a room-router
(consistent-hash room code → server instance) with a shared Postgres/Redis
directory. The room is already a self-contained unit, so this is additive.

**P4 — client polish.** Fix the lobby auto-browse wart; add matchmaking,
friends, and a server list backed by the DB.

**P5 — anti-cheat depth.** The command-validation + hash-audit foundation is
strong. Add server-side anomaly scoring (impossible input cadence, hash-mismatch
frequency) and optional replay capture for disputes.

## 6. What was deliberately NOT changed

Per "don't rewrite working systems": the deterministic core, the command
protocol, the prediction/reconciliation model, the belt/fluid/power simulation,
and the client rendering were left byte-for-byte intact. The full multiplayer
(24 checks), chat (13 checks), and singleplayer parity suites pass unchanged
against the refactored server, proving behavior was preserved.
