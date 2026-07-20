# Local Development

Gearworks runs with **plain Node — no install required** for the default
(file) backend.

## Quick start

```bash
git clone https://github.com/Raphi372/gearworks && cd gearworks
node server/server.js            # http://localhost:8080
```

Open `http://localhost:8080`, choose **Multiplayer → Create Game**, and share
the 6-letter invite code. Other players on your network join at
`ws://<your-lan-ip>:8080` with the code.

**Singleplayer needs no server at all** — open `index.html` directly (works
from `file://`, fully offline).

## With npm scripts

```bash
npm install            # optional; only pulls the (optional) prisma tooling
npm run dev            # node server/server.js --port 8080
npm run validate       # syntax + determinism + module graph + CSP checks
npm test               # in-process integration tests (no browser)
npm run build:client   # assemble dist/ (what Cloudflare Pages serves)
```

## Configuration

Everything is env-driven (see `.env.example`); copy it to `.env` for local
overrides. Common flags:

```bash
node server/server.js --port 9000 --save-dir ./mysaves
node server/server.js --load saves/ABC123.json    # resume a saved world
```

Key variables: `PORT`, `HOST`, `STORAGE` (`file`|`postgres`), `SAVE_DIR`,
`DATABASE_URL`, `MAX_ROOMS`, `MAX_PLAYERS_PER_ROOM`. Full list in
[PRODUCTION.md](PRODUCTION.md).

## Testing multiple clients

1. Start the server, open two browser windows (use a private window so
   `localStorage` prefs don't collide).
2. Window 1: Multiplayer → set Server to `ws://localhost:8080` → Create Game.
3. Window 2: same server → enter the invite code → Join.
4. Build in one; it appears in the other within ~100 ms. The Statistics panel
   shows the same tick and identical values in both.

Throttle one window's network (DevTools → Network) to feel prediction hold up
under latency. Run `Sess._debugDrop()` in the console to simulate a drop and
watch auto-reconnect.

## Postgres backend locally (optional)

```bash
docker run -d --name gw-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
export DATABASE_URL="postgresql://postgres:dev@localhost:5432/postgres"
npm run db:generate && npm run db:migrate:dev
STORAGE=postgres node server/server.js
```

See [DATABASE.md](DATABASE.md).
