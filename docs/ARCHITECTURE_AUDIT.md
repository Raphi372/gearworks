# Gearworks — Architecture Audit

A complete technical audit of Gearworks as it exists today, by the Lead
Architect. It describes how the system actually works (grounded in the code),
what is strong and worth preserving, where the debt and risks are, how it behaves
at 10 / 100 / 10,000 players, what production systems are still missing, and a
prioritized evolution plan.

This audit follows [ENGINEERING_GUIDELINES.md](ENGINEERING_GUIDELINES.md) and
updates the earlier [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md): several
items that review listed as *future* (accounts, world persistence, managed
Postgres, live deployment) are now **shipped**, which moves the roadmap forward.
It recommends nothing be implemented yet — this is understanding, not code.

*Method:* read of `shared/core.js`, the full `server/` tree, `client/*`,
`prisma/schema.prisma`, `scripts/`, infra files, and CI. File/line references are
current as of this branch.

---

## 1. Current Architecture

Gearworks is a **server-authoritative, deterministic-lockstep** multiplayer
factory game with an offline single-player mode. Three code layers plus a
persistence boundary, exactly as the guidelines mandate.

### 1.1 The layered model

```
  Browser (Cloudflare Pages, static)                Your machine (Node, PM2)
  ┌───────────────────────────────┐   wss://   ┌──────────────────────────────┐
  │ index.html · client/*.js       │ ─────────▶ │ server/*  (authoritative)     │
  │  Renderer·Input·UI·Lobby·Chat  │            │  lobby → registry → room(s)   │
  │  LocalSession | NetSession      │ ◀───────── │  20 Hz deterministic sim      │
  └───────────────┬───────────────┘   ticks    └───────────────┬──────────────┘
                  │ both run                                    │ store interface
                  ▼                                             ▼
          shared/core.js  ◀─── same deterministic core ───▶  database/ (file | postgres)
                                                                  │
                                                            Neon PostgreSQL
```

### 1.2 Shared core — `shared/core.js` (1,070 lines)

The deterministic simulation, run **identically** in the browser (single-player
and client-side prediction) and in Node (the authority). Exposes a minimal
surface `{ PROTO, Util, Config, createGame }`; `PROTO = 1`, `SIM_HZ = 20`. It is
environment-agnostic (no DOM, no `fs`, no wall-clock, no unseeded randomness) and
carries its RNG seed inside the snapshot, so a seed + ordered command stream
reproduces byte-identical state and hash on every platform. `createGame` returns
`Commands` (validate/apply/PERMS), `Sim.tick`, `Snapshot.capture/restore`, and
`stateHash`.

### 1.3 Server — `server/` (authoritative)

A **composition-root** design (`server/server.js`) wires factory-built modules
with dependency injection; no import cycles:

| Module | Responsibility |
|---|---|
| `config.js` | env/`.env`/flag config, limits, structured JSON logging, `AUTH_SECRET` |
| `network/websocket.js` | zero-dependency RFC 6455 transport |
| `network/httpServer.js` | `/health`, static files, WS upgrade, security headers/CSP |
| `players/lobby.js` | pre-room scope: auth, browse, create/join/resume/rejoin |
| `players/accounts.js` | scrypt password hashing + HMAC session tokens |
| `players/sessions.js` | in-memory reconnect-token map |
| `world/registry.js` | live rooms, invite-code generation, public listing |
| `simulation/room.js` | one authoritative deterministic game |
| `database/*` | pluggable store (file default \| postgres) |
| `monitoring.js` | optional error webhook |

**The room is the unit of authority** (`simulation/room.js`). Each room runs a
drift-corrected fixed 20 Hz loop (`pump()` → `tickOnce()`): NPC decisions
(server-only) are enqueued once per sim-second; queued client **commands** are
validated against live state *in order* and applied immediately so later commands
in the same tick see updated state; the sim advances; the tick is broadcast
(`tk` with commands, or a `tks` heartbeat every 5 empty ticks — the dominant
bandwidth win); every `HASH_INTERVAL` ticks an authoritative `hash` is broadcast
for client self-audit; autosave and idle-eviction run on timers. Clients that
report a diverging hash are snapshot-resynced individually. Identity is stamped
server-side (`_p: c.id`); nothing a client sends is trusted as state.

