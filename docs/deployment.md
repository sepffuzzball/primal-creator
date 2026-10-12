# Deployment & Operations

This guide covers deploying `primal-creator` with the provided Docker/Compose
setup, publishing the image to GHCR, and operating the resulting stack. The app
code and UI are unchanged; this document only describes how the operational
pieces are wired together.

## 1. Build and run

### 1.1 Image

The multi-stage `Dockerfile` builds a non-root, standalone Next.js image:

1. **base** - `node:24-bookworm-slim`, pnpm 12.11.2, OpenSSL + CA certs.
2. **deps** - full install from the frozen lockfile.
3. **builder** - `prisma generate`, then `next build` (`output: "standalone"`).
4. **prod-deps** - a clean production-only `node_modules` tree so the container
   can run `prisma migrate deploy` / `prisma db seed` without devDependencies.
5. **runner** - copies the standalone output (`server.js` + traced `node_modules`),
   `public`, `.next/static`, the `prisma/` directory (schema + migrations + seed),
   and the prod dependency tree. Runs as the unprivileged `nextjs` user.

The image intentionally **does not** run migrations on startup. Migrations and
seed are always an explicit step, which is the "no unsafe auto-migration in
request handling" contract.

### 1.2 Environment

- `AUTH_SECRET` is required and must be at least 32 characters. Compose validates
  this and fails fast if it is missing:
  `openssl rand -base64 48`.
- `DATABASE_URL` in the app container is derived from `POSTGRES_USER` /
  `POSTGRES_PASSWORD` / `POSTGRES_DB` and always targets the compose `postgres`
  service (`postgres:5432`), regardless of any local-dev value.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` are only consumed by the seed step. Change
  them before seeding; they are not read at request time.
- `ADMIN_PASSWORD` is required (compose has no fallback) and, in production, the
  seed refuses weak/placeholder values (`admin`, `password`, ...) and any
  password shorter than 12 characters so a deploy never silently creates a
  guessable admin. Generate one with `openssl rand -base64 12`.
- `POSTGRES_PASSWORD` is required (compose has no fallback) and defaults to the
  **dev-only** value `postgres`. If you run the compose `postgres` service on a
  host port (`ports: "5432:5432"`) or otherwise expose it to the network, you
  must set a real password - otherwise the well-known default `postgres` is a
  guessable credential. Generate one with `openssl rand -base64 24`. Use the
  same value in the app container's derived `DATABASE_URL`, which compose builds
  from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`.

### 1.3 Migrate and seed

```bash
docker compose run --rm app pnpm db:migrate
docker compose run --rm app pnpm db:seed
```

- `db:migrate` = `prisma migrate deploy`. It applies `prisma/migrations`.
- `db:seed` = `prisma db seed`, which runs `node prisma/seed.ts` (Node 24 type
  stripping) against the same `DATABASE_URL`. It bootstraps the admin user and
  the verified/house catalog entries. It is idempotent (uses upsert/find) and
  does not create sample characters.

Run these **before** `docker compose up -d` if you want the first boot to be
immediately usable, or after once; the app serves regardless because it never
auto-migrates.

## 2. Health checks

- The **app** image has a container `HEALTHCHECK` (and a Compose override) that
  probes `GET /api/health`. That route returns `{ status: "ok" }` and does **not**
  touch the database, so the app is reported healthy even while Postgres is
  starting or briefly unreachable. Database availability is owned by the
  migration/seed step, not the web process.
- The **postgres** service uses `pg_isready` as its healthcheck, and the app
  container waits for it with `depends_on: condition: service_healthy`.

## 3. GitHub Container Registry (GHCR)

The `docker.yml` workflow pushes to `ghcr.io/sepffuzzball/primal-creator`:

- **Triggers**: push to `main`, version tags (`v*`), and manual dispatch.
- **Prerequisite**: a `checks` job runs lint, formatting, typecheck, unit tests
  and build. Only if it passes does the `publish` job run.
- **Multi-arch**: `linux/amd64` and `linux/arm64` via Docker Buildx + QEMU.
- **Caching**: `cache-from: type=gha` / `cache-to: type=gha,mode=max` (registry
  cache scope is the GitHub repo).
