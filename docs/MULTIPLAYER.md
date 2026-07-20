# Gearworks Multiplayer — Architecture & Operations

Gearworks is a Factorio-style factory sim that runs the **same deterministic
simulation on the server and on every client**. Multiplayer is built on
**server-authoritative deterministic lockstep** — the architecture used by
Factorio itself, and the only one that scales to a factory game where tens of
thousands of belt items change every tick (per-entity snapshot replication
would drown any connection; replicating *commands* costs bytes).

```
┌────────────┐   commands    ┌──────────────────────────┐
│  Client A  │ ─────────────▶│        SERVER            │
│ (sim+render)│◀───────────── │  • validates every cmd   │
└────────────┘  tick stream   │  • orders them into ticks│
┌────────────┐               │  • runs the same sim     │
│  Client B  │ ◀───────────▶ │  • NPC AI decisions      │
│ (sim+render)│               │  • snapshots + hashes    │
└────────────┘               │  • saves + permissions   │
                             └──────────────────────────┘
```

## File layout

| Path | Role |
|---|---|
| `shared/core.js` | Deterministic simulation core (world gen, entities, belts, fluids, power, economy, research, NPC state, **Command system**, snapshots, state hash). UMD: loads in browser and Node. |
| `server/` | Dedicated server. **Zero required dependencies** — inline RFC 6455 WebSocket + HTTP static serving. Modular: `network/` (transport, HTTP), `simulation/room.js` (authoritative tick loop, validation), `players/` (sessions, lobby), `world/registry.js` (rooms), `database/` (file default \| optional Postgres). See [ARCHITECTURE.md](ARCHITECTURE.md). |
| `client/game.js` | Rendering, input (mouse + multitouch), UI/HUD, audio, particles, blueprints, and the game controller that turns player intent into commands. |
| `client/net.js` | Networking layer: `LocalSession` (singleplayer) and `NetSession` (multiplayer) with identical interfaces. |
| `index.html` | Client shell: CSS, DOM, main menu, lobby, reconnect dialog. Still works fully offline (`file://`) for singleplayer. |

## Why clients can never decide game state

1. **Every mutation is a command.** The client UI never touches the sim; it
   submits `{t:'place', …}`, `{t:'research', …}`, etc. In singleplayer the
   `LocalSession` validates and applies them locally (the client *is* the
   server); in multiplayer they go to the dedicated server.
2. **The server validates against its own state** — funds, tech gates,
   occupancy, terrain rules, recipe validity, quantity bounds, role
   permissions, and a 100 cmd/s rate limit. Only accepted commands enter the
   ordered tick stream; rejected ones bounce back with a reason.
3. **Identity is stamped server-side.** A client cannot forge who issued a
   command, cannot issue server-only commands (`ai`), and admin commands
   (weather, day length, kick, promote) are role-gated on the server.
4. **Divergence is detected and corrected.** Every 100 ticks the server
   broadcasts its state hash; clients hash their own state and report back.
   Any mismatch triggers an authoritative gzip'd snapshot resync of that
   client. A hacked client can only corrupt *its own view*, and only until
   the next audit (≤5 s).

This closes the requested attack surface: no duplicated items (single
authoritative economy; undo is re-validated commands, not state rollback), no
impossible placements (server re-checks terrain/occupancy/tech), no invalid
inventories or market manipulation (quantity/funds validated), no simulation
injection (`ai` is server-only), no client-authority exploits (clients only
ever send *requests*).

## Determinism

Given the same seed and command stream, every instance computes identical
state. The specific hazards and their fixes:

| Hazard | Fix |
|---|---|
| `Math.random()` in the sim (power brownouts) | Seeded mulberry32 stream inside the core; its 32-bit state is carried in snapshots |
| `Math.sin` differs across JS engines | `Util.dsin` — Bhaskara approximation, arithmetic only, used for solar/wind curves |
| Wall-clock time | All time derives from the tick counter (`tick/20`); day/night, economy cadence, AI cadence are tick-scheduled |
| NPC randomness | AI *decisions* run only on the server (`aiThink`) and travel as ordered `ai` commands; clients apply them deterministically |
| Map iteration order | All Maps are populated only through the ordered command stream / snapshot order, so insertion order — and therefore iteration order — is identical everywhere |
| Mid-craft state lost on join | Snapshots carry every state-affecting entity field (progress, crafting flags, buffered items, splitter phase, RNG state) |
| Visual effects inside the sim | Particles/sounds are surfaced through `hooks.fx` — no-ops on the server, client-random on clients, never state-affecting |

Weather is part of synced state and changes only via (admin-gated) commands.

## Synchronization & bandwidth

* **Terrain/chunks cost zero bandwidth** — the world is procedurally generated
  from the seed on each client; only deltas (mined-out ore) travel inside
  snapshots. Chunks generate on demand as cameras (or the sim) touch them.
* **The tick stream is the delta compression.** A tick with activity is
  `{t:'tk', n, c:[commands]}` — tens of bytes. Idle ticks are coalesced into a
  heartbeat every 5 ticks (`{t:'tks', n}`), so a quiet 10,000-entity factory
  costs ~4 tiny messages/second regardless of size.
* **Snapshots** (join / reconnect / resync) are the only large payloads:
  gzip'd server-side (`DecompressionStream` client-side, raw-JSON fallback
  negotiated in `hello`).
* **Reliable vs lossy channels:** everything rides one WebSocket (TCP), but
  the protocol distinguishes logical channels — sim traffic is reliable and
  ordered; cursor/view/pong traffic goes through `sendLossy`, which drops
  frames when the socket back-pressures (stale cursor data is worthless).
* **Interest management:** clients report their camera rect (2 Hz, lossy);
  the server relays only cursors within ~3× the viewer's viewport, at 10 Hz,
  coalesced.

## Latency handling

* **Client prediction:** placements/removals render instantly as translucent
  "ghosts" tagged with the command sequence number.
* **Server reconciliation:** the `applied` echo (or a `rej` with a reason)
  clears the ghost; a rejected ghost simply vanishes with a toast — no
  rollback needed because prediction never touched the sim.
* Rendering is decoupled (60 fps) from the 20 Hz tick stream; remote cursors
  interpolate between updates. At 100–200 ms RTT building feels immediate
  because the ghost appears at input time.

## Players, roles, lifecycle

* **Roles:** `host` (room creator; full control, migrates to the oldest
  connection if the host leaves) → `admin` (kick, weather/day length, saves,
  autosave config) → `player` (build/trade/research) → `spectator`
  (watch + visible cursor only; every sim command refused server-side).
* **Join/leave/reconnect:** joining streams a snapshot; leaving broadcasts
  presence; an unexpected drop keeps the session server-side — the client
  auto-reconnects with exponential backoff (1s→10s, 10 attempts) using its
  session token and resumes with role intact and a fresh snapshot.
* **Co-op safety:** undo/redo are per-player stacks of *inverse commands*
  (place→remove, remove→restore, paste→removeMany). They re-enter the normal
  validation pipeline, so undoing something another player already changed is
  safely rejected instead of corrupting the world.
* NPC competitors, market, research, weather, day/night are identical for
  all players by construction (same command stream).

## Saves

Server-side only — players never own the world file:
* autosave (default 60 s, host/admin configurable 15–600 s),
* manual save (host/admin, from Settings),
* rotating backups (`<code>.json.bak1..bak5`),
* save-on-shutdown (SIGINT) and save-on-room-close.

Singleplayer keeps the classic local save (localStorage + file export/import)
using the same snapshot format.

---

# Running locally

```bash
node server/server.js            # http://localhost:8080
# options: --port 8080  --save-dir saves  --load saves/ROOMCODE.json
```

Open `http://localhost:8080` in a browser → **Multiplayer** → Create Game.
Other players on your network join via `ws://<your-ip>:8080` and the 6-letter
invite code (or the public room browser).

Singleplayer needs no server at all: open `index.html` directly.

# Deploying a dedicated server