### 1.4 Client — `index.html` + `client/*` (1,766-line `game.js`)

Presentation and prediction only. `game.js` is a single file of ten IIFE modules
(`Camera, Particles, Renderer, BPLib, Save, UI, Input, Game, Chat, Lobby`).
`net.js` provides two interchangeable session drivers over one interface
(`submit/pump/players/role/status`): **`LocalSession`** (single-player: the
client is its own authority, same validate→apply→tick as the server) and
**`NetSession`** (multiplayer: sim advances only on server ticks; prediction
ghosts, gzip snapshot join/resync, hash self-audit, RTT, lossy cursor channel,
exponential-backoff reconnect). Rendering (60 fps) is decoupled from the 20 Hz
tick. `client/config.js` carries the build-injected default server address.
Strict CSP (`script-src 'self'`, no inline JS).

### 1.5 Persistence — `database/` + `prisma/`

One backend-agnostic store interface (`ready, saveRoom, loadRoom, loadFile,
listRoomCodes, flush, close` + account methods). Two implementations: the
zero-dependency **file** backend (default; `SAVE_DIR/<code>.json` with rotating
backups) and the **Postgres** backend (Prisma, optional dependency). Writes are
**non-blocking**: the file backend is sync-safe; Postgres coalesces per-room
writes into a queue drained off the sim loop (`saveRoom` returns immediately). A
world's authoritative record is `World.snapshot` — the exact `shared/core.js`
snapshot blob.

### 1.6 Infrastructure & deployment

Two supported topologies: the managed path (Docker + `fly.toml` + Cloudflare
Pages) and the **live $0 self-host** path now in use — server under PM2 behind a
Cloudflare Tunnel, client on Cloudflare Pages, data in Neon Postgres (see
[FREE_DEPLOYMENT_GUIDE.md](FREE_DEPLOYMENT_GUIDE.md)). CI: `validate.yml` runs
`scripts/validate.js` + `scripts/test.js`; secret-gated workflows deploy
frontend/backend and run `prisma migrate deploy`.

---

## 2. Strengths (preserve these)

1. **The right multiplayer model.** Server-authoritative deterministic lockstep
   is the correct architecture for a sim with tens of thousands of moving items;
   commands *are* the delta compression, so an idle megabase costs ~4 msgs/s
   regardless of size. This is a load-bearing, well-executed decision — do not
   rewrite it (guidelines §1.3).
2. **Determinism is real and guarded.** Seeded RNG, deterministic trig, tick-time,
   ordered command application, and periodic hash audits with auto-resync. Proven
   by `scripts/test.js` (identical hash after 500 ticks; snapshot round-trip
   stays in lockstep for 300+ more).
3. **Genuine authority + anti-cheat by construction.** Every command is validated
   against live state (funds/tech/occupancy/terrain/role/rate) before entering the
   tick stream; issuer identity is stamped server-side; server-only commands
   (`ai`) and admin-gated ones (weather) are enforced (`room.js` `onMessage`). A
   hacked client can only corrupt its own view until the next hash resync.
4. **Clean modular server with DI and no cycles.** The composition root +
   injected dependencies (room never imports the registry back) is textbook and
   makes the system testable and evolvable.
5. **Pluggable, non-blocking persistence.** One interface, two backends; the
   20 Hz loop never awaits I/O. Snapshots are self-contained and portable.
6. **Near-zero-dependency runtime.** Vanilla client (no build step), Node
   standard-library server, Prisma optional. Small attack surface, trivial deploy,
   no supply-chain churn.
7. **Real production hygiene already in place.** Graceful `SIGTERM` (saves all
   rooms), `/health`, structured JSON logs, strict CSP/HSTS, protocol versioning
   (`PROTO`), reconnect tokens, host migration, secure auth (scrypt + constant-
   time verify + HMAC sessions + login rate limiting).
