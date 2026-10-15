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
- `APP_ORIGIN` is **optional** but strongly recommended behind a reverse proxy.
  It is the real public browser origin (scheme + host + optional port, no path,
  always HTTPS in production). Every cookie-authenticated state-changing
  (POST/PUT/PATCH/DELETE) API call must carry an `Origin` header that exactly
  matches `APP_ORIGIN` (or, when it is unset, the expected origin described
  below) - this is the CSRF same-origin defence in `lib/auth/guard.ts`. A
  mismatch, missing header, or a sibling subdomain is rejected with
  `403 bad_origin`. `APP_ORIGIN` is the highest-priority source of truth and is
  _never_ ignored, even if forwarded headers disagree. It is read at runtime, so
  fixing it never requires an image rebuild - only a container restart. For the
  canonical deployment set it in the git-ignored local `.env`:
  ```bash
  APP_ORIGIN="https://primalcreator.fuzzball.enterprises"
  ```
- `TRUST_PROXY_HEADERS` is an **opt-in** alternative to `APP_ORIGIN`, consulted
  only when `APP_ORIGIN` is unset. With `true` the app rebuilds the expected
  origin from _exactly one_ `X-Forwarded-Proto` (`https` or `http`) and _exactly
  one_ `X-Forwarded-Host` (DNS host or bracketed IPv6 with optional valid port).
  Any ambiguous pair - missing header, comma-separated list, whitespace,
  userinfo credentials, a path/query/fragment, or an invalid port - **fails
  closed** with `403 bad_origin` rather than falling back to the un-proxied
  request URL. With `false` (default) forwarded headers are ignored and the
  request's own URL origin is used. Use it only when a proxy overwrites BOTH the
  forwarded proto and host headers _and_ the app port is not reachable otherwise.
- `APP_BIND_ADDRESS` controls the interface the published container port binds
  to (default `0.0.0.0`, current behaviour). For a same-host reverse proxy, set
  `APP_BIND_ADDRESS="127.0.0.1"` so the app port is only reachable through the
  proxy; for a proxy on a different host, keep `0.0.0.0` and firewall the port.

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

The app runs as the non-root `nextjs` user (`uid 1100`, primary group `nodejs`
`gid 1100`) and expects to write uploads under `/app/data/uploads`. The image
never starts as root and never blanket-chmods/chowns the upload mount at boot:
the app user is assumed to already have write access to wherever uploads live,
because any mount attached over `/app/data` or `/app/data/uploads` **masks the
image-layer ownership** that `chown -R nextjs:nodejs /app` created. The
filesystem the process actually sees is the attached volume, not the image's
directory tree, so the owner of that volume is the effective owner and the
image's `nextjs` ownership is invisible behind it. This is why binding a
production PVC over `/app/data` and then seeing `EACCES` on
`/app/data/uploads` is an ownership mismatch on the mount, not something the
image can repair.

- **Named volume** (`uploads`, from `compose.yaml`): Docker initialises it from
  the image tree on first use, copying the `nextjs` ownership into the volume,
  so a fresh named volume is writable by the app user with no manual step. (If
  the stack is run under Kubernetes, that is not this named volume - see the
  PVC bullet.)

- **Bind mount / PVC**: if you bind a host directory or a Kubernetes PVC over
  `/app/data` (or `/app/data/uploads`), the mount's own owner and mode govern
  access and the image's ownership is hidden behind it. The mount must be
  writable by `uid 1100` (or by the `nodejs` group, `gid 1100`) - a mode-`775`
  directory owned by `1100:1100` is exactly the expected shape. The image will
  not fix a mismatched mount, so set the ownership on the host/cluster, e.g. on
  a host bind:
  `sudo chown -R 1100:1100 /srv/.../uploads`.

