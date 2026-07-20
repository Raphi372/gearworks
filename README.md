# Gearworks — Factory Empire

A Factorio-inspired factory automation game that runs in the browser — with
**server-authoritative deterministic-lockstep multiplayer** and a fully
offline singleplayer mode. No frameworks, no build step, no npm installs:
plain HTML/JS on the client and a zero-dependency Node server.

## Play

**In your browser right now:**
**https://raphi372.github.io/gearworks/** — the singleplayer client,
deployed from `main` by GitHub Actions. Runs entirely client-side; saves
live in your browser.

**Singleplayer (offline):** open `index.html` in any modern browser
(Safari on iPad, Chrome, Edge, Firefox). That's it.

**Multiplayer:**

```bash
node server/server.js          # http://localhost:8080
```

Open the URL, pick **Multiplayer**, create a game, and share the 6-letter
invite code (or let friends find it in the public room browser). Supports
8–16 players per room, spectators, reconnection, and host/admin/player
permission tiers.

> Note: the GitHub Pages site can also join multiplayer games, but because
> it is served over HTTPS the browser requires a `wss://` (TLS) server
> address — put your TLS-terminated server (see docs) in the lobby's
> Server field. Plain `ws://localhost` servers work from a local checkout.

## Features

- Infinite procedurally generated world with 7 ore types, water, and biomes
- Full logistics: conveyors, underground belts, splitters, mergers, pipes and
  fluids, power grid with solar/wind/nuclear/batteries
- Production chains from ore to advanced machines; dynamic market with
  supply & demand; 14-technology research tree in 7 tiers
- NPC competitor companies that expand, trade, and research
- Blueprint library (persistent across worlds), copy/paste, undo/redo
- Day/night cycle, weather, particles, procedural Web Audio sound
- Touch-native controls: pinch zoom, two-finger pan, long-press, drag-place
- Multiplayer: deterministic 20 Hz lockstep, command validation on an
  authoritative server, state-hash divergence auditing with auto-resync,
  prediction ghosts, interest-managed player cursors, server-side saves
  with rotating backups

## Repository layout

| Path | Role |
|---|---|
| `index.html` | Client shell: CSS, DOM, menu/lobby/reconnect UI |
| `shared/core.js` | Deterministic simulation core (browser + Node) |
| `client/game.js` · `client/net.js` | Rendering/UI/input · networking (local + networked sessions) |
| `server/` | Modular authoritative server — `network/`, `simulation/`, `players/`, `world/`, `database/` |
| `prisma/` | Optional Postgres schema + migrations |
| `public/` | Cloudflare Pages edge config (`_headers`, `_redirects`, `404.html`) |
| `scripts/` | `validate`, `test`, `build:client` |
| `docs/` | Architecture, deployment, database, production, multiplayer |

## Documentation

| Doc | What |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the three layers fit together |
| [ARCHITECTURE_REVIEW.md](docs/ARCHITECTURE_REVIEW.md) | Audit, technical debt, roadmap |
| [MULTIPLAYER.md](docs/MULTIPLAYER.md) | Protocol, determinism, security model |
| [LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) | Run & test locally |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloudflare Pages + Fly.io + Postgres |
| [FREE_DEPLOYMENT_GUIDE.md](docs/FREE_DEPLOYMENT_GUIDE.md) | **$0/month** self-host: Cloudflare Pages + Tunnel + Neon, step by step |
| [DATABASE.md](docs/DATABASE.md) | Persistence backends & schema |
| [PRODUCTION.md](docs/PRODUCTION.md) | Config, security, scaling, runbook |

## Production deployment

The client deploys to **Cloudflare Pages** and the authoritative server to
**Fly.io / Railway** (Docker), with optional **PostgreSQL** persistence — all
via secret-gated GitHub Actions. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**Want to run it publicly for $0/month?** The
[Free Deployment Guide](docs/FREE_DEPLOYMENT_GUIDE.md) is a beginner-friendly,
step-by-step walkthrough for self-hosting the server on your own machine behind a
**Cloudflare Tunnel** (no Fly.io, no paid hosting, no credit card), with the
client on Cloudflare Pages and an optional Neon PostgreSQL free-tier database.

## Controls

Drag to pan • pinch/scroll to zoom • tap a tool, then tap the map •
**R** rotate • **C** copy • **Z/Y** undo/redo • **X** delete mode •
**B** blueprints • **Esc** cancel
