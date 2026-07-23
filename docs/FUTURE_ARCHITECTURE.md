# Gearworks — Future Architecture

**A blueprint for the target system: Gearworks as a professional, regional,
horizontally-scalable multiplayer game platform.**

This is a **design document, not an implementation**. It describes the system we
are building *toward*, the modules and data it needs, the networking and scaling
model, and a staged, additive migration path from today's single process. It is
bound by [ENGINEERING_GUIDELINES.md](ENGINEERING_GUIDELINES.md) (the constitution)
and continues the roadmap in [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md): P0
and P1 are shipped (integration tests, account recovery, restart continuity,
durable/versioned sessions, the metagame projections, client modularization,
observability); this document designs **P2 and beyond** — scale, regions, and the
social/cosmetic depth of a real platform.

Everything here is designed to be **additive and toggleable**. The single-process,
$0, file-backend deployment that runs today MUST keep working with every new
subsystem disabled by default. We grow the platform without foreclosing the small
deployment — [A-6], [A-7], [§1.2].

---

## 0. First principles (what does NOT change)

These are load-bearing and stay exactly as they are. The target architecture is an
expansion *around* them, never a rewrite *of* them ([§1.3], audit §2).

- **Server-authoritative deterministic lockstep.** Clients send commands; the
  server validates and advances the sim; ticks + periodic snapshots + hash audits
  synchronize. Commands *are* the delta compression ([M-1], [M-11]).
- **The room is the unit of authority.** One room = one self-contained
  authoritative 20 Hz sim. This is *the* property that makes horizontal scale a
  routing problem, not a rewrite ([P-6]).
- **The deterministic core is sacred.** `shared/core.js` stays environment-agnostic
  and byte-deterministic; SP/MP parity holds ([S-1], [S-2], [M-13]).
- **Zero-dependency-by-default runtime.** Vanilla no-build client; Node-stdlib
  server; every new heavy dependency (Redis, object storage SDK) is *optional* and
  behind an interface, with a working degraded path ([A-7], [SEC-8]).
- **Stateless HMAC auth & sessions.** No server-side session table is *required*;
  tokens are signed with a stable `AUTH_SECRET` ([SEC-5], [P-6]). This is the key
  that makes any instance able to seat any player without shared session memory.
- **Two backends, one interface; projections are derived.** All persistence goes
  through the store interface; `World.snapshot` is the single source of truth and
  every table (`Factory`, `Progression`, `Stat`, …) is a *derived* projection
  ([DB-3], [DB-6]).

If a proposed feature below appears to require breaking one of these, the *design*
is wrong and must be reworked ([F-1]).

---

## 1. Target system overview

The central architectural move is a **control-plane / data-plane split**.

- **Data plane — game-server instances.** Each instance hosts a *subset* of live
  rooms and runs their authoritative sims. Instances are horizontally scalable and
  regionally deployed. A room is *homed* on exactly one instance at a time. This is
  today's `registry`+`room`, unchanged in behavior, now one of many.
- **Control plane — the director.** A small set of *stateless* services that run
  **no simulation**: authentication + account/profile/social API, the **room
  directory** (code → owning instance), **matchmaking**, **presence**, and the
  aggregated public listing. Backed by the shared database (and an optional
  ephemeral store). The control plane decides *where* a player goes; the data plane
  decides *what happens in the game*. This separation is a direct application of
  [A-1]/[A-2]: new concerns become new modules, they do not accrete onto the room.

```
                              ┌───────────────────────────────────────────┐
                              │            CONTROL PLANE (stateless)        │
   Browser                    │  auth · profile/social API · directory ·    │
  ┌──────────────┐   https/ws │  matchmaking · presence · public listing    │
  │ client/*     │ ──────────▶│      (runs NO simulation)                    │
  │ render·ui·   │            └───────┬───────────────────────┬─────────────┘
  │ net·predict  │                    │ connect-token handoff │ reads/writes
  └──────┬───────┘                    ▼                       ▼
         │  wss:// (game channel, PROTO)          ┌───────────────────────────┐
         │   ┌───────────────────────────────┐    │   SHARED DATA STORES       │
         └──▶│  DATA PLANE: game instance(s)  │    │  Postgres (accounts,       │
             │  registry → room(s) @ 20 Hz    │◀──▶│   worlds meta, projections,│
             │  region: eu / us / ap          │    │   social)                  │
             └───────────────┬───────────────┘    │  Object store (snapshots)  │
                             │ snapshot blobs      │  Redis* (presence, dir     │
                             ▼                     │   cache, queues) — optional│
                     Object store (R2/S3)          └───────────────────────────┘
```

The four capability areas the platform must support map onto this split as follows.

| Area | Requirement | Home |
|---|---|---|
| **Players** | accounts, profiles, friends, invites, cosmetics, progression | Control plane + Postgres |
| **Worlds** | persistent factories, multiplayer ownership, permissions, saving | Data plane (authority) + Postgres/object store (durability) |
| **Online** | matchmaking, lobbies, presence, room management | Control plane (directory/matchmaking/presence) + data plane (rooms) |
| **Scale** | multiple game servers, regional servers, database scaling | Data-plane fleet + control-plane directory + store topology |

---

## 2. Modules

