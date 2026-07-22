#!/usr/bin/env bash
# ============================================================================
# tunnel-up.sh — start a Cloudflare quick tunnel AND keep a GitHub Gist pointer
# updated with the current wss:// address. The hosted client fetches that gist
# (GEARWORKS_DISCOVERY_URL) on load, so every device auto-connects to whatever
# server is online right now — no re-typing when the quick-tunnel URL rotates.
#
# One-time setup (see docs/FREE_DEPLOYMENT_GUIDE.md → "Automatic discovery"):
#   1. create a secret Gist with a single file, e.g. server.txt (any contents)
#   2. create a fine-grained GitHub token with "Gists: read and write"
#   3. set Cloudflare Pages build var DISCOVERY_URL to that file's RAW gist URL
#
# Run (instead of the bare `cloudflared tunnel …`):
#   GH_TOKEN=github_pat_xxx GIST_ID=abc123 GIST_FILE=server.txt ./scripts/tunnel-up.sh
# ============================================================================
set -uo pipefail

: "${GH_TOKEN:?set GH_TOKEN (a GitHub token with Gists read/write)}"
: "${GIST_ID:?set GIST_ID (the gist to keep updated)}"
GIST_FILE="${GIST_FILE:-server.txt}"
PORT="${PORT:-8080}"

update_pointer() {
  local wss="$1" body
  body=$(printf '{"files":{"%s":{"content":"%s"}}}' "$GIST_FILE" "$wss")
  if curl -fsS -X PATCH "https://api.github.com/gists/$GIST_ID" \
       -H "Authorization: Bearer $GH_TOKEN" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" \
       -d "$body" >/dev/null; then
    echo "[tunnel-up] pointer updated -> $wss"
  else
    echo "[tunnel-up] WARNING: could not update the gist pointer" >&2
  fi
}

echo "[tunnel-up] starting quick tunnel to http://localhost:$PORT …"
last=""
# Stream cloudflared output; whenever a trycloudflare URL appears, publish its
# wss:// form to the gist so the client discovery picks it up.
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -n1 || true)
  if [ -n "${url:-}" ] && [ "$url" != "$last" ]; then
    last="$url"
    update_pointer "${url/https:/wss:}"
  fi
done
