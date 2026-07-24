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
  `shared/core.js` snapshot — the same format the file backend stores. When a
  snapshot store is active (`SNAPSHOT_STORE=fs` for a shared dir, or `s3` for
  object storage — AWS S3 / Cloudflare R2, via zero-dependency SigV4), the blob
  lives externally and `snapshot` is null while `snapshotRef` points at it, so
  any instance can load any room on placement (`server/database/snapshotStore.js`);
  `World.snapshot` stays the authoritative record ([DB-6]) — it just lives out of
  the row. Default is inline (unchanged).
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
- **Progression** — cross-world account level / xp / unlocked tech. Derived
  from the account's worlds by the pure `shared/progression.js`: per-world
  XP = `money + entities*5 + techCount*250`, summed across every world the
  account owns or has played; a triangular level curve (level *L* needs
  `1000·L·(L-1)/2` XP); `unlockedTech` is the sorted union of researched tech
  ids. Recomputed on demand (a `progression` lobby message) so it is always
  fresh — never a second source of truth. The Postgres backend also upserts
  the derived `Progression` row (keeping the modelled table live); the file
  backend recomputes from save metadata, exactly like the leaderboard.
- **Friendship** — the social graph (Phase 2). Directed rows keyed
  `@@unique([accountId, otherId])` with a `FriendStatus` (`PENDING`/`ACCEPTED`/
  `BLOCKED`): a `PENDING` row is a request, an `ACCEPTED` friendship is stored
  in **both** directions, a `BLOCKED` row is one-directional. Indexed
  `([otherId, status])` for the "requests to me" query. The file backend keeps
  the same graph in `friends.json`. Served over the lobby via `friends` /
  `friendReq` / `friendResp` / `friendRemove` / `friendBlock`.
- **Profile** — the vanity layer (Phase 2), 1:1 with an account: a short `bio`
  and an `equipped` loadout (JSON, `{ nameplate?, title? }`). Only these two
  fields are stored; cosmetic **ownership is a derived projection** of
  progression (`shared/cosmetics.js`), never persisted, so the locker is always
  in sync with what you've earned. The file backend keeps the same in
  `profiles.json`. Served over the lobby via `profile` (own locker, or another
  player's public card) / `setProfile` (equip requests are sanitized against
  derived ownership, so an untrusted client can only wear what it's earned).
- **Ban** — a moderation hold on an account (Phase 3), 1:1 with an account:
  `reason`, `by` (admin username), and `until` (null = permanent). Enforced
  **server-side** at login and session resume; the file backend keeps the same
  in `bans.json`. Admins are configured by `ADMIN_USERS` (comma-separated
  usernames), and served over the lobby via admin-gated `mod` / `ban` / `unban`.
- **Report** — a player flags another account for review (Phase 3). One OPEN
  report per `@@unique([reporterId, targetId])` (re-reporting updates it); an
  admin resolves or dismisses (`ReportStatus`), optionally issuing a `Ban`. Any
  signed-in player files one (`report`); the queue + triage are admin-gated
  (`reportResolve`). The file backend keeps the same in `reports.json`.
- **Flag** — an anti-cheat anomaly flag on an account (Phase 3), 1:1: the
  scorer (`server/anticheat.js`) records one when a player's weighted anomaly
  score (rate-limit hits, rejected commands, permission violations, hash
  divergence) crosses `ANTICHEAT_FLAG_SCORE`. `count` tracks repeats; latest
  reason/score/room win. **Score, don't auto-ban** — flags surface in the
  admin queue for a human decision. The file backend keeps the same in
  `flags.json`.
- **Stat** — time-series counters, one row per `(account, key, recordedAt)`.
  A periodic sampler (`server/stats.js`, every `STAT_SAMPLE_MIN` minutes;
  `0` disables it) records one point per metric — `net_worth`, `entities`,
  `tech`, `xp`, `level` — for every account active in a live room, taken from
  the same progression aggregate. Each metric is trimmed to the newest
  `STAT_KEEP` points (default 168, ~a week of hourly) so storage stays bounded;
  the file backend keeps them in `stats.json`. A player's first `stats` request
  seeds one point so a returning player sees their standing immediately.

The authoritative truth always lives in `World.snapshot`; `Factory` and
`Progression` are derived projections for cheap queries (guidelines DB-6) —
never a second source of truth. **Achievements** and **cosmetic ownership** are
likewise derived — pure functions of the progression summary
(`shared/achievements.js`, `shared/cosmetics.js`), computed on demand, so there
is no separate write path; only the player's chosen loadout + bio (`Profile`)
are stored. **AchievementUnlock** is a small *notification ledger* — one row per
`@@unique([accountId, key])` recording which unlocks have been **announced** (so
the server can surface newly-crossed ones exactly once); it is bookkeeping, not
a source of truth for whether an achievement is unlocked, which stays derived.
The file backend keeps the same in `achievements.json`.

## Leaderboard

Every save writes a small derived projection alongside the snapshot
(`server/simulation/room.js` `projection()`: entities, net worth, tech count,
tick). The store exposes `topFactories(limit)` on **both** backends — the file
backend scans save metadata; Postgres queries the `Factory` table (upserted on
save) joined to `World`/`Account` for the world name and owner. The lobby serves
it publicly via the `leaderboard` message, and the client renders it in the
lobby (own worlds highlighted).

## Read replicas ([DB-9])

Set an optional `DATABASE_REPLICA_URL` to scale reads. `server/database/replica.js`
classifies every query: **writes and authorization reads (accounts, membership,
bans) always use the primary**, while **lag-tolerant listing/analytics reads
(leaderboard, "my worlds", stats history) use the replica**. The safety rule is
that an access-control check is never served from an eventually-consistent
replica, so revoked access can't be granted by stale data. With no replica URL
set, every query uses the primary and the deploy is unchanged. A replica outage
is non-fatal — those reads degrade while the primary keeps serving.

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
continuity, the **Factory leaderboard projection**, persistent **WorldMember**
membership (merged My Worlds + member revive access), cross-world
**Progression** (level / xp / unlocked tech), and **Stat** time-series (periodic
sampling of each active account's metrics). The persistent metagame modelled in
`schema.prisma` is now fully implemented on both backends.