Each module keeps single responsibility ([A-2]) and is wired at a composition root
with injected dependencies ([A-3]). New services get their *own* composition root;
they never reach into the game server's internals.

### 2.1 Client — `index.html`, `client/*`, `shared/core.js`

Presentation and prediction only ([§3.1]). The P1.3 split (`app/render/ui/input/
game/chat/lobby/boot`) is the base; the target adds:

- **rendering** — unchanged: canvas renderer decoupled from the tick, 60 fps over a
  20 Hz sim; cosmetics are render-time skins keyed off an equipped loadout, never
  gameplay-affecting.
- **UI** — grows: profile, friends list + presence, invites, cosmetics locker,
  achievements, leaderboards, a matchmaking/quickplay screen, a regional server
  picker. Still no build step; new panels are new same-origin scripts ([A-2]).
- **networking** — gains a **director client**: talks to the control plane
  (login, matchmaking, social, presence) over HTTPS/WS, receives a **connect token
  + instance URL**, then opens the *game* WS to the owning instance. `net.js`'s two
  session drivers (`LocalSession`/`NetSession`) are unchanged; a thin
  `DirectorSession` sits *in front* of `NetSession` and hands it a resolved URL.
- **prediction** — unchanged. Ghosts, reconciliation, hash self-audit, RTT, lossy
  cursor channel. Determinism and SP/MP parity are untouched ([M-13]).

The client MUST remain untrusted ([C-1]–[C-4]): cosmetics equipped, friends, and
matchmaking preferences are *requests*; the server owns the truth.

### 2.2 Server

Split into **game-server modules** (data plane) and **control-plane services**.