8. **It is actually live at $0.** Accounts, account-owned persistent worlds, and a
   worldwide-reachable deployment exist today — not a demo.

---

## 3. Technical Debt

Ordered by long-term impact. None are emergencies; all are worth tracking.

1. **Single process / single machine is a SPOF.** All room state is in memory in
   one Node process. A crash or deploy ends every *live* session; autosave
   prevents data loss but not continuity, and the managed path does **not**
   auto-reload live rooms on boot (only `--load` for one file). Acceptable now;
   the first real availability constraint.
2. **Sessions are an in-memory singleton** (`players/sessions.js`). Reconnect
   tokens vanish on restart and cannot work across processes. This is the concrete
   blocker for both zero-downtime deploys and horizontal scale (guidelines §9 P-6).
3. **Schema ↔ code drift: the metagame is unbuilt.** `prisma/schema.prisma`
   defines `WorldMember`, `Factory`, `Progression`, and `Stat` (+ `Role` enum,
   `Account.email`), but **no code writes or reads them** — only `Account` and
   `World` are used (`postgresStore.js`, `lobby.js`). The projections the schema
   promises (leaderboards, cross-world progression, persistent membership) do not
   exist yet. This violates the spirit of guidelines [DB-6] (projections must be
   *derived*, not aspirational) and is a trap for the next engineer.
4. **No account recovery.** `Account.email` exists but there is no verification or
   password-reset flow. A forgotten password today = permanent lockout. Real users
   *will* hit this.
5. **Client monolith.** ~~`client/game.js` is 1,766 lines mixing render, input, UI,
   save, lobby, and chat.~~ **Resolved (P1.3):** split into ordered same-origin
   scripts (`app`/`render`/`ui`/`input`/`game`/`chat`/`lobby`/`boot`) that share
   global scope — no build step, CSP intact, byte-identical behavior.
6. **Test coverage is core-only.** `scripts/test.js` (5 tests) covers determinism,
   snapshot round-trip, command authority, file persistence, and chat sanitize —
   excellent for the sim, but **there is no automated test in CI for networking/WS,
   the lobby/auth flow, the Postgres backend, or reconnect**. The Playwright UI
   suites referenced in comments live outside the repo. Refactors can silently
   break multiplayer/auth without a red build (guidelines [Q-5] under-served).
7. **No global observability or moderation.** `/health` + optional error webhook
   only — no metrics (rooms, ticks, RTT, divergence rate over time), no alerting,
   no global admin/ban/report tooling (roles are in-room only).
8. **Minor:** unbounded `World` row growth (no retention/cleanup); an anonymous
   (ownerId-null) saved world can be resumed by anyone; a brand-new room could
   theoretically draw an invite code that collides with a persisted-but-not-live
   world; dual deployment stories (`fly.toml` + self-host) can confuse. Low
   severity, worth noting.

---

## 4. Scalability Analysis

Cost scales with **active simulated entities**, not raw connections — the key
property of the model. All numbers assume the current single Node process.

### 10 players
**Effortless.** One or a few rooms, each a cheap 20 Hz sim, well within one core.
In-memory sessions, single process, and per-room snapshot saves are ideal at this
size. No concerns. This is the design's sweet spot.

### 100 players
**Comfortable on one modest box.** Spread across up to `MAX_ROOMS` (default 32,
16 seats each = 512 seats). CPU tracks total *active entities* across rooms, not
players; belt/fluid/power sim for a few dozen active factories fits one core.
Bandwidth stays low (commands + heartbeats). Emerging concerns, not blockers:
the single process is now a meaningful SPOF (100 people dropped by one crash/
deploy), and `MAX_ROOMS`/CPU headroom should be watched. Vertical scaling (bigger
box, higher `MAX_ROOMS`) is the answer here.

### 10,000 players
**Exceeds a single process — needs horizontal scale that is designed-for but not
built.** One single-threaded Node process cannot run thousands of concurrent
20 Hz sims with large active factories; it saturates one core, and all state in
one heap is both a memory ceiling and a blast radius. The architecture *permits*
scale-out because a room is a self-contained authoritative unit, but four things
must exist first:
- **Room router / directory** — map invite code → owning instance (consistent
  hashing + a shared directory in Postgres/Redis). Today `registry` is per-process
  and in-memory.
