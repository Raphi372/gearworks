# Database & Persistence

Gearworks has a pluggable persistence layer. The **default needs no database**;
Postgres is opt-in for managed production and the account/progression metagame.

## Backends

| Backend | When | Setup |
|---|---|---|
| **file** (default) | Local dev, single-box self-host | none — `SAVE_DIR/<code>.json` with rotating `.bakN` backups |
| **postgres** | Managed production, accounts, scale | `STORAGE=postgres` + `DATABASE_URL`, Prisma |

Both implement the same store interface (`server/database/index.js`):
`saveRoom`, `loadRoom`, `loadFile`, `listRoomCodes`, `flush`, `close`. The game
loop calls `saveRoom` synchronously on the file backend and fire-and-forget
(queued) on Postgres, so the 20 Hz simulation never blocks on I/O.

## Data model (Postgres)

Defined in `prisma/schema.prisma`:

- **Account** — player identity (guest, email, or OAuth). Optional; the game
  runs fully anonymous today.
- **World** — a saved authoritative game. `snapshot` (JSONB) is the exact
  `shared/core.js` snapshot — the same format the file backend stores.
- **Factory** — **live** per-world projection (entity count, money, tech tier),
  upserted on every save from the room's derived `projection()`. Powers the
  global leaderboard without deserializing snapshots. One row per world
  (`worldId` unique), indexed by `money`.
- **WorldMember** — account ↔ world with a `Role` (HOST/ADMIN/PLAYER/SPECTATOR),
  `@@unique([accountId, worldId])`. Written on every save from the room's
  `members` set: an authenticated player is recorded the first time they enter a
  world, and their role is updated on promotion (see `setRole`). Powers the
  merged **My Worlds** list (owned + joined) and gates who may revive a dormant
  private world — the owner or any recorded member. Postgres upserts one row per
  member per save; the file backend carries the set forward in each save's
  `meta.members` (a single save file per world), so a resume/restart never drops
  prior members.
- **Progression** — cross-world account level/xp/unlocked tech. *Modelled; not
  yet written* (needs an XP model — future increment).
- **Stat** — time-series counters (production totals, playtime). *Modelled; not
  yet written* (needs an aggregation cadence — future increment).

The authoritative truth always lives in `World.snapshot`; `Factory` is a derived
projection for cheap queries (guidelines DB-6) — never a second source of truth.

## Leaderboard

Every save writes a small derived projection alongside the snapshot
(`server/simulation/room.js` `projection()`: entities, net worth, tech count,
tick). The store exposes `topFactories(limit)` on **both** backends — the file
backend scans save metadata; Postgres queries the `Factory` table (upserted on
save) joined to `World`/`Account` for the world name and owner. The lobby serves
it publicly via the `leaderboard` message, and the client renders it in the
lobby (own worlds highlighted).

## Setup

```bash
# 1. provision Postgres (Neon / Supabase / local docker) and export the URL
export DATABASE_URL="postgresql://user:pass@host:5432/gearworks?sslmode=require"

# 2. generate the client and apply migrations
npm install
npm run db:generate
npm run db:migrate          # production (applies prisma/migrations)
# or  npm run db:migrate:dev   # local, creates new migrations from schema changes

# 3. run the server on the postgres backend
STORAGE=postgres node server/server.js
```

`@prisma/client` is an **optional dependency** — the file backend never loads
it, so `node server/server.js` keeps working with zero installs.

## Migrations

The initial migration lives in `prisma/migrations/0001_init/`. Generate new
ones after editing the schema with `npm run db:migrate:dev`; apply them in
production (and in CI/CD before a backend deploy) with `npm run db:migrate`.

## Backups

- **file backend:** automatic rotating `.bak1…bak5` on every save.
- **postgres:** use your provider's PITR/backups (Neon and Supabase both
  include automated backups). Snapshots are also self-contained JSON, so
  `SELECT snapshot FROM "World"` is a complete, restorable export.

## Accounts & authentication

Player accounts are **wired into gameplay** (both backends): register / log in /
guest, with account-owned persistent worlds.

- **Passwords** are hashed with **scrypt + a per-account random salt**
  (`node:crypto`, no external auth dependency), stored as `saltHex:hashHex` in
  `Account.passwordHash`. Verification is constant-time.
- **Sessions** are stateless **HMAC-signed tokens** (`{aid, sv}` signed with
  `AUTH_SECRET` via `players/tokens.js`). The client stores the token in
  `localStorage` and replays it on connect for silent re-login — no server
  session table. `sv` is the account's **`tokenVersion`**: verification rejects a
  token whose `sv` no longer matches, so bumping the version invalidates every
  session already issued. A **password reset bumps `tokenVersion`** (signing the
  account out everywhere), and the same primitive backs a future "log out
  everywhere". Reconnect tokens are the same signer, scoped `reconnect`.
- **Guests** get a persistent identity (token) with no password, so they can
  own worlds immediately and upgrade later.
- **Recovery** (optional email): a signed-in player may attach an **email** and
  verify it; a forgotten password is reset via a code emailed to that verified
  address. Reset/verify codes are **purpose-scoped, short-lived HMAC tokens**
  (same mechanism as sessions), and a reset token is bound to a hash of the
  current password (`pv`) so it becomes **single-use** the moment the password
  changes — no server-side token table. Reset requests are anti-enumeration
  (identical response whether or not the account exists) and rate-limited. Email
  is sent through the zero-dependency mailer (`server/mailer.js`; Resend HTTP
  API in production). See mail env vars in [PRODUCTION.md](PRODUCTION.md).
- **World ownership**: a world created while signed in records `ownerId`.
  Owners see their worlds under "My Worlds" and can **Resume** them; a private
  saved world can only be resumed by its owner.

Both storage backends implement the account API (`getAccountByName`,
`getAccountByEmail`, `getAccount`, `createAccount`, `updateAccount`,
`worldsByOwner`): the file backend uses a JSON store (`accounts.json`), Postgres
uses the Prisma models.

> Set a stable **`AUTH_SECRET`** in production — see docs/PRODUCTION.md.

## Current status

Implemented and tested on both backends (`npx prisma validate` passes; headless
+ browser tests pass): accounts, **account recovery** (email verify / password
reset), account-owned world persistence, **versioned sessions**, restart
continuity, the **Factory leaderboard projection**, and persistent
**WorldMember** membership (merged My Worlds + member revive access). Next
milestones: **Progression** (cross-world XP/levels) and **Stat** time-series —
both modelled in the schema, not yet written.