**Data plane (today's `server/`, largely unchanged):**

| Module | Responsibility | Change vs today |
|---|---|---|
| `network/*` | RFC 6455 transport, HTTP, `/health`, `/metrics`, CSP | + verify **connect tokens** on upgrade |
| `simulation/room.js` | one authoritative 20 Hz game | unchanged sim; + emit room lifecycle events to the directory |
| `world/registry.js` | live rooms on *this* instance | + register/deregister rooms in the shared **directory**; + report capacity |
| `players/lobby.js` | pre-room scope on this instance | join/resume gated by a verified connect token; membership/roles unchanged |
| `players/tokens.js` | shared HMAC signer | + `connect` purpose (aid, room, region, role, ttl) |
| `metrics.js` | Prometheus/health counters | + per-instance region/capacity labels |

**Control plane (new services, each its own process/composition root):**

| Service | Responsibility |
|---|---|
| **auth** | register/login/guest/recovery, issues session tokens (reuses `players/accounts.js` + `tokens.js`) |
| **directory** | room code → {instance, region, public, players, capacity}; create/place/evict; aggregated public listing |
| **matchmaking** | quickplay/join-friend/create; region- and capacity-aware placement; queues |
| **presence** | account → {status, region, room, lastSeen}; heartbeats; friend fan-out |
| **social/profile API** | profiles, friends, invites, cosmetics, achievements, leaderboards (read/write over the store) |

Auth, matchmaking, social, and presence are **stateless request handlers over the
shared store** — any instance of them can serve any request, because sessions are
HMAC tokens and all durable state is in Postgres/Redis ([P-6]). The **directory** is
the one piece that must be *consistent* (see §5, §7).

### 2.3 Database — `server/database/*`, `prisma/*`

The store interface stays the single, backend-agnostic contract ([A-4], [DB-3]).
Two structural additions:

- **A third store backend for snapshots: object storage.** `World.snapshot` blobs
  are large and hot on the write path. They move behind the *same* store interface
  to an object-storage backend (Cloudflare R2 / S3-compatible), keyed by world code,
  with Postgres holding only *metadata + projections*. The file and Postgres
  backends still work for small/self-host deployments; object storage is an opt-in
  third implementation ([DB-3], [A-7]). `World.snapshot` remains the authoritative
  record — it just lives in a blob store — so [DB-6] holds.
- **An optional ephemeral store** for presence, directory cache, matchmaking
  queues, rate-limit counters, and a reconnect index. Postgres serves these at
  small/medium scale; Redis is an optional drop-in when latency/throughput demand
  it — behind an interface, with a Postgres fallback so the zero-extra-dependency
  deployment still runs ([A-7]).

The database still **never** contains gameplay logic ([DB-1]) and is never the
source of truth for live state ([DB-2]).

### 2.4 Infrastructure — deployment, monitoring, scaling

- **deployment** — per-region deployments of the data-plane fleet (Fly regions /
  multiple hosts / a container platform) plus a small control-plane deployment.
  Client stays on a CDN (Cloudflare Pages). The self-host $0 path remains: one
  process runs *both* planes in-process with the directory in "single-instance"
  mode (a no-op that returns "this process") — identical to today.
- **monitoring** — the P1.4 `/metrics` + `/health` per instance, scraped into a
  regional/global Prometheus; dashboards for ticks/s, RTT p50/p95, divergence rate,
  rooms/instance, queue depth, presence count; alerting on divergence spikes,
  tick-rate drops, queue backpressure, replica lag. Structured JSON logs shipped to
  a drain ([Q-4]).
- **scaling** — horizontal on the data plane (add instances → directory places new
  rooms on them); read replicas + object storage + optional Redis on the data tier;
  region add = a new deployment + a `Region` row. See §5.

---

## 3. Database design

Below is the **target** relational model (Postgres). Entities already shipped are
marked ✅; new ones ⭑. The rule throughout: **ownership recorded and enforced
server-side** ([DB-7]); **projections derived from the snapshot** ([DB-6]);
**migrations additive and forward-only** ([DB-4], [DB-5]).

### 3.1 Entities

**Identity & profile**
- ✅ **Account** — `id, username(unique), email(unique,nullable), emailVerified,
  displayName, passwordHash(nullable/guest), isGuest, tokenVersion, color,
  createdAt, lastSeenAt`. The login identity and auth anchor.
- ⭑ **Profile** — 1:1 with Account. `accountId(unique), bio, avatarCosmeticId,
  bannerCosmeticId, equippedLoadout(jsonb), country/region, visibility(public|
  friends|private), publicStatsOptIn`. Split from Account so the hot auth row stays
  small and the public-facing profile can be cached/served without touching
  credentials ([SEC-4]).

**Social**
- ⭑ **Friendship** — the social graph. Two-row directed model `(accountId, otherId,
  status[pending|accepted|blocked], createdAt, actedAt)` with `@@unique([accountId,
  otherId])`, or a single canonical low-high row + a `direction` — the directed
  model is simpler for "requests I sent vs received" and blocking. Blocking is
  directional and overrides presence/invites.
- ⭑ **Invite** — `id, kind[friend|world], fromAccountId, toAccountId(nullable),
  worldId(nullable), code(nullable), role(nullable), status[pending|accepted|
  declined|expired], expiresAt`. World invites grant a `Membership` on accept.

**Worlds & membership**
- ✅ **World** — `id, code(unique), name, seed, snapshotRef, isPublic, region,
  ownerId(→Account), savedAt, createdAt`. `snapshotRef` becomes a pointer (object-
  storage key) once snapshots move off-row; small deployments keep the JSONB column.
  Adds `region` (home region) for regional routing.
- ✅ **Membership (WorldMember)** — `accountId, worldId, role[HOST|ADMIN|PLAYER|
  SPECTATOR], joinedAt`, `@@unique([accountId, worldId])`. The permission record for
  multiplayer ownership: who may enter/resume/administer a world ([DB-7]).
- ✅ **Factory** — per-world *projection* (net worth, entities, tech, techIds) for
  leaderboards without deserializing snapshots. One row per world.

**Progression, stats, rewards**
- ✅ **Progression** — per-account cross-world level/xp/unlockedTech (derived).
- ✅ **Statistic (Stat)** — time-series counters `(accountId, key, value, recordedAt)`.
- ⭑ **Cosmetic** — server-defined catalog. `id, kind[skin|avatar|banner|trail|…],
  name, rarity, unlockRule(jsonb: level/achievement/grant), active`. The catalog is
  **server truth**; the client only *equips* what the account owns.
- ⭑ **CosmeticOwnership** — `accountId, cosmeticId, source[progression|achievement|
  grant|event], acquiredAt`, `@@unique([accountId, cosmeticId])`.
- ⭑ **Achievement** — definitions `id, key(unique), name, description, criteria(jsonb),
  rewardCosmeticId(nullable), points`.
- ⭑ **AchievementProgress** — `accountId, achievementId, progress, completedAt(nullable)`,
  `@@unique([accountId, achievementId])`. Derived from Stats/Progression on save.
- ⭑ **Leaderboard / Season** — `Leaderboard(id, key, scope[global|region|friends],
  metric, seasonId)` + `LeaderboardEntry(leaderboardId, accountId|worldId, score,
  rank, updatedAt)`. A *materialized projection* refreshed periodically from
  `Factory`/`Progression`/`Stat`, supporting seasons and friend-scoped boards.

**Platform / control-plane state** (may live in Postgres now, migrate to Redis later)
- ⭑ **Region** — `code(eu|us|ap|…), displayName, endpoint, active`.
- ⭑ **RoomDirectory** — `code(unique), instanceId, region, isPublic, players,
  capacity, updatedAt, heartbeatAt`. The authoritative map for routing; the hot,
  consistency-sensitive table (or a Redis hash with a Postgres backstop).
- ⭑ **Presence** — `accountId(unique), status, region, roomCode(nullable), instanceId,
  lastSeen`. High-churn; ideal Redis candidate with TTL; Postgres-backed at small
  scale.
- ⭑ **ModerationAction / Report / Ban** — `Ban(accountId|ip, reason, byAccountId,
  expiresAt)`, `Report(fromAccountId, targetAccountId|worldId, reason, status)`.
  Modeled early so ownership/authz aren't retrofitted; tooling comes later ([§5,
  P2.4]).

### 3.2 Relationships & ownership

```
Account 1──1 Profile
Account 1──* World            (ownerId; owner is the world's root authority)
Account *──* World  via Membership (role per (account, world))
World   1──1 Factory          (projection)
Account 1──1 Progression      (projection)
Account 1──* Statistic        (time series)
Account *──* Account via Friendship (directed status graph)
Account 1──* Invite (from) / *──1 (to);  Invite *──1 World (world invites)
Account *──* Cosmetic via CosmeticOwnership;  Profile ──> equipped cosmetics
Account *──* Achievement via AchievementProgress
Leaderboard 1──* LeaderboardEntry ──> Account|World
Region 1──* World (home);  RoomDirectory ──> Region, instance
Account 1──1 Presence
```

