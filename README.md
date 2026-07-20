# Gearworks — Factory Empire

A Factorio-inspired factory automation game that runs in the browser — with
**server-authoritative deterministic-lockstep multiplayer** and a fully
offline singleplayer mode. No frameworks, no build step, no npm installs:
plain HTML/JS on the client and a zero-dependency Node server.

## Play

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
| `client/game.js` | Rendering, input, UI, audio, game controller |
| `client/net.js` | Networking layer (local + networked sessions) |
| `server/server.js` | Zero-dependency dedicated server |
| `docs/MULTIPLAYER.md` | Architecture, protocol, deployment, testing |

See **[docs/MULTIPLAYER.md](docs/MULTIPLAYER.md)** for the full architecture
write-up, protocol reference, dedicated-server deployment (systemd example),
and multi-client testing instructions.

## Controls

Drag to pan • pinch/scroll to zoom • tap a tool, then tap the map •
**R** rotate • **C** copy • **Z/Y** undo/redo • **X** delete mode •
**B** blueprints • **Esc** cancel