- **Legacy `1001` volume**: if the bound path was previously used with the
  earlier image whose `nextjs` user was `uid 1001` (or where the volume or its
  PVC was provisioned as `1001:1001`), the files on it are owned by `1001:1001`
  and the current `uid 1100` process gets `EACCES` when it tries to create or
  write `/app/data/uploads`. Fix ownership once:
  `sudo chown -R 1100:1100 /srv/.../uploads` (or, for a PVC, re-provision the
  backing store as `1100:1100`). This is a one-time migration; after it, no
  further ownership changes are needed, because the image does not touch the
  mount.

- **`UPLOAD_DIR`**: the app resolves the private directory from `UPLOAD_DIR`
  first, then `/app/data/uploads` in production, then `<cwd>/data/uploads`
  outside production. The override is unchanged and still works - if you set
  `UPLOAD_DIR`, whatever path it points to must already be writable by
  `uid 1100`, because nothing in the image creates or chowns it.

### 4.2 Reversing the proxy

The image listens on `HOSTNAME=0.0.0.0:3000`. Put it behind a reverse proxy that
terminates TLS (e.g. Traefik, Caddy, nginx). The session cookie is set
`Secure` when `NODE_ENV=production`, so TLS is required for auth cookies to be
sent in production. The app is a standard next-server with no CORS `Access-
Control-Allow-Origin: *` wildcard - it enforces a strict, exact same-origin CSRF
check, so the proxy must present the real browser origin to the browser, not
its own host.

**The immediate fix for sign-in being rejected (`403 bad_origin`) behind a
proxy is to set `APP_ORIGIN`.** The app never rebuilds the image to pick up an
environment change - `APP_ORIGIN`, `TRUST_PROXY_HEADERS` and `APP_BIND_ADDRESS`
are read at runtime, so you only recreate the container. In the git-ignored
local `.env` (never commit secrets) set:

```bash
# .env (local, git-ignored)
APP_ORIGIN="https://primalcreator.fuzzball.enterprises"
```

Then restart the app service (the service name is `app` in `compose.yaml`;

no rebuild needed):

```bash
docker compose up -d --force-recreate app
```

Without `APP_ORIGIN`, the CSRF same-origin check in `lib/auth/guard.ts` compares
`Origin` against the request's own origin, which behind a proxy is the proxy's
origin (for example `http://proxy.internal:3000`), not the browser origin, so
legitimate browser writes would be rejected with `403 bad_origin`. Keep it unset
only for a direct, non-proxied deployment.

**Alternative opt-in `TRUST_PROXY_HEADERS`.** Use this only when (a) the reverse
proxy is guaranteed to _overwrite both_ `X-Forwarded-Proto` and
`X-Forwarded-Host` headers on every request (so the app never sees a
stale/absent pair), and (b) the app port is not reachable from the browser (so
a direct hit could never present a mismatched origin). With `true` the app
rebuilds the expected origin from exactly one forwarded proto (`https`/`http`)
and one forwarded host; an ambiguous pair fails closed with `403 bad_origin`
rather than silently falling back. Note that outer whitespace (OWS) around a
header value - e.g. a proxy emitting `X-Forwarded-Proto: " https"` - is trimmed
by the web header layer before the check, so only whitespace _inside_ the value
is rejected; still, always overwrite (never append to) both forwarded headers on
every request. This is a workaround, not the default - the recommended,
always-correct setting is a fixed `APP_ORIGIN`. When disabling trust mode again,
set it back to `false` (the default) and restore the plain `req.url` fallback.

A generic nginx TLS-terminating proxy location (adjust the `upstream`/ports for
your setup) that forwards the headers trust mode depends on and keeps the
public host the browser sees:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Note the `Host` header the proxy forwards matters only when trust mode is on (it
is ignored otherwise). If the app publishes a non-standard port, ensure that
`X-Forwarded-Host` carries the port (e.g. `app.example.com:8443`) when you need
it to match the browser origin. For a same-host proxy, set
`APP_BIND_ADDRESS="127.0.0.1"` so the app port is only reachable through the
proxy; for a proxy on another host, keep `0.0.0.0` and rely on the firewall.

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