Ownership rules ([DB-7], [SEC-4]): a **World** is rooted at `ownerId`; **Membership**
carries per-player permission; **Profile/Progression/Stats/Cosmetics/Achievements**
belong to their `accountId` and are only mutated by the server on that account's
behalf. Private worlds and private profiles are access-controlled server-side. A
projection is never writable by a client — it is recomputed from the snapshot on
save ([DB-6]).

### 3.3 Indexing strategy ([P-5])

- **Account**: unique on `username`, `email`; index `lastSeenAt` (activity sweeps).
- **Profile**: unique `accountId`; index `visibility` for public listing.
- **World**: unique `code`; index `ownerId`; composite `(isPublic, region, savedAt
  desc)` for the regional public browser; index `region` for placement/eviction.
- **Membership**: unique `(accountId, worldId)`; index `worldId` (roster) and
  `accountId` (my worlds) — both hot, both covered.
- **Factory**: unique `worldId`; index `money` (leaderboard order) — extend to a
  composite `(region, money desc)` for regional boards.
- **Friendship**: unique `(accountId, otherId)`; index `(accountId, status)` for
  "my accepted friends / pending requests" without a scan.
- **Invite**: index `(toAccountId, status)` and `(worldId, status)`; TTL sweep on
  `expiresAt`.
- **Statistic**: `(accountId, key, recordedAt)` for series reads; bounded retention
  (STAT_KEEP) so it never grows unbounded ([P-3]).
- **CosmeticOwnership / AchievementProgress**: unique `(accountId, cosmeticId)` /
  `(accountId, achievementId)`; index `accountId` for locker/achievement pages.
- **LeaderboardEntry**: composite `(leaderboardId, score desc)` covering the top-N
  query; unique `(leaderboardId, accountId|worldId)`.
- **RoomDirectory**: unique `code`; index `(region, isPublic, players)` for
  aggregated listing/placement; `heartbeatAt` for stale-instance reaping.
- **Presence**: unique `accountId`; TTL/`lastSeen` index; ideally Redis with native
  expiry.
- **Ban**: index `accountId`, `ip`, `expiresAt`.

General rules: every new query pattern ships with its index; leaderboard/listing
queries hit **projection** tables, never snapshots ([P-5]); denormalize the one or
two fields a hot list needs (name, ownerName) onto the projection rather than
joining at scale; avoid N+1 by batching friend/roster lookups.

### 3.4 Read/write scaling of the store

- **Writes.** The hot write is the room snapshot. Moving snapshots to object storage
  removes the largest, most frequent write from Postgres, leaving it with small
  metadata + projection upserts. Projection writes stay off the sim loop ([DB-8]).
- **Reads.** Listings, leaderboards, profiles, and social reads are
  latency-tolerant and go to **read replicas**; authz-critical reads (does this
  account own/belong-to this world) go to the primary or are token-carried to avoid
  a replica-lag race ([DB-9]).
- **Partitioning (far future).** If a single primary saturates, shard by
  `region` (worlds/directory) and by `accountId` hash (social/accounts); the store
  interface hides which shard answers ([A-4]).

---

## 4. Networking design

Two logical channels, two version axes, one auth secret.

### 4.1 Channels & message categories

- **Control channel** — client ↔ control plane. HTTPS/JSON (or a lightweight WS)
  for request/response. Categories: **auth/session**, **directory/matchmaking**,
  **social/presence**, **profile/cosmetics/leaderboards**. Versioned by a semantic
  **API version** (`/v1/…`, `X-Gearworks-API`).
- **Game channel** — client ↔ owning game instance. The existing RFC 6455 lockstep
  protocol, versioned by **`PROTO`** in `shared/core.js`. Categories:
  **lobby** (join/resume/rejoin), **simulation** (`cmd` → `tk`/`tks`, `hash`,
  `snap`), **chat**, **presence-lite** (cursors, lossy), **admin** (in-room roles).

Keeping the game protocol *exactly* as-is means the simulation, prediction, and
anti-cheat paths are untouched ([M-8]–[M-13]). All new surface area lives on the
control channel, where it cannot endanger determinism.

### 4.2 Versioning

- **Game protocol**: `PROTO` integer. Breaking change ⇒ bump + graceful "refresh
  your client" mismatch handling; prefer additive optional fields ([M-8], [M-9]).
  The CDN-cached client means server↔client version skew is a *routine* condition,
  so mismatch handling is mandatory, not an edge case (audit §7).
- **Control API**: semantic version + capability negotiation. The client announces
  supported capabilities in `hello`; the server replies with the negotiated set, so
  a new control feature degrades cleanly on an old cached client.
- **Snapshot format**: migrate-on-load; never a destructive un-migrated change
  ([M-10]).

### 4.3 Authentication handshake (connect-token handoff)

The mechanism that lets *any* instance seat *any* player with no shared session
memory ([P-6], [SEC-5]):