- **Token**: the default `GITHUB_TOKEN`, scoped to the repository, with
  `permissions: packages: write`. No long-lived secret is required.
- **Tags**: `type=ref,event=branch` (e.g. `main`), `type=ref,event=tag`, and
  `type=sha,format=short`.

To consume the image directly:

```bash
docker pull ghcr.io/sepffuzzball/primal-creator:main
```

Note: the image is a published target only if the workflow has actually pushed
it. The `compose.yaml` references `${DOCKER_TAG:-latest}`; the build step in the
workflow supplies `latest`/`main`/tag refs, not necessarily literal `latest`.

## 4. Runtime concerns

### 4.1 Non-root user and volumes

The app runs as `nextjs` (`uid 1001`) and expects to write uploads under
`/app/data/uploads`.

- **Named volume** (`uploads`): Docker initialises it from the image tree on
  first use, copying the `nextjs` ownership, so it is writable by the app user.
- **Bind mount**: if you bind a host directory over `/app/data/uploads`, ensure
  it is owned by `uid 1001` (or writable by it), e.g.
  `sudo chown -R 1001:1001 /srv/.../uploads`.

### 4.2 Reversing the proxy

The image listens on `HOSTNAME=0.0.0.0:3000`. Put it behind a reverse proxy that
terminates TLS (e.g. Traefik, Caddy, nginx). The session cookie is set
`Secure` when `NODE_ENV=production`, so TLS is required for auth cookies to be
sent in production.

### 4.3 Scaling

The app is a standard Next.js server that holds no per-process state beyond the
in-memory Prisma client pool (cached per process). It can be scaled horizontally
across instances as long as all instances share the same `DATABASE_URL` and
`AUTH_SECRET`. The uploads volume is currently only mounted per container; if you
scale the web tier, back it with an NFS/object store outside the scope of this
repo's Compose file.

## 5. Backup & restore

### 5.1 Database

```bash
# Backup
docker compose exec postgres pg_dump -U postgres primal_creator > backup.sql

# Restore (destructive; stops the running app first is not required for a
# logical restore, but do it on a maintenance window)
docker compose exec -T postgres psql -U postgres primal_creator < backup.sql
```

These examples assume the default `POSTGRES_USER=postgres` and
`POSTGRES_DB=primal_creator`. If you changed either, substitute those values;
`pg_dump` prompts for the password (or reads `PGPASSWORD`), which is why the
`POSTGRES_PASSWORD` you set must be available to the command.

The database is the source of truth for users, characters, progression events and
the catalog. Back it up regularly.

### 5.2 Uploads

```bash
# Backup
docker run --rm \
  -v primal-creator_uploads:/data \
  -v "$PWD":/backup alpine \
  tar czf /backup/uploads.tar.gz -C /data .

# Restore
docker run --rm \
  -v primal-creator_uploads:/data \
  -v "$PWD":/backup alpine \
  tar xzf /backup/uploads.tar.gz -C /data
```

### 5.3 Restore checklist

1. Bring up Postgres and the app image.
2. Restore the database dump (or recreate it from the schema + migrations and
   re-seed).
3. Restore the uploads volume.
4. Run `pnpm db:migrate` to be sure migrations are current.
5. Log in with the seed (or existing) admin.

## 6. Troubleshooting

- **`AUTH_SECRET must be set and at least 32 characters`** - provide a long
  `AUTH_SECRET`; regenerate with `openssl rand -base64 48`.
- **App starts but won't serve data, and `uploads` isn't writable** - check the
  `/app/data/uploads` ownership (see 4.1).
- **Image builds but crashes at runtime with a Prisma "query engine not found"**
  - the standalone trace must include `node_modules/.prisma/client`. This is
    handled by `outputFileTracingIncludes` in `next.config.ts`; do not remove it.
- **Compose refuses to start until I set `AUTH_SECRET`** - that is intentional
  (no hardcoded secrets). Set it via a git-ignored `.env`:
  `echo 'AUTH_SECRET=...' >> .env`.
