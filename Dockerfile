# syntax=docker/dockerfile:1

###############################################################################
# base: shared runtime/OS layer
###############################################################################
FROM node:24-bookworm-slim AS base

# pnpm is installed globally so it is available in every stage. Pin the exact
# version to match the local toolchain and the lockfile format.
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NEXT_TELEMETRY_DISABLED="1"

# Prisma needs OpenSSL (for the query engine) and CA certificates (for the
# engine download during install). Bookworm-slim does not ship them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --silent pnpm@12.11.2

###############################################################################
# deps: install every dependency (build + prod) using the frozen lockfile
###############################################################################
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

###############################################################################
# builder: generate the Prisma client, then produce the Next.js standalone build
###############################################################################
FROM base AS builder
WORKDIR /app

# The app is served from the standalone server, but the runner needs a full prod
# dependency tree for `prisma migrate deploy` / `prisma db seed`. Install those
# separately in prod-deps so the builder can prune to only its own needs.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` needs the generated client to resolve `@prisma/client`.
RUN pnpm prisma generate \
    && pnpm build

###############################################################################
# prod-deps: a clean, production-only node_modules tree for the runtime image.
# This stage exists so migrate/seed/prisma CLI work in the container without
# carrying devDependencies (eslint, typescript, vitest, tailwind CLI, ...).
###############################################################################
FROM base AS prod-deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Generate the client against the schema so `@prisma/client` is usable by the
# seed script and by `prisma` commands. It is intentionally generated here, not
# left to a postinstall, so the output is deterministic.
COPY prisma ./prisma
RUN pnpm prisma generate

###############################################################################
# runner: minimal, non-root production image
###############################################################################
FROM base AS runner
WORKDIR /app

ENV NODE_ENV="production" \
    PORT="3000" \
    HOSTNAME="0.0.0.0"

# Non-root app user. The uid/gid (1100) intentionally match the production
# bind mount / PVC (owner 1100:1100, mode 775) so the mounted /app/data tree is
# writable by the app user. The named upload volume is initialised from this
# tree on first use (nextjs-owned); for a bind mount or PVC the mount's own
# ownership governs, because the mount masks the image-layer ownership that
# `chown -R nextjs:nodejs /app` below set up (see docs/deployment.md).
RUN groupadd --system --gid 1100 nodejs \
    && useradd --system --uid 1100 --gid nodejs --home-dir /app nextjs \
    && mkdir -p /app/data/uploads

# The complete standalone output: server.js, its traced node_modules, and any
# traced config. Placing it at /app makes server.js runnable from the image root.
COPY --from=builder /app/.next/standalone ./

# Static assets are not traced and must be copied manually (see Next docs).
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma schema, migrations and the seed script, so migrate/seed run in-container.
COPY --from=builder /app/prisma ./prisma

# Production dependency tree (prisma CLI, @prisma/client, bcryptjs, ...) used by
# `pnpm db:migrate` and `pnpm db:seed`. Overlays the standalone node_modules with
# the packages needed only for CLI operations.
COPY --from=prod-deps /app/node_modules ./node_modules

# Package metadata so `pnpm db:seed` can read the `prisma.seed` config and scripts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

# Liveness only - intentionally does not depend on the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 

CMD ["node", "server.js"]