```
1. Client → control/auth:   login (username+password | guest | session token)
                            ← session token (HMAC {aid, sv}, stable AUTH_SECRET)
2. Client → control/mm:      "quickplay eu" | "join CODE" | "resume CODE" | "join friend"
   Directory/matchmaking resolves or PLACES the room on an instance in the region.
                            ← { instanceUrl (wss://eu-3.gearworks…), connectToken }
   connectToken = HMAC.sign('connect', {aid, room, region, role, exp≈60s})
3. Client → instance (wss):  open game WS, send hello{ proto, connectToken }
   Instance verifies connectToken with the SAME AUTH_SECRET — no DB round-trip —
   checks room ownership/capacity, seats the player, streams the snapshot.
4. Reconnect:  the stateless reconnect token (P1.2) carries room+region; the
   directory resolves the *current* owning instance; the client re-handshakes.
```

Properties: the connect token is short-lived, signed, and single-purpose ([SEC-5]);
the instance trusts it cryptographically, so seating is O(1) with no cross-service
call; a stale token (room moved/evicted) fails closed and the client re-queries the
directory. Auth remains one path — the same HMAC signer, new `purpose` — never a
second auth scheme ([SEC-5]).

### 4.4 Synchronization strategy

Unchanged core, with regional/router awareness layered on top:

- **Within a room**: commands + periodic gzip snapshots + hash audits + interest
  management, exactly as today ([M-11], [M-12], [P-4]). A room never spans
  instances or regions — that would break determinism budgets and latency.
- **Room spin-up**: on placement, the owning instance loads the snapshot from the
  store (object storage or Postgres) and begins the 20 Hz loop; on idle-evict it
  final-saves and deregisters from the directory.
- **Presence/social**: propagated on the *control* channel, out-of-band from the
  sim, so social fan-out never touches the tick loop.
- **Cross-region**: a world is homed in one region; players connect to that region.
  Matchmaking prefers the player's lowest-latency region for *new* rooms. There is
  no cross-region state replication of live rooms — only the durable snapshot +
  metadata are global.

---

## 5. Scalability design — migration path

The architecture already *permits* this because a room is a self-contained
authoritative unit ([P-6]); the path is about building the **router**, not changing
the game.

### Current — single server
One Node process runs both planes in-process: `registry` in memory, all rooms in one
heap, Postgres for accounts/worlds/projections, snapshots in Postgres/file. Correct
and sufficient for 10–100 players (audit §4). The directory is implicitly "this
process."

### Future step 1 — multiple servers, one region
Introduce the **directory** as a shared table (Postgres, optionally Redis-cached):
- Rooms register/deregister and heartbeat into `RoomDirectory` with `instanceId`.
- The control plane resolves `code → instance` and **places** new rooms on the
  least-loaded healthy instance (capacity from directory heartbeats).
- The public listing becomes an **aggregated** directory query, not a per-process
  `publicRooms()`.
- Clients reach rooms via the **connect-token handoff** (§4.3); reconnect resolves
  the current owner via the directory.
- Snapshots move to **object storage** so any instance can load any room on
  placement.
The simulation and protocol do not change. Single-instance mode remains a valid
config (directory returns "self"), preserving the $0 deployment.

### Future step 2 — regional deployment
- Add `Region` rows and per-region data-plane fleets behind regional endpoints.
- Worlds gain a home `region`; matchmaking is **region-aware** (latency-first for
  new rooms, home-region for existing worlds).
- The control plane is global but stateless; the shared DB gains **read replicas**
  (per-region readers for listings/leaderboards/profiles); authz reads stay on the
  primary or are token-carried ([DB-9]).
- Presence and matchmaking queues become natural **Redis** candidates (per-region
  cache, global aggregation) — still optional, Postgres-backed fallback.

### Future step 3 — database scaling & depth
- **Object storage** for snapshots (done in step 1) offloads the hot write.
- **Read replicas** scale read-heavy social/listing traffic.
- **Redis** for presence/queues/directory-cache/rate-limits when latency demands.
- **Partitioning** by region (worlds/directory) and account-hash (social) only if a
  single primary saturates — deferred until measured need.
- **Moderation & anti-cheat depth** (bans, reports, anomaly scoring, optional replay
  capture) layered on the now-global identity and metrics ([SEC-3]).

Each step is additive and independently shippable; none requires touching
`shared/core.js` or `PROTO`.

---

## 6. Implementation plan (staged, additive)

Three phases. Each is gated by the guideline checklist ([§8]); each keeps the
single-process $0 deployment working with the new subsystem **disabled by default**.

### Phase 1 — Data-plane fleet + directory + connect-token handoff
**Goal:** run more than one game instance behind a shared room directory, with
clients routed via signed connect tokens, and snapshots in object storage — while
single-instance mode stays byte-for-byte the current behavior.

