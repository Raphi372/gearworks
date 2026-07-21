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
- **WorldMember** — account ↔ world with a `Role` (HOST/ADMIN/PLAYER/SPECTATOR).
- **Factory** — indexed per-world projection (entity count, money, tech tier)
  for leaderboards without deserializing snapshots.
- **Progression** — cross-world account level/xp/unlocked tech.
- **Stat** — time-series counters (production totals, playtime).

The authoritative truth always lives in `World.snapshot`; `Factory`/`Stat` are
denormalized projections for cheap queries.

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
- **Sessions** are stateless **HMAC-signed tokens** (`{aid,exp}` signed with
  `AUTH_SECRET`). The client stores the token in `localStorage` and replays it
  on connect for silent re-login. No server session table needed.
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

Schema, migration, adapter, abstraction, **and accounts + account-owned world
persistence** are implemented and tested on both backends (`npx prisma
validate` passes; headless auth/persistence + browser UI tests pass). Next
milestones: cross-world progression/stats projections and OAuth/email
recovery (P2+ in the [architecture review](ARCHITECTURE_REVIEW.md)).
