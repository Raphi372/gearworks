# Gearworks — Free Deployment Guide ($0/month)

This is a complete, beginner-friendly walkthrough to make **Gearworks publicly
playable worldwide for $0/month**. Follow it top to bottom. Every step tells you
**what** to do, **why**, the **exact command**, the **expected output**, and
**what to do if it fails**.

You do **not** need Docker, Fly.io, a credit card, or any paid service.

## The architecture you're building

```
                 Players (anywhere in the world)
                              │  https / wss
                              ▼
                   Cloudflare Pages  ── free CDN + HTTPS
                   (the game client)
                              │  wss://
                              ▼
                 Cloudflare Tunnel  ── free, no open ports
                              │
                              ▼
              Gearworks server on YOUR Mac  ── free
              (Node.js, PM2, auto-restart)
                              │
                              ▼
              Neon PostgreSQL (free tier)  ── optional
              (accounts + persistent worlds)
```

- **Frontend** (the game you see): served by **Cloudflare Pages** — global CDN,
  automatic HTTPS, unlimited bandwidth, free forever.
- **Backend** (the authoritative multiplayer server): runs on **your Mac** and is
  exposed to the internet by a **Cloudflare Tunnel**. No router config, no open
  ports, automatic `wss://` (secure WebSockets).
- **Database**: **Neon PostgreSQL** free tier for accounts and worlds. *Optional*
  — see the honesty note in [Phase 3](#phase-3--database-neon-postgresql).

### The one honest caveat, up front

Self-hosting on your Mac is genuinely $0/month, but it has **one** real
trade-off: **your Mac has to be powered on and awake for people to play.** That's
the price of "free" — you're the host. [Phase 5](#phase-5--production-configuration)
shows how to keep it awake reliably, and the [Limitations](#limitations--honest-tradeoffs-and-fixes)
section lists cheap always-on alternatives (an old laptop, a Raspberry Pi) if you
outgrow the Mac. **Nothing in this guide requires a monthly payment.**

The only thing that *can* cost money is an optional **custom domain** (~$10/yr) if
you want a stable, pretty URL like `play.yourgame.com`. You can skip it entirely
and stay at literal $0 with a Quick Tunnel (random URL) or a free subdomain — both
covered below.

---

## Accounts you'll create (all free, no card)

| Service | What for | Cost | Card required? |
|---|---|---|---|
| **GitHub** | You already have this (the repo) | Free | No |
| **Cloudflare** | Tunnel (backend) + Pages (frontend) | Free | No |
| **Neon** | PostgreSQL database (optional) | Free tier | No |

Create the Cloudflare and Neon accounts now (email + password, or "Sign in with
GitHub"). Neither asks for payment details on the free tier.

---

## Phase 1 — Prepare your Mac as a free server

Goal: run the Gearworks server on your Mac in a crash-proof "production" mode.

### 1.1 Install Homebrew (the macOS package manager)

**Why:** the easiest way to install Node, git, and cloudflared on a Mac.

**Check first — you may already have it:**
```bash
brew --version
```
- If you see `Homebrew 4.x.x`, skip to 1.2.
- If you see `command not found`, install it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
**Expected:** it prints progress and ends with "Installation successful!". On
Apple-Silicon Macs it may tell you to run two `echo ... >> ~/.zprofile` commands
to "add Homebrew to your PATH" — **copy-paste and run exactly those two lines it
prints**, then close and reopen Terminal.

**If it fails:** the usual cause is missing Xcode command-line tools. Run
`xcode-select --install`, click through the installer, then re-run the Homebrew
command.

### 1.2 Install Node.js and git

**Why:** the server runs on Node.js (v18+). git is how you get and update the code.

```bash
brew install node git
```
**Verify:**
```bash
node --version    # expect v18.x or higher (v20/v22 are great)
git --version     # expect git version 2.x
```
**If `node --version` shows below v18:** run `brew upgrade node`, then re-check.

### 1.3 Get the code

**Why:** you need a local copy of the repository to run the server.

```bash
cd ~
git clone https://github.com/Raphi372/gearworks.git
cd gearworks
```
**Expected:** a `gearworks` folder appears and you're inside it. Confirm with
`ls` — you should see `server/`, `client/`, `package.json`, `ecosystem.config.js`.

> Already have the folder? Just `cd ~/gearworks && git pull` to get the latest.

**If clone fails with a permission error:** the repo may be private. Use the
GitHub-authenticated URL or the `gh` CLI (`gh repo clone Raphi372/gearworks`),
or download the ZIP from GitHub and unzip it.

### 1.4 Install dependencies

**Why:** the *runtime* needs nothing, but installing sets up the optional
database client and dev tools cleanly.

```bash
npm install
```
**Expected:** finishes in a few seconds with something like `added N packages`.
Warnings are fine. The game server itself has **zero required dependencies**, so
even if this hiccups, `node server/server.js` still runs.

### 1.5 Create your environment file

**Why:** secrets (like the key that signs login sessions) belong in a local
`.env` file, never in code. The server auto-loads `.env` — no extra tools.

```bash
cp .env.example .env
```

Now generate a **stable auth secret** (so logins survive restarts) and append it:
```bash
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
```
**Expected:** no output. Verify it landed:
```bash
grep AUTH_SECRET .env
```
You should see `AUTH_SECRET=` followed by 64 hex characters.

> Open `.env` in a text editor (`open -e .env`) any time to change settings.
> `.env` is gitignored — it will never be committed. **Never share it.**

### 1.6 Start the server locally and test it

**Why:** prove it works on `localhost` before exposing it to the world.

```bash
npm start
```
**Expected:** a log line like:
```
[timestamp] Gearworks server listening {"host":"0.0.0.0","port":8080,...}
```
Now open **http://localhost:8080** in your browser — you should see the Gearworks
main menu. Click **Multiplayer**, create a game, and confirm it loads.

**Test multiplayer locally with two "players":** open a **second** browser tab (or
a private/incognito window) to the same `http://localhost:8080`, click
Multiplayer, and **Join** using the 6-character invite code shown in the first
tab. Place a building in one tab — it appears in the other. That's real
server-authoritative multiplayer running on your Mac.

**Health check** (in a second Terminal tab):
```bash
curl http://localhost:8080/health
```
**Expected:** `{"ok":true,"uptime":...,"rooms":...,"sessions":...}`

Press **Ctrl-C** in the server terminal to stop it. You'll see it save rooms and
exit cleanly.

**If port 8080 is already in use** (`EADDRINUSE`): another program has it. Run on
a different port: `PORT=8090 npm start` (and use `:8090` in the browser). You'll
set the real port for public play in Phase 2.

### 1.7 Run it in production mode with PM2 (auto-restart + logging)

**Why:** `npm start` stops the moment you close Terminal or the server crashes.
**PM2** is a free process manager that keeps it running, restarts it on crash,
captures logs, and can relaunch it after a reboot.

Install PM2 globally:
```bash
npm install -g pm2
```
**If this fails with a permissions/EACCES error:** run `sudo npm install -g pm2`.

Start Gearworks under PM2 using the config already in the repo:
```bash
pm2 start ecosystem.config.js
```
**Expected:** a table showing `gearworks` with status **online**.

The bundled `ecosystem.config.js` gives you, for free:
- **auto-restart on crash** (with crash-loop protection so it won't spin forever),
- a **memory guard** (recycles the process if it ever leaks past ~450 MB),
- **loopback binding** (`HOST=127.0.0.1`) so only the Cloudflare Tunnel can reach
  it — it is *not* exposed to your local network,
- **logs** written to `./logs/`.

Useful PM2 commands (also available as `npm run pm2:*`):
```bash
pm2 logs gearworks     # live logs (Ctrl-C to stop watching)
pm2 status             # is it online? how many restarts?
pm2 restart gearworks  # restart (e.g. after changing .env)
pm2 stop gearworks     # stop it
```

**Make it survive a Mac reboot** (crash recovery across power loss):
```bash
pm2 startup            # prints ONE sudo command — copy, paste, and run it
pm2 save               # remember the currently-running apps
```
**Expected:** after `pm2 startup` you run the sudo line it gives you; `pm2 save`
prints "Successfully saved". Now if your Mac restarts, Gearworks comes back
automatically.

**Add log rotation** (so logs don't grow forever — still free):
```bash
pm2 install pm2-logrotate
```

**Confirm health under PM2:**
```bash
curl http://localhost:8080/health
```
Expected: `{"ok":true,...}`. Your server is now production-grade on your Mac. Next,
put it on the internet.

---

## Phase 2 — Make your server public with Cloudflare Tunnel

Goal: give your local server a public, HTTPS/`wss://` address — **without opening
any ports on your router**. This replaces Fly.io.

**Why a tunnel (and not port-forwarding)?** A Cloudflare Tunnel makes an
*outbound* connection from your Mac to Cloudflare's edge, and Cloudflare routes
public traffic back down it. Your home IP stays hidden, there's nothing to
configure on your router, and you get automatic TLS (so browsers get the secure
`wss://` they require).

### 2.1 Install cloudflared

```bash
brew install cloudflared
```
**Verify:**
```bash
cloudflared --version    # expect: cloudflared version 2024.x.x ...
```

You now choose **one** of two paths:

- **Path A — Quick Tunnel:** zero setup, literally $0, **no account or domain
  needed**. The catch: the URL is random and **changes every time you restart the
  tunnel**. Perfect for testing and for playing with friends today.
- **Path B — Named Tunnel:** a **stable** URL that never changes, so your
  Cloudflare Pages site can permanently point at it. Needs a free Cloudflare
  account and a domain on Cloudflare (a domain costs ~$10/yr, or use a free
  subdomain — see 2.4). This is the "real launch" path.

Start with A to prove it works in 60 seconds, then move to B for a permanent URL.

### 2.2 Path A — Quick Tunnel (instant, no account)

With your server running (Phase 1.7), open a **new** Terminal tab and run:
```bash
cloudflared tunnel --url http://localhost:8080
```
**Expected:** a banner appears containing a line like:
```
+--------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:      |
|  https://random-words-here.trycloudflare.com           |
+--------------------------------------------------------+
```
**Test it now:** open `https://random-words-here.trycloudflare.com/health` in a
browser — you should see `{"ok":true,...}`. Your Mac's server is now reachable
from anywhere on Earth.

To use it in the game, the WebSocket address is the same URL with `wss://`:
`wss://random-words-here.trycloudflare.com`. You can paste that into the
**Server** field of the game lobby right now (from any device, anywhere) and
play. Keep this Terminal tab open — closing it closes the tunnel.

**If you see `failed to connect to origin`:** your Gearworks server isn't running
or is on a different port. Confirm `pm2 status` shows it online and that it's on
port 8080 (`curl http://localhost:8080/health`).

Great for testing — but because the URL changes on every restart, move to Path B
for anything permanent.

### 2.3 Path B — Named Tunnel (stable URL)

**Why:** a named tunnel keeps the **same** hostname forever, so your public
frontend can hard-wire it and players never have to type an address.

**Step 1 — log in** (opens your browser to authorize):
```bash
cloudflared tunnel login
```
**Expected:** a browser window opens; pick your domain (or add one — see 2.4),
click **Authorize**. Terminal prints `You have successfully logged in` and saves a
certificate to `~/.cloudflared/cert.pem`.

**Step 2 — create the tunnel:**
```bash
cloudflared tunnel create gearworks
```
**Expected:**
```
Created tunnel gearworks with id  1234abcd-....
Credentials written to /Users/you/.cloudflared/1234abcd-....json
```
**Copy that UUID and the credentials path** — you need them next.

**Step 3 — route a hostname to the tunnel** (replace with your domain):
```bash
cloudflared tunnel route dns gearworks play.YOURDOMAIN.com
```
**Expected:** `Added CNAME play.YOURDOMAIN.com which will route to this tunnel`.

**Step 4 — write the tunnel config.** The repo ships a template at
`cloudflared/config.example.yml`. Copy it into place and edit the two
placeholders:
```bash
cp ~/gearworks/cloudflared/config.example.yml ~/.cloudflared/config.yml
open -e ~/.cloudflared/config.yml
```
Set:
- `tunnel:` → your UUID from Step 2,
- `credentials-file:` → the JSON path from Step 2,
- `hostname:` → `play.YOURDOMAIN.com`.

**Step 5 — run the tunnel:**
```bash
cloudflared tunnel run gearworks
```
**Expected:** log lines ending with `Registered tunnel connection` (usually 4
connections to nearby Cloudflare data centers). Test:
`https://play.YOURDOMAIN.com/health` → `{"ok":true,...}`.

**Step 6 — run the tunnel as a background service** (so it starts on boot, like
PM2 does for the server):
```bash
sudo cloudflared service install
```
**Expected:** it installs a launchd service that runs your `~/.cloudflared/config.yml`
automatically. Now both the server (PM2) and the tunnel (cloudflared service)
survive reboots. Your permanent WebSocket address is **`wss://play.YOURDOMAIN.com`**.

### 2.4 No domain? Two free ways to still get a stable URL

A named tunnel needs a domain **on Cloudflare**. If you don't own one:

1. **Free subdomain providers.** Services like **[js.org](https://js.org)**,
   **[is-a.dev](https://is-a.dev)**, or **[eu.org](https://nic.eu.org)** grant
   free subdomains. Add the domain to Cloudflare (free plan), then use it in Step
   3. Availability and rules vary per provider.
2. **A cheap domain.** A `.com`/`.xyz` is often ~$10/year — the *only* possible
   cost in this whole guide, and entirely optional. Register it, add it to
   Cloudflare's **free** plan, done.

If you want to stay at literal $0 and don't mind the random URL, **stick with the
Quick Tunnel (Path A)** — see the [Limitations](#limitations--honest-tradeoffs-and-fixes)
section for how to make even that workable for the frontend.

---

## Phase 3 — Database (Neon PostgreSQL)

Goal: store accounts, worlds, and factory progress in a managed free database.

> **Honest note first.** For a single self-hosted Mac, the **default `file`
> backend already persists everything for free** — worlds are saved to
> `~/gearworks/saves/*.json` with rotating backups, and accounts to
> `accounts.json`. You do **not** need a database to have persistent accounts and
> worlds on one machine. **Neon becomes worthwhile when** you want cloud-durable
> data (survives a disk failure), or you later move the server off your Mac to a
> stateless host. If you just want to launch, you can **skip this phase** and come
> back. It's included because your target architecture calls for it and it's a
> clean upgrade.

### 3.1 Create a Neon account and database

**Why:** Neon gives a free, always-available Postgres with no credit card.

1. Go to **[neon.tech](https://neon.tech)** → **Sign up** (GitHub login works).
2. Click **Create project**. Name it `gearworks`, keep the default region closest
   to you, and create it.
3. On the project dashboard, find **Connection string** (a.k.a. "Connection
   Details"). Choose the **Pooled connection** and copy it. It looks like:
   ```
   postgresql://user:password@ep-xxxx-pooler.us-east-2.aws.neon.tech/gearworks?sslmode=require
   ```
**Expected:** you now have a `postgresql://...` string. Treat it like a password.

### 3.2 Point Gearworks at Neon

**Why:** two env vars switch the server from file storage to Postgres.

Edit your `.env` (`open -e ~/gearworks/.env`) and set:
```
STORAGE=postgres
DATABASE_URL=postgresql://user:password@ep-xxxx-pooler.us-east-2.aws.neon.tech/gearworks?sslmode=require
```
(Use *your* exact string. Keep `?sslmode=require`.)

### 3.3 Create the tables (run migrations)

**Why:** this creates the `Account`, `World`, etc. tables from the Prisma schema
already in the repo.

```bash
cd ~/gearworks
npm install          # ensures the Prisma client is present
npm run db:generate  # generate the DB client from prisma/schema.prisma
npm run db:migrate   # create the tables in Neon
```
**Expected:** `db:migrate` prints that it applied the migration in
`prisma/migrations/0001_init` and ends with something like "All migrations have
been successfully applied."

**Test the connection** by restarting the server on the Postgres backend:
```bash
pm2 restart gearworks
pm2 logs gearworks --lines 20
```
**Expected:** a startup log mentioning the **postgres** backend (not "file
backend"), and no connection errors.

**If migration fails with a TLS/SSL or auth error:** re-copy the connection
string (it's easy to miss a character), keep `?sslmode=require`, and make sure you
used the **pooled** string. If it says the client isn't installed, run
`npm install @prisma/client` then retry `npm run db:generate`.

### 3.4 What now persists

- **Player accounts** (register / log in / guest) — passwords hashed with scrypt.
- **Saved worlds**, owned by the account that created them ("My Worlds" → Resume).
- **Factory state** inside each world snapshot.

All of this already existed in the code; you just moved its storage to Neon.

---

## Phase 4 — Frontend deployment (Cloudflare Pages)

Goal: host the game client on Cloudflare's global CDN with HTTPS, and make it
auto-connect to your tunnel.

**Why Pages and not just serve from the Mac?** The client is static files
(HTML/JS). Putting them on Cloudflare's CDN means they load fast worldwide, your
Mac only handles the lightweight game WebSocket, and the site stays up even while
you restart the server.

### 4.1 Connect the repo to Cloudflare Pages

1. In the **Cloudflare dashboard** → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**.
2. Authorize GitHub and select the **`gearworks`** repository.
3. **Build settings:**
   - **Framework preset:** `None`
   - **Build command:** `npm run build:client`
   - **Build output directory:** `dist`
4. **Environment variables** → **Add variable** (this is the magic that makes the
   site auto-point at your backend):
   - **Name:** `BACKEND_URL`
   - **Value:** your tunnel address, e.g. `https://play.YOURDOMAIN.com`
     (use `https://`, not `wss://` — the build converts it automatically).
5. Click **Save and Deploy**.

**Expected:** Cloudflare runs the build (you'll see `built client -> dist/` and
`injected default server -> wss://play.YOURDOMAIN.com` in the build log) and gives
you a live URL like `https://gearworks.pages.dev`.

**How the auto-connect works:** the build step (`scripts/build-client.js`) reads
`BACKEND_URL` and bakes it into `client/config.js`, so the lobby's **Server**
field is pre-filled with your tunnel. Players don't type anything.

**If the build fails** with "command not found":** double-check the build command
is exactly `npm run build:client` and output directory is `dist`. If it complains
about Node version, add an env var `NODE_VERSION` = `20`.

### 4.2 Test the game online

1. Open your `https://gearworks.pages.dev` URL (or your Pages custom domain).
2. Click **Multiplayer**. The **Server** field should already show
   `wss://play.YOURDOMAIN.com`.
3. **Create** a game. It should connect and load — you're now playing over the
   internet, client on Cloudflare, server on your Mac.

**If it won't connect:** confirm (a) your server is online (`pm2 status`), (b)
your tunnel is running (`cloudflared tunnel run gearworks`, or the service is
installed), and (c) `https://play.YOURDOMAIN.com/health` returns ok in a browser.
Browsers block `ws://` from an `https://` page — the address **must** be `wss://`
(it is, automatically, via the tunnel's TLS).

> **Using a Quick Tunnel (no domain)?** Set `BACKEND_URL` to the current
> `https://xxxx.trycloudflare.com` and redeploy (Pages → Deployments →
> **Retry deployment**) whenever the tunnel URL changes. Or leave `BACKEND_URL`
> unset and have players paste the current URL into the Server field — the field
> exists for exactly this.

### 4.3 (Optional) Auto-deploy on every push

Every time you `git push` to `main`, Cloudflare Pages rebuilds and redeploys
automatically — no action needed. (The repo also contains a
`.github/workflows/frontend-deploy.yml` GitHub Action as an alternative if you'd
rather deploy with an API token; the dashboard Git integration above is simpler
and needs no secrets.)

---

## Phase 5 — Production configuration

Make the free setup reliable and safe. Most of this is already true in the code;
this phase is the checklist to confirm and the few switches to flip.

### 5.1 HTTPS and secure WebSockets — already done

Cloudflare terminates TLS at the edge for **both** Pages (the client) and the
Tunnel (the server). Players always get `https://` and `wss://`. You don't manage
any certificates. ✔

### 5.2 Environment variables and secrets

- Secrets live only in `~/gearworks/.env` (gitignored) and in the Cloudflare Pages
  env var (`BACKEND_URL`). Never commit secrets.
- **`AUTH_SECRET` must be stable** (you set it in 1.5) so logins survive restarts.
- The database URL lives only in `.env`.

### 5.3 Keep your Mac awake (the key reliability step)

**Why:** if the Mac sleeps, the tunnel drops and nobody can connect.

- **Simple:** run the server under `caffeinate` so the machine never sleeps while
  it's up. Restart your PM2 app through caffeinate:
  ```bash
  pm2 delete gearworks
  caffeinate -dis pm2 start ecosystem.config.js
  pm2 save
  ```
  Or, system-wide: **System Settings → Displays → Advanced → "Prevent automatic
  sleeping on power adapter when the display is off"**, and set **Battery/Energy**
  to never sleep on power adapter.
- Keep the lid open or use "clamshell" mode with an external power supply.

### 5.4 Rate limiting and server validation — already enforced

The server is authoritative and already ships these defaults (tune in `.env`):

| Protection | Default | Env var |
|---|---|---|
| Commands per second per client | 100 | `CMD_RATE_LIMIT` |
| Chat messages / 5s per client | 6 | `CHAT_RATE_LIMIT` |
| Max inbound frame size | 512 KB | `MAX_MSG_BYTES` |
| Max rooms per process | 32 | `MAX_ROOMS` |
| Max players per room | 16 | `MAX_PLAYERS_PER_ROOM` |
| Login attempts / 15 min / user | 8 | `LOGIN_MAX_ATTEMPTS` |

Every command is validated server-side (funds, tech, occupancy, terrain, role);
clients send *commands, never state*; periodic state-hash audits detect any
tampered client and force a resync. Chat is sanitized and length-capped. This is
covered in `docs/PRODUCTION.md` and `docs/MULTIPLAYER.md`.

### 5.5 Backups

- **File backend:** every save writes rotating backups (`.bak1`…`.bak5`) next to
  `saves/<CODE>.json`. To back up off-machine, copy the `saves/` folder anywhere
  (e.g. a scheduled `rsync` to an external drive or cloud folder — free).
- **Neon backend:** Neon includes automated backups / point-in-time restore on
  the free tier. Each world snapshot is also self-contained JSON, so
  `SELECT snapshot FROM "World"` is a complete export.

### 5.6 Logging and health

- **Logs:** `pm2 logs gearworks`, or the files in `~/gearworks/logs/`. Production
  logs are one-line JSON (easy to grep). Log rotation via `pm2-logrotate` (5.7 in
  Phase 1).
- **Health:** `https://play.YOURDOMAIN.com/health` returns
  `{ ok, uptime, rooms, sessions, version }`. Bookmark it — it's your "is it up?"
  check from any device.
- **Optional error alerts:** set `ERROR_WEBHOOK=<url>` in `.env` to POST uncaught
  errors as JSON to Sentry or your own endpoint (no SDK, no dependency).

### 5.7 Maintenance mode

To take the game down gracefully (e.g. while updating), set `MAINTENANCE=1` in
`.env` and `pm2 restart gearworks`. New games are refused and clients show a
banner; flip it back to `0` when done.

---

## Phase 6 — Launch checklist (test everything)

Run through this before sharing the link. Tick each box.

**Frontend**
- [ ] `https://gearworks.pages.dev` loads the main menu from another network
      (try your phone on cellular data, not Wi-Fi).
- [ ] The padlock (HTTPS) shows in the address bar.
- [ ] Multiplayer → **Server** field is pre-filled with your `wss://` tunnel.

**Backend**
- [ ] `pm2 status` shows `gearworks` **online**.
- [ ] `https://play.YOURDOMAIN.com/health` returns `{"ok":true,...}` in a browser.
- [ ] The tunnel is running as a service (survives a Terminal close).

**Database** (if you did Phase 3)
- [ ] Register an account in-game; log out; log back in — it works.
- [ ] Create a world, place buildings, leave; it appears under **My Worlds**;
      **Resume** restores it.
- [ ] `pm2 restart gearworks`, then Resume the world — progress is intact.

**Multiplayer**
- [ ] Two different people (or two devices on different networks) both connect.
- [ ] A building placed by one player appears for the other within a moment.
- [ ] Open **Statistics** on both — the tick counts match (state is in sync).
- [ ] One player disconnects and reconnects — they rejoin the same world.

If every box is ticked, **you're live.** Share your Pages URL.

### Quick end-to-end smoke test (copy-paste)

With the server + tunnel running:
```bash
# 1. Local server healthy?
curl -s http://localhost:8080/health
# 2. Public server healthy (through the tunnel)?
curl -s https://play.YOURDOMAIN.com/health
# 3. Frontend live?
curl -sI https://gearworks.pages.dev | head -1   # expect: HTTP/2 200
```
All three good → the full path (browser → Pages → Tunnel → Mac) works.

---

## Phase 7 — This document

This file **is** `docs/FREE_DEPLOYMENT_GUIDE.md`. Keep it as your runbook. The key
operational bits are below.

### How to restart the server
```bash
pm2 restart gearworks     # restart the game server
pm2 logs gearworks        # watch it come back up
```
Restart the tunnel (only if you didn't install it as a service):
```bash
cloudflared tunnel run gearworks
```

### How to update the game (deploy new code)
```bash
cd ~/gearworks
git pull                      # get the latest code
npm install                   # in case dependencies changed
npm run db:migrate            # only if using Postgres and the schema changed
pm2 restart gearworks         # restart the server with the new code
```
The **frontend** updates itself: pushing to `main` triggers a Cloudflare Pages
rebuild automatically. To force one, use the Pages dashboard → **Retry
deployment**.

### How to stop everything
```bash
pm2 stop gearworks                     # stop the server
sudo launchctl stop com.cloudflare.cloudflared  # stop the tunnel service
```

---

## Limitations — honest trade-offs and fixes

| Limitation | Why | Fix / mitigation |
|---|---|---|
| **Your Mac must stay on & awake** | You're the host; if it sleeps, the tunnel drops | `caffeinate` (5.3); or host on an always-on old laptop / Raspberry Pi / mini-PC — same steps, still $0 |
| **Quick Tunnel URL rotates** | `trycloudflare.com` URLs are ephemeral | Use a **Named Tunnel** (2.3) for a permanent URL; or re-set `BACKEND_URL` and redeploy Pages when it changes |
| **A stable pretty domain isn't free** | Domain registration costs money | Use a free subdomain provider (2.4), or a Quick Tunnel, or ~$10/yr for a real domain (optional) |
| **Home upload bandwidth** | Players' traffic flows through your connection | Gearworks sends *commands, not state*, so bandwidth per player is tiny — fine for dozens of players on home internet |
| **Single machine / single process** | All rooms live in one Node process | Plenty for a community game; horizontal scaling (room-router) is documented in `docs/PRODUCTION.md` if you ever need it |
| **Neon free tier limits** | 0.5 GB storage, cold-start after idle | Ample for accounts + worlds; the file backend is a zero-limit fallback for a single box |

None of these require money. The only optional paid item in the entire guide is a
vanity domain, and there are free routes around it.

---

## Cost summary

| Component | Service | Monthly cost |
|---|---|---|
| Game client (CDN + HTTPS) | Cloudflare Pages | **$0** |
| Public server access | Cloudflare Tunnel | **$0** |
| Game server compute | Your Mac | **$0** (your electricity) |
| Database | Neon free tier *(optional)* | **$0** |
| Process manager | PM2 | **$0** |
| **Total** | | **$0 / month** |

Optional one-time/annual: a custom domain (~$10/yr) if you want a stable pretty
URL and don't use a free subdomain. Everything else is free, forever, with no
card on file.

**You now have a real, publicly playable Gearworks multiplayer game running at
$0/month.**