> **Status — Slices 1–2 landed.**
> - **Slice 1 (the handoff gate):** `server/world/directory.js` (room router;
>   `local` no-op default + shared `file` backend), the `connect` token purpose,
>   registry register/deregister/heartbeat, lobby connect-token acceptance, and a
>   `GET /resolve` control endpoint — proven by a **two-process** test where a
>   peer instance resolves the owner's room and mints a token the owner verifies.
> - **Slice 2 (client handshake + aggregated listing):** the client resolves a
>   coded join/resume over the lobby socket (`resolve`/`resolved`, CSP-safe — no
>   cross-origin fetch), attaches the returned connect token to the join, and
>   connects to the resolved instance URL; `registry.publicRooms()` aggregates
>   remote instances' public rooms. Browser-verified end to end (a second client
>   joins through the resolve→token path) and a two-process test routes a listed
>   remote room to its owner. Single-instance behavior unchanged.
>
> - **Slice 3 (externalized snapshots):** `server/database/snapshotStore.js` — a
>   snapshot blob store behind the store interface, `inline` (default) +
>   `fs` (shared dir) backends, wired into both file and Postgres backends; the
>   room save/`World` row keeps only a `snapshotRef` (migration `0006`,
>   `World.snapshot` nullable) so any instance can load any room. Meta-only reads
>   (leaderboard/listing) never fetch the blob. Proven by cross-instance
>   hydration + a real-server round-trip; object storage (s3/R2) is the next
>   drop-in behind the same contract. Default inline → unchanged.
>
> - **Slice 4 (placement safety + cross-instance reconnect):** `directory.claim()`
>   — compare-and-set placement via atomic exclusive-create, so two instances can
>   never host the same code (registry claims a code before creating a room; a
>   live peer's ownership refuses the create, and code generation avoids
>   peer-owned codes). And rejoin now **redirects**: a client that reconnects to
>   the wrong instance is sent (`redirect`) to the room's current owner instead of
>   refused (the reconnect token verifies on any instance — shared secret). Proven
>   by a CAS test and a two-process redirect test. Single-instance unchanged.
>
> **Remaining (deployment-level, deferred):** the Postgres directory backend +
> `RoomDirectory`/`Region` schema and the `s3`/R2 snapshot backend — both
> mechanical mirrors behind the now-proven contracts, landing with the regional
> Postgres deployment (Phase 3). Every scale *mechanism* is built and tested;
> what remains is wiring the durable/cloud backends behind the same seams.

**Files affected**
- `server/directory/*` (new): directory interface + Postgres backend (+ optional
  Redis cache); place/resolve/heartbeat/aggregate-listing.
- `server/world/registry.js`: register/deregister/heartbeat rooms; report capacity.
- `server/players/tokens.js`: add `connect` purpose; `players/lobby.js` +
  `network/httpServer.js`: verify connect token on upgrade/join.
- `server/database/*`: object-storage snapshot backend behind the store interface;
  `World.snapshotRef` migration.
- `server/config.js`: `INSTANCE_ID`, `REGION`, `DIRECTORY`, `SNAPSHOT_STORE`,
  single-instance toggle.
- `client/net.js` (+ a new `client/director.js`): control-channel handshake →
  connect token → game WS.
- `prisma/schema.prisma` + migration: `RoomDirectory`, `Region`, `World.region/
  snapshotRef` (additive, nullable first — [DB-5]).

**Risks**
- WS **affinity / reconnection storms** if placement flaps; directory as a new
  consistency-sensitive component (mitigate: heartbeat + lease, fail-closed tokens).
- **Handoff race** (room evicted between token issue and connect) — token verify must
  fail closed and trigger a re-query.
- **Object-storage latency** on cold room spin-up vs Postgres JSONB (measure; cache
  hot worlds).
- **Split-brain**: two instances claiming one code (mitigate: directory
  compare-and-set on placement; a room code has one lease).

**Tests required** ([Q-5], [F-4])
- directory resolve/place/heartbeat/aggregate; stale-instance reaping.
- connect-token sign/verify/expiry/forgery/tamper (extends the P1.2 token suite).
- **two-instance** room join & reconnect via directory (two in-process registries +
  a shared directory) — a diverged client resyncs unchanged.
- object-storage snapshot backend parity with file/Postgres ([DB-3]).
- single-instance mode unchanged (all existing suites stay green).

### Phase 2 — Social, profiles, cosmetics, presence, matchmaking
**Goal:** the "platform" layer — friends, invites, profiles, cosmetics,
achievements, leaderboards, presence, and quickplay matchmaking.