Requirements: Node ≥ 16. No npm install — the server has zero dependencies.

```bash
git clone <repo> gearworks && cd gearworks
node server/server.js --port 8080 --save-dir /var/lib/gearworks
```

**systemd unit** (`/etc/systemd/system/gearworks.service`):

```ini
[Unit]
Description=Gearworks dedicated server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/gearworks/server/server.js --port 8080 --save-dir /var/lib/gearworks
Restart=always
User=gearworks

[Install]
WantedBy=multi-user.target
```

SIGINT/systemd stop saves every room. To resume a world after a restart:
`--load /var/lib/gearworks/<CODE>.json` (keeps the same invite code).

**TLS / reverse proxy:** terminate TLS at nginx/caddy and proxy WebSocket
upgrades; clients then use `wss://your.domain` in the lobby's Server field.
`GET /health` returns `{ok, rooms}` for monitoring.

# Testing with multiple clients

1. Start the server, open two browser windows (use a private window or a
   second profile so localStorage prefs don't collide).
2. Window 1: Multiplayer → name + color → Create Game. Note the invite code
   (Players panel 👥 shows it any time — tap to copy).
3. Window 2: Multiplayer → enter the code → Join (tick "spectator" to test
   the read-only role).
4. Verify: building in one window appears in the other (~100 ms); cursors are
   name-tagged; the Players panel shows roles; Statistics shows the same tick
   and identical values in both windows.
5. Latency: DevTools → Network → throttling (e.g. "Slow 4G") on one window —
   ghosts keep building responsive; the sim stays in lockstep.
6. Divergence drill: in one window's console run `Sess.requestResync()` — the
   server streams a fresh authoritative snapshot. (Automatic resync triggers
   on hash mismatch every 100 ticks; the server logs `DIVERGENCE` if a client
   ever drifts.)
7. Reconnect drill: `Sess._debugDrop()` in the console simulates a network
   drop — the reconnect dialog appears and the session resumes with the same
   role.

An automated version of all of the above (3 headless clients, 24 assertions:
sync both ways, hash equality, spectator/cheat rejection, undo propagation,
promotion, saves + backups, reconnection) lives in the session test script
used during development.

# Protocol reference (JSON over WebSocket)

Client → server: `hello{proto,name,color,gz}` · `listRooms` ·
`create{roomName,public,maxPlayers,spectate,seed?}` · `join{code,spectate}` ·
`rejoin{token}` · `cmd{q,cmd}` · `cur{x,y}`ᴸ · `view{r}`ᴸ · `ping{ts}`ᴸ ·
`hashReport{n,h}` · `resync` · `save` · `adm{op,id,role}` · `setAutosave{v}`

Server → client: `lobby{rooms}` · `welcome{id,token,code,name,role,players,autosaveSec}` ·
`snap{why,tick,gz|raw}` · `tk{n,c}` · `tks{n}` · `hash{n,h}` · `rej{q,reason}` ·
`cur{p}`ᴸ · `pong{ts,tick}`ᴸ · `pjoin{p}` · `pleave{id}` · `prole{id,role}` ·
`roomcfg` · `saved{by}` · `kicked` · `err{reason}`

ᴸ = lossy channel (coalesced, dropped under back-pressure).

Sim commands (inside `cmd`): `place` `remove` `removeMany` `restore` `rotate`
`setRecipe` `collect` `paste` `research` `sell` `buy` `setWeather`ᴬ
`setDayLen`ᴬ `ai`ˢ — ᴬ admin+, ˢ server-only.

# Performance envelope

* 20 Hz fixed simulation, drift-corrected on the server; rendering
  independent at 60 fps with viewport culling and pooled particles.
* 8–16 players per room (configurable cap), 32 rooms per process.
* Idle bandwidth ~4 heartbeat messages/s per client (~100 B/s); active
  building costs bytes per action. Snapshots: a mid-size factory gzips to a
  few tens of KB, sent only on join/reconnect/resync.
* The infinite world costs no sync — each instance generates identical
  chunks from the seed on demand.
