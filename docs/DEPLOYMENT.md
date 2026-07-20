# Deployment

Production topology:

```
              Cloudflare (DNS · CDN · HTTPS · edge security headers)
                     │
         ┌───────────┴────────────┐
         ▼                        ▼
  Cloudflare Pages          Fly.io / Railway
  (static client)  ─ wss ─▶ (authoritative game server, Docker)
                                  │
                            Postgres (optional)
                            Neon / Supabase
```

The frontend and backend deploy independently. **You provide the accounts and
secrets**; the CI pipelines are already written and stay dormant (no-op) until
the secrets exist, so nothing breaks before you're ready.

---

## Frontend — Cloudflare Pages

The client is a dependency-free static bundle. `npm run build:client` produces
`dist/` (game files + `_headers`, `_redirects`, `404.html`).

**One-time setup**
1. Create a Cloudflare Pages project named **gearworks**.
2. Add GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

After that, every push to `main` touching the client runs
`.github/workflows/frontend-deploy.yml` → builds `dist/` → `wrangler pages
deploy`. Manual alternative:

```bash
npm run build:client
npx wrangler pages deploy dist --project-name=gearworks
```

Edge security headers (CSP, HSTS, X-Frame-Options, …) come from
`public/_headers` and are applied at the CDN. The custom `404.html` is served
automatically on unknown paths.

> The existing **GitHub Pages** workflow (`pages.yml`) stays as a zero-config
> preview at `raphi372.github.io/gearworks`. Cloudflare Pages is the production
> frontend; keep whichever you prefer.

## Backend — Fly.io (or Railway)

The server ships as a Docker image (`Dockerfile`, non-root, built-in
healthcheck). `fly.toml` is preconfigured: single machine (all room state is
in memory), persistent volume at `/data` for the file backend, `/health`
checks, forced HTTPS, auto-suspend when idle.

**One-time setup**
```bash
fly launch --no-deploy           # creates the app + gearworks_data volume
fly tokens create deploy         # → add as repo secret FLY_API_TOKEN
# set a stable auth secret (required for accounts/sessions to survive restarts):
fly secrets set AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

If you also add `DATABASE_URL` as a **repo secret**, the backend deploy
workflow runs `prisma migrate deploy` before shipping — migrations are applied
safely and idempotently. With the default file backend, that step is skipped.

After that, pushes touching `server/**` run
`.github/workflows/backend-deploy.yml` → validate + test → `flyctl deploy`.
Manual alternative:

```bash
fly deploy --remote-only
```

**Railway** works equally well: point it at the repo, it detects the
Dockerfile, set the env vars from `.env.example`, add a volume at `/data`.

## Connecting the two

The client asks the player for a server address in the lobby. Point players at
your backend's public URL as `wss://` (browsers block plain `ws://` from an
HTTPS page):

- Fly: `wss://gearworks-server.fly.dev`
- Custom domain via Cloudflare: `wss://play.yourdomain.com`

## Database (optional, for the persistent metagame)

Provision Postgres (Neon or Supabase — both have generous free tiers), then set
on the backend:

```
STORAGE=postgres
DATABASE_URL=postgresql://…?sslmode=require
```

Run migrations once: `npm run db:migrate`. See [DATABASE.md](DATABASE.md).

## Verifying a deploy

- `GET https://<backend>/health` → `{"ok":true,...}`
- Open the Cloudflare Pages URL, create a game pointed at the backend, join
  from a second browser, confirm builds sync and Statistics shows equal ticks.