> **Status — Slice 1 landed (social graph).** `Friendship` (schema + migration
> `0007`, both backends) with the request/accept/decline/remove/block state
> machine, served over the lobby (`friends`/`friendReq`/`friendResp`/
> `friendRemove`/`friendBlock`) and a lobby friends panel. Proven by a
> file-backend state-machine test + an end-to-end lobby test, and browser-
> verified. Blocking removes the friendship and prevents new requests; mutual
> requests auto-accept.
> - **Slice 2 (presence):** `server/presence.js` — ephemeral online/in-game
>   status kept OUT of the relational store (`local` default | shared `file`,
>   TTL → offline; Redis slots in later). Set on auth/lobby activity, refreshed
>   in-game by the room ping, cleared on leave; the `friends` graph is enriched
>   with each friend's presence and the client shows a status dot. Proven by a
>   presence-module test + an end-to-end online → in-game → offline test.
>
> - **Slice 3 (world invites):** `server/invites.js` — pending "join my world"
>   invites, ephemeral like presence (`local` default | shared `file`, TTL).
>   `invite` (friends-only + access-checked), `invites`, `inviteAccept` (→ the
>   recipient joins via the existing resolve/connect-token handoff — an invite
>   never bypasses authority), `inviteDecline`; a lobby invites panel + an
>   Invite button on online friends. Proven by a module test + an end-to-end
>   lobby test (invite → list → accept + authz).
>
> - **Slice 4 (quickplay matchmaking):** a lobby `quickplay` that scans the
>   aggregated public listing for a room with a free seat — this region first,
>   fuller rooms first so players congregate — and returns its code, else tells
>   the client to host one; private/full rooms are never matched. Room capacity
>   is carried in directory routes so it works cross-instance. A "⚡ Quick Play"
>   button drives it. Proven by a matchmaking test (match / full → create /
>   private skipped / prefer-fuller) and browser-verified end to end.
>
> - **Slice 5 (achievements):** `shared/achievements.js` — a goal catalog +
>   evaluator that is a **pure function of the progression summary** (level / net
>   worth / buildings / tech), derived on demand like progression ([DB-6]), no
>   write path. A lobby `achievements` message + a lobby panel with unlock state
>   and progress bars. Proven by an evaluator test + an end-to-end check that the
>   server's achievements equal `evaluate(progression)`.
>
> - **Slice 6 (friend-scoped leaderboards):** the existing Factory leaderboard
>   projection ([DB-6]) filtered to your social graph. `topFactories(limit,
>   ownerIds)` gains an optional owner-id filter (both backends); the lobby
>   `leaderboard` handler reads `scope` — `friends` (with an account) resolves
>   `friendGraph(me) + me` and passes those owner ids, everything else stays
>   global — and echoes the effective `scope` back so a signed-out `friends`
>   request degrades to global. A Friends↔Global toggle on the leaderboard panel
>   (shown only when signed in) with a friends-empty hint. No new store, no new
>   write path — pure reuse of the derived projection. Proven by an end-to-end
>   test (global includes a non-friend; friends board = self + friend only;
>   signed-out friends → global).
>
> **Remaining slices:** profiles + cosmetics locker.

**Files affected**
- `server/social/*`, `server/matchmaking/*`, `server/presence/*` (new control-plane
  services + their store methods).
- `server/database/*`: methods for Profile, Friendship, Invite, Cosmetic,
  CosmeticOwnership, Achievement, AchievementProgress, Leaderboard/Season, Presence
  — both backends ([DB-3]).
- `prisma/schema.prisma` + migrations for the above (additive).
- `client/*`: profile, friends+presence, invites, cosmetics locker, achievements,
  leaderboards, quickplay UI (new same-origin scripts).
- `server/simulation/room.js`: emit save/join hooks that feed achievement/stat
  projections (derived, off the tick loop — [DB-6], [DB-8]).

**Risks**
- **Presence fan-out** cost (N friends × updates) — batch/debounce; Redis pub/sub at
  scale.
- **Abuse/privacy**: friend-request spam, blocking, profile visibility, harassment —
  needs rate limits + block semantics from day one ([SEC-2], [SEC-4]).
- **Cosmetic authority**: the catalog is server truth; a client must never grant
  itself a skin ([C-1], [SEC-1]).
- **N+1** in friend/roster/leaderboard reads — batch + index ([P-5]).
- **Matchmaking fairness/placement** interacting with directory capacity.

**Tests required**
- friendship state machine (request/accept/decline/block/unblock, directional).
- invite flow → membership grant; expiry sweep.
- presence heartbeat/TTL/expiry; friend fan-out correctness.
- cosmetic ownership enforcement (equip only owned; server rejects forged equips).
- achievement/stat projection derivation on save; leaderboard/season rollover.
- matchmaking placement (region + capacity), quickplay creates-or-joins.

### Phase 3 — Regional deployment + DB scaling + moderation/anti-cheat
**Goal:** multi-region fleets, replica/object-storage/Redis data scaling, and the
global-identity features (moderation, anti-cheat depth).

**Files affected**
- Infra: per-region deploy config (regions, endpoints), regional Prometheus scrape.
- `server/database/*`: read-replica routing (read vs authz reads — [DB-9]); optional
  Redis backend for presence/queues/directory-cache/rate-limits.
- `server/matchmaking/*`, `directory/*`: region-aware placement + aggregation.
- `server/moderation/*` (new) + `prisma` Ban/Report/ModerationAction; admin surface.
- `server/simulation/room.js` + `metrics.js`: anomaly scoring (input cadence,
  divergence frequency), optional replay capture ([SEC-3]).

**Risks**
- **Replica lag** corrupting authz decisions (guard: authz on primary / token-carried
  — [DB-9]).
- **Cross-region consistency** of directory/presence; region failover and world
  re-homing.
- **Redis reintroduces a dependency** ([A-7], [SEC-8]) — keep optional, fallback
  intact.
- **Moderation scope creep** and **anti-cheat false positives** (score, don't
  auto-ban; human-in-the-loop).
- **Snapshot migration** of live worlds into object storage needs a dual-read
  window.

**Tests required**
- read-replica routing: authz reads never served stale; listing reads may be.
- region routing/placement; home-region resume; failover behavior.
- Redis backend parity + Postgres-fallback path.
- ban enforcement (login/connect rejected); report lifecycle.
- anomaly scoring flags a synthetic cheating client; replay capture round-trips.
- full existing determinism/auth/persistence suites remain green throughout.

