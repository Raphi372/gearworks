# ============================================================================
# Gearworks dedicated server — production image for Fly.io / Railway / any host
# The game server has no required runtime dependencies; @prisma/client is only
# installed (and only used) when STORAGE=postgres.
# ============================================================================
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- dependencies (optional: prisma client for the postgres backend) ---------
FROM base AS deps
COPY package.json ./
COPY prisma ./prisma
# Install optional deps so a postgres-backed deployment has @prisma/client.
# The default (file) backend ignores these at runtime.
RUN npm install --omit=dev --include=optional && \
    (npx prisma generate || echo "prisma generate skipped (file backend)")

# --- final runtime image -----------------------------------------------------
FROM base AS runtime
# non-root user
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY prisma ./prisma
# client assets so the server can self-host (Cloudflare Pages serves them in prod)
COPY index.html ./index.html
COPY client ./client
COPY docs ./docs

# persistent volume for the file backend (mount at /data in fly.toml)
ENV SAVE_DIR=/data
RUN mkdir -p /data && chown -R app:app /data /app
USER app

EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0

# lightweight healthcheck hitting the built-in /health endpoint
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
