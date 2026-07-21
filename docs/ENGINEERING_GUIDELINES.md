# Gearworks Engineering Guidelines

**The architectural constitution of Gearworks.** Every contribution — human or
AI — must comply with this document. It defines *how* we build, not *what* we
build. When a change conflicts with these rules, the change is wrong until either
it is corrected or this document is deliberately amended (see
[Amending this document](#amending-this-document)).

This document is **normative and enforceable**. Companion docs are **descriptive**
and explain how the current system works — read them alongside this one:
[ARCHITECTURE.md](ARCHITECTURE.md), [MULTIPLAYER.md](MULTIPLAYER.md),
[DATABASE.md](DATABASE.md), [PRODUCTION.md](PRODUCTION.md),
[DEPLOYMENT.md](DEPLOYMENT.md), [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).

### How to read the rules

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used
per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). A **MUST**/**MUST NOT** is
a hard gate: a reviewer blocks the change. A **SHOULD** is a strong default that
requires written justification to break. Rules are numbered (e.g. **[D-2]**) so
reviews and commit messages can cite them.

---

## 1. Project Philosophy

Gearworks is an **online, server-authoritative, multiplayer factory-automation
game** with a fully offline single-player mode. It is a long-lived product, not a
prototype. Our engineering culture follows four beliefs:

1. **Maintainability beats speed.** A feature that ships a week later but is
   understandable, tested, and isolated is *better* than one that ships now and
   entangles two subsystems. Optimise for the tenth engineer to touch the code,
   not the first.
2. **Design for the next order of magnitude.** Every subsystem should have a
   credible answer to "what happens at 100,000 players?" (see
   [§9](#9-performance-rules)). We do not have to *build* for that scale today,
   but we MUST NOT build in a way that *forecloses* it. The room-as-authoritative
   unit, the stateless-session-token design, and the pluggable store all exist so
   the game can scale horizontally without a rewrite.
3. **Do not rewrite working systems without a strong, written reason.** The
   deterministic core (`shared/core.js`), the lockstep network model, and the
   auth scheme are load-bearing and battle-tested. Replacing them requires a
   design note that states the concrete problem, the options considered, and the
   migration path — not a preference. Prefer extension over replacement.
4. **The simulation is sacred.** Determinism is the foundation the entire
   multiplayer model rests on. Any change that risks it is the highest-risk change
   you can make (see [§5](#5-multiplayer-rules)).

---

## 2. Architecture Principles

Gearworks has exactly **three layers** — client, shared, server — plus a
**persistence** boundary behind the server. These principles govern all of them.

- **[A-1] Separation of concerns.** Rendering, input, and UI (client) are separate
  from game truth and validation (server), which are separate from storage
  (database). A file MUST have one clear home in this taxonomy.
- **[A-2] Single responsibility.** A module does one thing. `world/registry.js`
  owns the set of live rooms; `simulation/room.js` owns one game; `players/
  lobby.js` owns pre-room connection handling. When a file starts doing two jobs,
  split it.
- **[A-3] Modular design with a composition root.** Modules are created by factory
  functions (`createStore`, `createRegistry`, `createLobby`, `createAuth`, …) and
  wired together in exactly one place: `server/server.js`. Dependencies are
  **injected**, never reached for. A module MUST NOT `require()` a sibling
  subsystem to grab shared state; it receives what it needs as an argument.
- **[A-4] Clean interfaces.** Cross-boundary contracts are small and explicit. The
  store interface (`server/database/index.js`) is the canonical example: seven
  methods, documented, backend-agnostic. Callers depend on the *interface*, never
  on which backend is behind it.
- **[A-5] Dependency direction points inward and downward.** `shared/` depends on
  nothing. Client and server depend on `shared/`. The server depends on the
  database interface. Dependencies MUST NOT flow the other way (see
  [§4](#4-dependency-rules)).
- **[A-6] Backwards compatibility is a feature.** The wire protocol, the save
  snapshot format, and the database schema are all consumed by artifacts you do
  not control at deploy time (running clients, saved worlds, live rows). Changes
  to them MUST be backward-compatible or versioned+migrated. See
  [§5](#5-multiplayer-rules) and [§6](#6-database-rules).
- **[A-7] Zero-dependency runtime by default.** The client is dependency-free
  HTML/JS with **no build step**; the server runs on Node standard library alone.
  `@prisma/client` is an *optional* dependency loaded only by the Postgres
  backend. Adding a **runtime** dependency (client or server) requires explicit
  justification in review — it is a deliberate architectural decision, not a
  convenience. Dev/tooling dependencies are held to a lighter bar but still
  scrutinised.

---

## 3. Core Architecture Rules

The three layers and the persistence boundary have fixed responsibilities. These
are the load-bearing walls; do not move them.

### 3.1 Client — `index.html`, `client/*`, `shared/core.js` (in the browser)

The client is a **presentation and prediction** layer.

**It IS responsible for:**
- rendering the world, entities, and effects;
- input handling (mouse, touch, keyboard) and UI/menus/lobby;
- **client-side prediction** (optimistic "ghost" placements) and reconciliation
  when the server confirms or rejects;
- interpolation/smoothing of remote state (cursors, snapshots);
- local presentation state (camera, selected tool, blueprints in `localStorage`).

**It MUST NOT be responsible for:**
- **[C-1]** authoritative game decisions — what actually happened in the world;
- **[C-2]** validation that protects the game (funds, tech, occupancy, terrain,
  role, rate) — the client MAY pre-check for UX, but the server re-checks and its
  answer is the only one that counts;
- **[C-3]** permanent storage of shared game state — `localStorage` holds *local
  preferences and single-player saves only*, never authoritative multiplayer
  state;
- **[C-4]** trusting any data it received from another client.

A hacked client MUST only be able to corrupt *its own view*, briefly, before the
next state-hash audit resyncs it. If a client change could affect another player's
world, it is in the wrong layer.

### 3.2 Shared — `shared/core.js`

The **deterministic simulation core**, run identically in the browser (single
player and prediction) and in Node (the authority). This is the crown jewel.

- **[S-1]** `shared/core.js` MUST remain **environment-agnostic**: no DOM, no
  `window`, no `fs`, no network, no wall-clock time, no unseeded randomness. It
  receives inputs and advances state; that is all.
- **[S-2]** It MUST be **fully deterministic** — identical seed + identical
  ordered command stream ⇒ identical state hash, on every platform, forever. See
  [§5.3](#53-determinism).
- **[S-3]** It exposes a **minimal surface**: `{ PROTO, Util, Config, createGame }`.
  Game logic lives behind `createGame`; helpers live under `Util`; tunables under
  `Config`. Do not widen this surface casually.

### 3.3 Server — `server/*`

The **single source of truth** for all shared/multiplayer state.

**It IS responsible for:**
- running the authoritative simulation (`simulation/room.js`) at a fixed 20 Hz;
- validating **every** inbound command before applying it, and stamping issuer
  identity server-side;
- multiplayer state: room lifecycle, membership, roles, cursors, chat relay;
- transport, sessions/reconnect, rate limiting, and security headers;
- deciding when and what to persist (it *calls* the store; it is not the store).

**It MUST:**
- **[SV-1]** treat all client input as hostile until validated (see
  [§10](#10-security-rules));
- **[SV-2]** keep authority server-side: clients send **commands (intent)**, never
  **state (facts)**;
- **[SV-3]** remain the *only* writer of authoritative truth. The database stores
  what the server tells it; it does not compute game outcomes.

### 3.4 Database — `server/database/*`, `prisma/*`

A **persistence** layer behind a backend-agnostic interface.

**It IS responsible for:**
- durable storage of world snapshots, accounts, membership, and denormalised
  projections (factory/progression/stats);
- account records and password hashes;
- nothing else.

**It MUST NOT:**
- **[DB-1]** contain gameplay logic, rules, or simulation. A store persists and
  retrieves bytes; it never decides what is legal or what happens next.
- **[DB-2]** be the source of truth for live game state — the authoritative truth
  is the in-memory room; the DB is its durable projection (`World.snapshot` is the
  exact `shared/core.js` snapshot).

---

## 4. Dependency Rules

The dependency graph is **acyclic** and points toward `shared/` and away from
gameplay. This is the single most important structural rule in the repository.

```
        ┌─────────────────────────────────────────────┐
        │                 shared/core.js               │  ← depends on NOTHING
        └───────────────▲───────────────▲──────────────┘
                        │               │
        ┌───────────────┴───┐   ┌───────┴───────────────────────────┐
        │   client/* (UI)   │   │   server/* (authority)            │
        │  render·input·    │   │  simulation · lobby · world ·     │
        │  predict·present  │   │  network · players                │
        └───────────────────┘   └───────┬───────────────────────────┘
                                         │  (via the store interface only)
                                 ┌───────▼───────────┐
                                 │  server/database/*│  → Postgres / file
                                 └───────────────────┘
```

**Allowed:**
- **[D-1]** `client → shared`
- **[D-2]** `server → shared`
- **[D-3]** `server → database` **through `database/index.js`'s interface only**

**Forbidden (MUST NOT):**
- **[D-4]** `shared → client` or `shared → server` — the core depends on nothing.
- **[D-5]** `database → gameplay` — a store MUST NOT import `shared/core.js`
  game logic, `simulation/`, or make rules decisions.
- **[D-6]** `client (UI/render) → database` — the client has no database access,
  direct or transitive. It reaches persistence only by sending commands the
  server validates and the server chooses to persist.
- **[D-7]** `render → networking` and `networking → render` — presentation and
  transport are decoupled. Rendering reads game state through the core's hooks;
  it does not call the socket, and the network layer does not draw.
- **[D-8] No import cycles**, anywhere. If two modules need each other, extract the
  shared contract or inject it at the composition root (`server.js`).

A concrete test for any new `require`/`import`: *does the arrow point inward
(toward `shared`) or down (toward the store interface)?* If it points outward or
sideways into another subsystem's internals, it is forbidden.

---

## 5. Multiplayer Rules

The networking model is **server-authoritative deterministic lockstep**. See
[MULTIPLAYER.md](MULTIPLAYER.md) for the full protocol; these are the rules.

### 5.1 Server authority
- **[M-1]** Clients send **commands**, the server sends **results/ticks**. A client
  MUST NOT be able to assert a fact about the world. The server validates every
  command against live state and stamps the issuer server-side.
- **[M-2]** Server-only and privileged commands (e.g. NPC `ai`, weather,
  day-length, admin actions) MUST be rejected when they arrive from a client that
  lacks authority. Authority is checked on the server, never assumed from the
  message.

### 5.2 Message validation
- **[M-3]** Every inbound message MUST be validated before it has any effect:
  well-formed JSON, known type, within size (`MAX_MSG_BYTES`) and rate
  (`CMD_RATE_LIMIT`, `CHAT_RATE_LIMIT`) limits, and semantically legal for the
  sender's role and the current state. Malformed input disconnects or is dropped;
  it never throws into the game loop.
- **[M-4]** User-supplied text (chat, names) MUST be sanitised (control chars
  stripped, length-capped) and rendered via `textContent` — never `innerHTML`.

### 5.3 Determinism
- **[M-5]** The simulation MUST derive **all** nondeterminism from seeded,
  reproducible sources: the seeded RNG (`mulberry32`), the deterministic sine
  (`Util.dsin`), and tick-derived time. Direct use of `Math.random()`,
  `Date.now()`, `performance.now()`, or floating-point that varies by platform
  **inside the simulation** is forbidden.
- **[M-6]** Commands MUST be applied in a deterministic order (the ordered command
  map), identically on server and predicting clients.
- **[M-7]** Any change touching `shared/core.js` MUST keep the determinism test
  green (`scripts/validate.js`, `scripts/test.js`) and MUST NOT be merged if the
  state-hash diverges across a run.

### 5.4 Protocol versioning & compatibility
- **[M-8]** The wire protocol is versioned by `PROTO` in `shared/core.js`. Any
  **breaking** change to message shapes or semantics MUST bump `PROTO` and handle
  the mismatch gracefully (reject with a clear "update your client" path), because
  old clients will still connect.
- **[M-9]** Prefer **additive, backward-compatible** protocol changes (new optional
  fields, new message types) over breaking ones. Removing/renaming a field is a
  breaking change.
- **[M-10]** The save **snapshot format** is part of the compatibility surface:
  loading an older snapshot MUST succeed (migrate on load if needed). Never make a
  change that silently corrupts existing saved worlds.

### 5.5 Synchronization
- **[M-11]** State is synchronised by **commands + periodic snapshots + hash
  audits**, not by streaming full state. New features MUST fit this model: send the
  minimal intent, let the deterministic sim produce the result on every peer.
- **[M-12]** Bandwidth-per-player is a design constraint, not an afterthought. Use
  interest management (send only what a client needs, e.g. cursors/viewport) and
  avoid per-tick full-state messages.
- **[M-13] Single-player/multiplayer parity.** Both modes drive the *same*
  deterministic core through the same command semantics — `LocalSession` (client
  is its own authority) and `NetSession` (server is authority) must apply commands
  with identical validate→apply→tick behaviour. A change to command handling MUST
  update both paths so single-player and multiplayer never diverge; single-player
  is not a separate ruleset, it is the same simulation with a local authority.

---

## 6. Database Rules

See [DATABASE.md](DATABASE.md) for the schema and backends.

- **[DB-3] Two backends, one interface.** Every persistence feature MUST work
  through the store interface in `database/index.js` and MUST be implemented for
  **both** the file backend (`fileStore.js`) and the Postgres backend
  (`postgresStore.js`), or be explicitly, cleanly degraded on the backend that
  cannot support it. The rest of the server never learns which backend is active.
- **[DB-4] Migrations are the only way to change the schema.** Edit
  `prisma/schema.prisma`, generate a migration (`npm run db:migrate:dev`), and
  commit it under `prisma/migrations/`. Never hand-edit a database or a committed
  migration. Production applies migrations via `npm run db:migrate` (wired into
  CI before backend deploy).
- **[DB-5] Migrations MUST be forward-only and safe to run on a live database:**
  additive first (new nullable columns / new tables), backfill, then tighten in a
  later migration. No destructive change without an explicit, reviewed plan.
- **[DB-6] Data ownership.** `World.snapshot` is the authoritative record; the
  `Factory`/`Progression`/`Stat` tables are **denormalised projections** for cheap
  queries and MUST be derivable from the snapshot. Never let a projection become a
  second source of truth.
- **[DB-7] Ownership & access.** A private saved world is readable/resumable only
  by its `ownerId`. Any new data that belongs to a player MUST record ownership and
  enforce it server-side.
- **[DB-8] Persistence MUST NOT block the simulation.** The 20 Hz loop calls the
  store synchronously on the file backend and fire-and-forget (queued) on Postgres.
  A new persistence path MUST NOT introduce an `await` that stalls a tick.
- **[DB-9] Transactions.** A multi-row change that must be atomic (e.g. creating a
  world and its membership) MUST use a transaction on the Postgres backend. Reads
  used for authorization MUST NOT race writes that grant it.

---

## 7. Code Quality Rules

- **[Q-1] Naming.** Names describe intent. Factories are `createX`. Booleans read
  as predicates (`isProd`, `closing`). Match the surrounding file's existing
  conventions (the client is ES5-flavoured vanilla JS; the server is modern
  CommonJS) rather than importing a foreign style.
- **[Q-2] Comments explain *why*, not *what*.** Every module begins with a header
  comment stating its responsibility and its place in the architecture (follow the
  existing pattern). Inline comments justify non-obvious decisions, invariants, and
  determinism-sensitive code. Do not narrate obvious code.
- **[Q-3] Error handling.** Validate at the boundary; fail fast on programmer
  error; degrade gracefully on expected runtime failure (a bad client message
  disconnects that client, it never crashes the process). Top-level
  `uncaughtException`/`unhandledRejection` handlers exist as a last resort and
  report to monitoring — they are not a substitute for handling errors where they
  occur.
- **[Q-4] Logging.** Use the structured logger from `config.js`
  (`log`/`log.warn`/`log.error`), never bare `console.log`. Production logs are
  one-line JSON. Never log secrets, passwords, tokens, or full connection strings.
  Log security-relevant events (divergence, auth failures, rate-limit trips) at
  `warn`.
- **[Q-5] Testing requirements.** The suites in `scripts/validate.js` and
  `scripts/test.js` MUST stay green on every change; CI (`validate.yml`) enforces
  this. Any change to the simulation, protocol, persistence, or security MUST add
  or extend a test that would fail without the change. Determinism, snapshot
  round-trip, command authority, persistence, and input sanitisation are the
  existing pillars — extend them.
- **[Q-6] Small, reviewable changes.** One concern per pull request. A change that
  spans layers should be reviewable as a coherent whole with a clear description of
  the cross-layer contract it touches.
- **[Q-7] No secrets in the repo.** Configuration comes from env / `.env`
  (gitignored). `.env.example` documents keys with no real values.

---

## 8. Feature Development Rules

A "feature" is any change to gameplay or online behaviour. Before writing code,
and in the pull-request description, every feature MUST include:

- **[F-1] Architecture impact analysis.** Which layer(s) does it touch? Confirm it
  respects [§3](#3-core-architecture-rules) and [§4](#4-dependency-rules). If it
  seems to require a forbidden dependency, the *design* is wrong — rework it.
- **[F-2] Determinism & networking impact.** Does it touch `shared/core.js` or the
  protocol? If so: is it deterministic ([§5.3](#53-determinism))? Is it
  backward-compatible, or does it bump `PROTO` with a handled mismatch
  ([§5.4](#54-protocol-versioning--compatibility))? What is the per-player
  bandwidth cost?
- **[F-3] Database changes.** Does it need new persisted data? If so: schema
  change + migration, implemented for both backends, with ownership enforced
  ([§6](#6-database-rules)).
- **[F-4] Tests.** New/changed behaviour ships with tests that would fail without
  it ([Q-5]).
- **[F-5] Documentation.** Update the relevant descriptive doc (ARCHITECTURE,
  MULTIPLAYER, DATABASE, PRODUCTION) so it stays true. Docs are part of the
  feature, not a follow-up.
- **[F-6] Security review.** State how the server validates the new input and why a
  malicious client cannot abuse it ([§10](#10-security-rules)).

A feature that cannot honestly complete this checklist is not ready to merge.

### Pull-request checklist (copy into the PR)

```
- [ ] Touches only the correct layer(s); no forbidden dependency (§3, §4)
- [ ] Simulation change is deterministic; validate/test green (§5.3, Q-5)
- [ ] Protocol change is backward-compatible or bumps PROTO with mismatch handling (§5.4)
- [ ] Save-snapshot compatibility preserved (§5.4 M-10)
- [ ] DB change: migration committed, both backends, ownership enforced (§6)
- [ ] Persistence does not block the sim loop (§6 DB-8)
- [ ] Server validates all new inbound input; client is untrusted (§10)
- [ ] Tests added/updated that fail without this change (Q-5)
- [ ] Relevant docs updated (§8 F-5)
- [ ] No secrets committed; structured logging; no console.log (Q-4, Q-7)
```

---

## 9. Performance Rules

Targets are budgets, not aspirations. Every feature spends against them.

- **[P-1] Simulation cadence.** The authoritative loop runs at a fixed 20 Hz
  (50 ms/tick). Per-tick work MUST stay well under budget; cost scales with **active
  entities**, not connected players. Expensive operations (audits, saves) run on an
  interval, never every tick for every entity.
- **[P-2] Latency.** The prediction/reconciliation model must keep local actions
  feeling instant regardless of RTT. Target playable experience up to ~150 ms RTT;
  a placement lands on the next tick locally (predicted) and is confirmed within a
  round trip. Never add a design that requires a synchronous server round trip
  before the player sees feedback.
- **[P-3] Memory.** Room state is in-memory and bounded (`MAX_ROOMS`,
  `MAX_PLAYERS_PER_ROOM`); idle rooms save and evict (`EMPTY_ROOM_TTL_MS`). A
  feature MUST NOT introduce unbounded growth (leaking listeners, ever-growing
  arrays, per-connection buffers without caps).
- **[P-4] Network efficiency.** Commands are small; snapshots are compressed and
  sent on join/resync, not continuously; cursors/view use a lossy, interest-managed
  channel. New traffic MUST justify its bytes-per-tick and respect the flood guards.
- **[P-5] Database efficiency.** The sim never blocks on I/O ([DB-8]). Leaderboard/
  listing queries hit **projection** tables, never deserialise snapshots at scale.
  Add an index with any new query pattern; avoid N+1 access.
- **[P-6] Scaling to 100,000 players.** The design MUST preserve the horizontal path
  documented in [PRODUCTION.md](PRODUCTION.md): a room is a self-contained
  authoritative unit, so scale-out is a **room-router** (hash invite code → server
  instance, shared directory in Postgres/Redis). Therefore: never introduce global
  mutable server state that assumes a single process, never assume all rooms live in
  one machine's memory, and keep sessions stateless (HMAC tokens, no server-side
  session table required). A change that would break sharding is a design defect
  even if it works on one box today.

---

## 10. Security Rules

Assume every client is an attacker who has read the source.

- **[SEC-1] Never trust the client.** All authority is server-side. The client is a
  renderer and a predictor; nothing it sends is believed without validation
  ([M-1], [M-3], [C-1]–[C-4]).
- **[SEC-2] Validate everything, at the boundary.** Type, size, rate, role, and
  semantic legality are checked before any inbound message affects state. The
  issuer's identity is stamped by the server, never taken from the message body.
- **[SEC-3] Anti-cheat by construction.** Periodic state-hash audits detect a
  diverged (tampered) client and force a resync; a cheating client can only corrupt
  its own view. Do not remove or weaken the audit path.
- **[SEC-4] Protect player data.** Player-owned data is access-controlled by owner
  server-side ([DB-7]). Do not expose another player's private worlds, accounts, or
  tokens through any endpoint or message.
- **[SEC-5] Protect authentication.** Passwords are hashed with scrypt + a
  per-account random salt and verified in constant time (`node:crypto`); they are
  never stored, logged, or transmitted in reverse-recoverable form. Sessions are
  stateless HMAC-signed tokens signed with a stable `AUTH_SECRET`. Never weaken the
  hashing, log a token/password, or invent a second auth path that bypasses this.
  Rate-limit login attempts (`LOGIN_MAX_ATTEMPTS`).
- **[SEC-6] Transport & headers.** Public traffic is TLS (`wss://`/`https://`).
  Keep the strict security headers/CSP (`script-src 'self'`, no inline JS — the
  client has none) set by `network/httpServer.js` and `public/_headers`. A change
  that requires loosening the CSP (inline script, external host) MUST be justified
  and scoped as narrowly as possible.
- **[SEC-7] Secrets stay out of the repo and out of logs** ([Q-4], [Q-7]).
- **[SEC-8] Dependencies are attack surface.** The near-zero-dependency runtime is a
  security property. Every added dependency is reviewed for necessity and supply-
  chain risk ([A-7]).

---

## Amending this document

These rules are stable, not frozen. To change one: open a pull request that edits
this file, states the concrete problem with the current rule, and explains why the
change does not reintroduce the debt the rule prevents. Amending a rule is a
deliberate architectural decision reviewed on its own merits — never a silent
side-effect of a feature PR. Until amended, the rule stands.

---

*This constitution exists so that Gearworks can grow for years and to hundreds of
thousands of players without accumulating the debt that kills long-lived codebases.
When in doubt, choose the option that keeps the layers separate, the simulation
deterministic, the client untrusted, and the future open.*