---

## 7. Final review — challenging the design

**What could fail**
- **The directory becomes the new SPOF/consistency headache.** It must be
  highly-available and correct under races; a wrong `code→instance` answer splits a
  room. *Mitigation:* compare-and-set placement with a room lease, heartbeat-based
  reaping, fail-closed connect tokens, and a directory that is itself replicated. Do
  **not** ship multi-instance until a two-instance integration test is green.
- **Connect-token handoff adds a round trip and a reconnection surface.** Placement
  flapping could cause reconnect storms. *Mitigation:* sticky placement (a room
  stays put unless drained), short token TTL with clean re-query, backoff on the
  client (already present).
- **Object-storage latency on cold spin-up** could make first-join feel slow vs
  today's in-DB JSONB. *Mitigation:* measure first; cache hot worlds; keep the
  Postgres snapshot backend for latency-sensitive small deployments.
- **Presence fan-out and social spam** are classic scale/abuse traps. *Mitigation:*
  debounce presence, Redis pub/sub at scale, strict rate limits + blocking from day
  one.
- **Two version axes (`PROTO` + API) drift.** A control feature and a sim feature
  can skew independently against a CDN-cached client. *Mitigation:* capability
  negotiation in `hello`; both axes degrade gracefully.
- **Region failover / data residency.** Re-homing a world across regions and any
  residency constraints are genuinely hard. *Mitigation:* keep worlds single-region;
  treat cross-region moves as an explicit, rare, admin operation.

**Where technical debt could appear**
- **The control plane accreting gameplay logic** — a matchmaking or social service
  "just checking" a game rule would violate [A-1]/[DB-1]. Guard it in review.
- **Directory cache invalidation** (Redis vs Postgres divergence) — the classic hard
  problem; keep Postgres authoritative, Redis a cache with TTL.
- **Projection sprawl** — more boards/seasons/achievements = more derived tables that
  can silently become a second source of truth if written directly ([DB-6]).
- **A second store (Redis) diverging** from the Postgres fallback — parity tests
  required, same as the file/Postgres discipline ([DB-3]).
- **Feature-flag/config proliferation** as every subsystem gets a toggle — document
  and default them conservatively.

**What I would change before implementation**
- **Keep Phase 1 strictly additive and provable.** The directory ships with a
  single-instance no-op mode; multi-instance is gated behind a two-instance
  integration test *before* any infra spend. This de-risks the whole program.
- **Put snapshots behind the existing store interface as a third backend**, never a
  parallel path — preserves [DB-3]/[A-4] and keeps file/Postgres working.
- **Keep Redis strictly optional with a Postgres fallback** so [A-7] holds and the
  $0 deployment never *needs* it.
- **Define the control-API version + capability negotiation first**, before building
  social, so old cached clients degrade cleanly.
- **Model moderation/ownership tables early** (even if tooling is later) so authz is
  not retrofitted onto a live social graph.
- **Write the connect-token handoff and directory contracts as interfaces** with
  in-process fakes, so most of Phase 1 is testable without real infra.

---

## 8. Summary — the architecture decision

**Grow Gearworks into a professional platform by splitting a stateless *control
plane* (auth, directory, matchmaking, presence, social/profile API) from a
horizontally-scalable, regionally-deployed *data plane* of game-server instances
that each own a subset of self-contained authoritative rooms — without changing the
deterministic core, the lockstep protocol, or the untrusted-client security model.**

The load-bearing decisions:

1. **Room-as-authority stays the scaling primitive.** Horizontal scale is a
   **room-router/directory** problem (`code → instance`), solved with a shared
   directory + **connect-token handoff** that lets any instance seat any player with
   no shared session memory — because sessions are already stateless HMAC tokens.
2. **Control-plane / data-plane split** keeps new concerns (social, matchmaking,
   presence, cosmetics) as isolated services over the shared store, so they never
   touch the 20 Hz loop or determinism ([A-1], [A-2], [P-6]).
3. **Snapshots to object storage; projections in SQL with read replicas; Redis
   optional.** The authoritative record stays `World.snapshot` (now a blob),
   projections stay derived ([DB-6]), and the data tier scales reads and writes
   independently — all behind the one store interface ([DB-3], [A-4]).
4. **Everything additive and toggleable.** Single-process, single-region, file-backed
   $0 Gearworks remains a first-class deployment with every new subsystem disabled by
   default ([A-6], [A-7]).
5. **Two version axes, one auth secret, one deterministic core.** `PROTO` for the
   game channel, a semantic API version for the control channel, capability
   negotiation for CDN-skew, and the same HMAC signer for one auth path ([SEC-5],
   [M-8]).

Delivered in three additive phases — **(1) multi-instance directory + connect-token
handoff + object-storage snapshots; (2) social/cosmetics/matchmaking/presence;
(3) regional deployment + DB scaling + moderation/anti-cheat** — each independently
shippable, each gated by the engineering-guideline checklist, none requiring a
rewrite of the parts that make Gearworks correct. The architecture was deliberately
shaped, from the beginning, to allow exactly this expansion; this blueprint is the
plan to realize it without spending the debt the constitution exists to prevent.

*Design only — no production code. Implementation proceeds phase by phase, behind
tests and feature flags, when scheduled.*
