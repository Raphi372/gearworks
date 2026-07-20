# Gearworks — Architecture

How the system fits together. For the multiplayer protocol and determinism
model see [MULTIPLAYER.md](MULTIPLAYER.md); for the audit and roadmap see
[ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).

## The three layers

```
 shared/core.js      Deterministic simulation. Runs identically in the browser
   (contract)        and in Node. World gen, entities, belts/fluids/power, the
                     command validate/apply pipeline, snapshots, state hashing.

 client/             Rendering, input, UI, audio, prediction. Never mutates game
   (presentation)    state directly — every action becomes a command. Two
                     session drivers (net.js): LocalSession (singleplayer) and
                     NetSession (multiplayer), same interface.

 server/             Authoritative host. Runs the shared core for each room at
   (authority)       20 Hz, validates commands, orders them into the tick
                     stream, persists snapshots. Modular (see below).
```

The **shared core is the contract**: both client and server import the exact
same file, so given the same seed and the same ordered command stream they
compute bit-identical state. That is what makes lockstep possible and what
makes the server able to trust nothing from the client.

## Server modules

```
server/server.js            entry — wiring, boot, graceful shutdown
       config.js            env + flags → config; structured logging
       network/websocket.js RFC 6455 transport (zero dependency)
       network/httpServer.js /health + static + WS upgrade + security headers
       players/sessions.js  reconnect tokens (in-memory, global)
       players/lobby.js     pre-room handshake: hello/create/join/rejoin
       simulation/room.js   one authoritative deterministic game instance
       world/registry.js    live rooms, invite codes, public listing
       database/            persistence abstraction (file | postgres)
```

Dependency direction is strictly one-way; `simulation/room.js` receives its
store, session store, id allocator, and self-removal callback by injection, so
there is no cycle back to the registry that constructs it.

## Request/data flow

1. Browser loads the static client (Cloudflare Pages / the server's own static
   route). Singleplayer runs entirely here.
2. For multiplayer the client opens a `wss://` WebSocket to a game server and
   sends `hello` → `create`/`join`/`rejoin`.
3. The room streams an authoritative gzip snapshot, then a continuous tick
   stream. The client applies ticks in lockstep and renders at 60 fps with
   predicted ghosts for its own pending commands.
4. Player actions → commands → server validation → accepted commands enter the
   next tick → broadcast to everyone. Rejections bounce back with a reason.
5. The room autosaves snapshots to the persistence store; on `SIGTERM` every
   room writes a final save before exit.

## Why in-memory room state scales

Cost in a factory sim is proportional to **active entities**, not to connected
sockets. One process comfortably runs many rooms of thousands of entities at
20 Hz. Durability is decoupled (periodic snapshot persistence), so a crash or
deploy loses at most one autosave interval. Horizontal scale beyond one box is
a room-router in front of N identical servers — additive, because a room is a
self-contained unit (see the roadmap in ARCHITECTURE_REVIEW.md).