- **Shared/durable sessions** — reconnect must find the right instance; the
  in-memory singleton must move to the shared store (debt #2).
- **Aggregated public listing** — `publicRooms()` is per-process; a global browser
  needs cross-instance aggregation.
- **Placement + capacity** — decide which instance hosts a new room; drain/rebalance.

None require touching the simulation or protocol (guidelines §9 P-6), but it is a
real project. **Verdict:** 10 and 100 are handled today (100 with vertical
scaling); 10,000 is *reachable without a rewrite* but requires the room-router
milestone.

---

## 5. Missing Systems (production)

| System | Status | Notes |
|---|---|---|
| Accounts / auth | ✅ **Done** | register/login/guest, scrypt + HMAC, login rate limiting |
| World persistence | ✅ **Done** | account-owned worlds, file + Postgres, resume with owner check |
| Managed DB + live deploy | ✅ **Done** | Neon + Cloudflare Pages + Tunnel, at $0 |
| **Account recovery** | ❌ Missing | no email verify / password reset (lockout risk) |
| **Progression / stats / leaderboards** | ❌ Missing | `Progression`/`Stat`/`Factory` modelled, never written |
| **Persistent membership & roles** | ❌ Missing | `WorldMember` modelled, never written (roles are session-only) |
| **Social** (friends, presence, invites, in-app server list) | ❌ Missing | only invite codes + a public browser |
| **Matchmaking / quickplay** | ❌ Missing | no "find me a game" |
| **Horizontal scaling** (room-router) | ❌ Missing | single process; designed-for, not built |
| **Observability** (metrics, dashboards, alerting) | ⚠️ Partial | `/health` + optional error webhook only |
| **Global moderation / admin** | ❌ Missing | in-room host/admin only; no ban/report |
| **Integration/E2E tests in CI** | ⚠️ Partial | core unit tests only; no net/auth/DB/reconnect tests |

---

## 6. Recommended Evolution Plan

Prioritized. Each item names the guideline rules it serves. **P0 = do before new
features; P1 = important; P2 = later.**

### P0 — critical (foundation before features)

- **P0.1 Integration test harness in CI.** Add in-process/headless tests for the
  WebSocket handshake, lobby auth (register/login/guest/token), a two-client
  command round-trip, reconnect, and the Postgres backend (against a disposable
  DB). Rationale: every future change touches these invariants and there is no red
  build to catch a regression today ([Q-5], [F-4]). Highest leverage — it protects
  everything else.
- **P0.2 Account recovery.** Email capture + verification + password reset (the
  `email` column already exists). Without it, growth produces locked-out users.
  Keep it within the zero-dependency posture where possible (signed reset tokens
  via the existing HMAC pattern) ([SEC-5]).
- **P0.3 Deploy/restart continuity.** On boot, optionally reload recently-active
  worlds from the store so a deploy/crash doesn't end live games; announce
  maintenance and drain on `SIGTERM`. Reduces the SPOF's blast radius without
  horizontal scale ([P-3], debt #1).

### P1 — important

- **P1.1 Build the metagame projections.** Wire `WorldMember`, `Factory`,
  `Progression`, `Stat` to real code paths (write on save/join, read for
  leaderboards and cross-world progression), keeping `World.snapshot` the single
  source of truth ([DB-6]). Resolves schema↔code drift (debt #3); unlocks
  leaderboards and persistent roles.
- **P1.2 Durable/shared sessions.** Move the reconnect-token store behind an
  interface with a shared backend (Postgres/Redis). Immediate win: reconnect
  survives restarts; also the prerequisite for scale ([P-6], debt #2).
- **P1.3 Client modularization.** ✅ **Done.** `client/game.js` split into
  ordered same-origin scripts (`app` / `render` / `ui` / `input` / `game` /
  `chat` / `lobby` / `boot`) sharing global scope — no build step, CSP intact
  ([A-2], debt #5).
- **P1.4 Observability.** Emit counters (rooms, players, ticks/s, RTT p50/p95,
  divergence rate) and wire alerting; a divergence spike is a cheating/determinism
  signal ([Q-4]).

### P2 — later (scale & depth)

- **P2.1 Horizontal scale (room-router).** Consistent-hash room code → instance,
  shared directory, aggregated listing, placement/drain. Only needed approaching
  ~10k concurrent ([P-6]). Additive; no sim/protocol change.
- **P2.2 Social & matchmaking.** Friends, presence, invites, a DB-backed server
  list, and quickplay/matchmaking on top of the directory.
- **P2.3 Anti-cheat depth.** Server-side anomaly scoring (impossible input
  cadence, divergence frequency), optional replay capture for disputes ([SEC-3]).
- **P2.4 Global moderation tooling.** Bans, reports, account/world admin.
- **P2.5 Housekeeping.** World-retention policy, resolve the invite-code/persisted
  collision edge, consolidate the deployment story.

---

## 7. Risk Assessment — what could accidentally break

The invariants below are load-bearing. A change touching them without the stated
guard is high-risk. (Cross-referenced to [ENGINEERING_GUIDELINES.md](ENGINEERING_GUIDELINES.md).)

### Could break multiplayer / determinism ([M-5]–[M-7])
- **Any edit to `shared/core.js`** that changes math, **iteration order** (Maps/
  objects), or introduces `Math.random()` / `Date.now()` / `performance.now()` /
  platform-variant floats **inside the sim**. Symptom: clients diverge, constant
  resyncs.
- **Changing command validation or apply order** in `room.js`/`core.js` so server
  and predicting client disagree, or breaking **SP/MP parity** ([M-13]) by editing
  one path only.
- *Guard:* determinism + command-authority tests stay green; extend them with the
  change; never merge on a hash divergence.

### Could break saves ([M-10])
- **Changing the snapshot format** (`Snapshot.capture/restore`) or the save `meta`
  shape without a load-time migration — silently corrupts or orphans existing
  worlds (file `.json` and `World.snapshot` rows).
- *Guard:* snapshot round-trip test; version + migrate on load; never a
  destructive, un-migrated change.

### Could break compatibility ([M-8], [M-9])
- **Protocol changes** (message shapes/semantics) without bumping `PROTO` and
  handling the mismatch — old connected clients and the CDN-cached client will
  break. Note the **client is cached at the edge**, so version skew between a newly
  deployed server and an old cached client is a *routine* condition, not an edge
  case.
- *Guard:* prefer additive protocol changes; bump `PROTO` + graceful "refresh"
  path for breaking ones; keep the handshake's `proto` check.

### Could break persistence / data ([DB-3], [DB-8])
- Adding an `await` into the tick path (stalls the 20 Hz loop); implementing a
  store change for only one backend (file vs postgres divergence); a schema change
  without a committed, forward-only migration ([DB-4], [DB-5]).
- *Guard:* both backends implemented; migrations reviewed; persistence stays off
  the sim loop.

### Could break security ([SEC-1], [SEC-2])
- Trusting any client-supplied field as fact (issuer, role, funds); loosening the
  CSP; weakening scrypt/HMAC or logging a token; removing the hash-audit path.
- *Guard:* server validates every input; identity stamped server-side; secrets
  never logged; audit path preserved.

---

## Summary

Gearworks rests on a genuinely strong foundation: the correct authoritative-
lockstep model, real determinism and anti-cheat, a clean modular server, pluggable
non-blocking persistence, a near-zero-dependency runtime, and a live $0
deployment with accounts and persistent worlds. Its debt is normal for its
stage and concentrated in four places — **single-process resilience**, **in-memory
sessions**, **an unbuilt metagame the schema already promises**, and **integration-
test coverage**. It comfortably serves 10–100 players today; reaching 10,000 is a
well-defined room-router project that the architecture was deliberately shaped to
allow without a rewrite. The recommended next milestone (P0) hardens the
foundation — tests, account recovery, restart continuity — *before* new features,
exactly as the engineering guidelines require.
