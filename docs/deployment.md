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

- `db:migrate` = `prisma migrate deploy`. It applies `prisma/migrations`, which in
  release 0.1.0 is the single from-scratch baseline
  (`20261016000000_initial_0_1_0`) plus the additive currencies migration
  (`20261017000000_currencies`) and the additive skill-grade-removal migration
  (`20261017200000_skill_grade_removed`) that follow it - the old `0001..0023`
  chain was archived (see section 1.4).
- `db:seed` = `prisma db seed`, which runs `node prisma/seed.ts` (Node 24 type
  stripping) against the same `DATABASE_URL`. It bootstraps the admin user and
  the verified/house catalog entries. It is idempotent (uses upsert/find) and
  does not create sample characters.
- `prisma/migrations` carries the 0.1.0 from-scratch baseline plus the additive
  `20261017000000_currencies` and `20261017200000_skill_grade_removed` migrations
  that follow it. Both are **additive**. The currencies migration only adds the
  `currencies` value to the `CatalogKind` enum and creates the
  `character_currency_balances` table. The skill-grade-removal migration clears
  any pre-existing `grade` / `gradeDescriptions` value on a `skills` catalog row,
  adds a CHECK constraint enforcing that a skill is grade-free, and FIRST archives
  any authored legacy skill grade data into an immutable, migration-only audit
  table (`legacy_skill_grade_metadata`) so it is not lost. Neither drops or
  modifies a baseline object, so applying them is a normal `prisma migrate deploy`
  step that needs **no** destructive reset. See `docs/rules/currencies.md`.

Run these **before** `docker compose up -d` if you want the first boot to be
immediately usable, or after once; the app serves regardless because it never
auto-migrates.

This is the whole deployment for a **brand-new, empty** database. On a
**pre-0.1.0** database that was migrated with the old `0001..0023` chain, the
single 0.1.0 baseline refuses to run (it only ever builds from an empty
database), so use the one-time guarded reset in section 1.4 instead of
`db:migrate`.

#### Historical destructive chain (archived)

The `0001..0023` migrations are **archived**, not active: in release 0.1.0 the
SQL was moved to `prisma/migrations-archive/pre-0.1.0` and replaced by the
single from-scratch baseline (see section 1.4). The old destructive chain is
historical context - it matters only if you operate a pre-0.1.0 backup, never
for the released app.

Historically, migrations **0017, 0018 and 0019** formed an irreversible
destructive chain. In particular, `0019_god_blessing_tiers` **deleted every
existing BLESSING association** and all `blessings` catalog rows (and dropped
the `patronId` column), then added a database CHECK constraint that forbids a
null-tier BLESSING link. The deleted blessing links cannot be recovered from the
post-migration database, so before running the old chain on a database that
already has characters, **take a full PostgreSQL backup**. For the 0.1.0 upgrade
path that backup must be a custom-format archive the reset can verify (see
section 1.4), not a plain-SQL `pg_dump > backup.sql`:

```bash
docker compose exec -T postgres \
  pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-primal_creator}" \
  > backup-before-0.1.0.dump
```

If a character's blessing links must be preserved, restoring that archive (see
section 5.1) recreates the `blessings` catalog rows and the old BLESSING links
only on a pre-0.1.0 database, and someone must re-link each god + tier manually
afterward. See `docs/rules/blessings.md`.

### 1.4 One-time 0.1.0 migration (from a pre-0.1.0 database)

Release 0.1.0 collapses the `0001..0023` migration chain into a single
from-scratch baseline (`prisma/migrations/20261016000000_initial_0_1_0`). The
baseline opens with a `DO` guard that only ever runs against an **empty**
database: it refuses to re-create when `_prisma_migrations` already records an
applied migration, or when the public schema already holds any **non-extension**
public object (an existing app schema). Extension-owned objects are allowed and
treated as empty: the views and composite row types installed by a Postgres
extension such as `pg_stat_statements` (which Crunchy PGO installs into
`public`) are recognised as extension members via `pg_depend` and permitted, so
they are never a reason to refuse, and they are never mistaken for an existing
app schema. Because that guard never drops anything, a database migrated with
the old chain **cannot** be upgraded by `prisma migrate deploy` - it must first
be wiped and rebuilt. This is a one-time, explicit, opt-in, fail-closed
operation. It is **never** run automatically, and the app never auto-resets on
boot.

The reset applies the 0.1.0 baseline and its additive currencies
(`20261017000000_currencies`) and skill-grade-removal
(`20261017200000_skill_grade_removed`) migrations and verifies the combined
result. It is **not** the routine path for a normal deployment: a fresh/empty
database, or one already on the 0.1.0 baseline (hardened by `db:migrate`), never
needs it.

The historical `0001..0023` SQL is preserved (untouched) at
`prisma/migrations-archive/pre-0.1.0`.

> **Warning.** The reset drops ALL existing application data - users, admins,
> characters, progression events, drafts, inventory, associations and every
> catalog row - and rebuilds the 13 application tables, the active house-rules
> row, the baseline plus its additive currencies and skill-grade-removal
> migrations, the `>= 41` curated
> catalog entries and the seeded admin from scratch. Portrait/upload binaries that live outside the
> database (the `uploads` volume or `UPLOAD_DIR`) survive, but their database
> references (the `assets` rows) are gone, so those files are orphaned.

Prerequisites and exact steps, in order:

```bash
# 0. Ensure ADMIN_EMAIL / ADMIN_PASSWORD are set with a strong password. The
#    reset enforces production-strength admin credentials (>= 12 chars, not a
#    weak placeholder) BEFORE any deletion, regardless of NODE_ENV.

# 1. Stop all app/writer instances. Keep Postgres running - it must serve the
#    dump and the reset.
docker compose stop app

# 2. Take a FULL backup from the Postgres service to a host file, in pg_dump
#    CUSTOM FORMAT (-Fc). The reset script REQUIRES a custom-format archive: it
#    validates the PGDMP header plus the object/data list. A plain-SQL
#    `pg_dump > backup.sql` from the older docs is NOT accepted by the reset's
#    `--backup-file` check.
docker compose exec -T postgres \
  pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-primal_creator}" \
  > backup-0.1.0.dump

# 3. Verify the backup BEFORE any destructive step: list the archive and run a
#    full read/decompression rehearsal. The reset script performs the same
#    checks itself, but validating here means you know the dump is good before
#    you risk the data.
docker compose exec -T postgres pg_restore --list < backup-0.1.0.dump
#   Confirm the listing includes `TABLE public users`, `TABLE public
#   catalog_definitions`, `_prisma_migrations` AND `TABLE DATA` for `users` /
#   `catalog_definitions` (a schema-only dump fails here).
docker compose exec -T postgres \
  pg_restore --data-only --file /dev/null < backup-0.1.0.dump
#   Reads and decompresses every data entry; a truncated/corrupt archive fails here.

# 4. Pull / build the new 0.1.0 image (the one carrying the baseline migration
#    and the reset script). The image is referenced by ${DOCKER_TAG:-latest}.
#    `.github/workflows/docker.yml` publishes `main`, `latest` and the short SHA
#    on main pushes, plus a bare tag mirroring the root `package.json` semver
#    (e.g. `0.1.2`) - so a bare semver tag exists for the current release in
#    addition to `v*` git tags, whose behaviour is unchanged. The workflow still
#    publishes that bare package semver and it is NOT version-gated: it is
#    re-pushed on every `main` push, so if `package.json`'s version is not bumped
#    before a later push, that push overwrites the same bare semver tag at the
#    same package version - the bare semver label is MUTABLE. For an immutable
#    reference to a specific build, use the short SHA tag
#    (`ghcr.io/sepffuzzball/primal-creator:<sha>`) or the image digest
#    (`ghcr.io/sepffuzzball/primal-creator@sha256:...`), which never change for a
#    given build. To target this release after GitHub Actions has published it,
#    `main` is usable (it too is a moving ref) or build locally. A bare `0.1.0`
#    tag only exists if `package.json` held `0.1.0` when that release was pushed;
#    do not assume it.
#      Option A - pull a published tag (once the docker.yml publish job on
#      `main` has succeeded; if the image is not available yet, wait for CI):
export DOCKER_TAG=main
docker compose pull app
#      Option B - build locally from this checkout:
# docker compose build app

# 5. Mount the backup READ-ONLY into a one-off app runner and run the guarded
#    reset. DATABASE_URL inside the container is compose-derived and always
#    targets the `postgres` service (`postgres:5432`); `--target-host` and
#    `--target-db` must match it EXACTLY, and `--confirm` must be exactly
#    `DELETE <db> FOR 0.1.0`. The reset validates the backup, the target
#    host/port/db, the admin credentials and a read-only preflight, then runs
#    `prisma migrate reset --force --skip-seed` + `prisma db seed` and verifies
#    the result (13 tables, active house_rules, the baseline plus its additive
#    currencies and skill-grade-removal migrations, >= 41
#    catalog entries, one admin).
docker compose run --rm -v "${PWD}:/backups:ro" app pnpm db:reset:0.1.0 -- \
  --target-host postgres:5432 \
  --target-db "${POSTGRES_DB:-primal_creator}" \
  --confirm "DELETE ${POSTGRES_DB:-primal_creator} FOR 0.1.0" \
  --backup-file /backups/backup-0.1.0.dump

# 6. ONLY after the reset reports success, start the app.
docker compose up -d app
```

On any failure after step 2 (once the destructive phase has started), keep the
app offline and restore the backup before retrying:

```bash
# Restore the custom-format dump (destructive; recreates the pre-0.1.0 data).
docker compose exec -T postgres \
  pg_restore --clean --if-exists --no-owner \
  -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-primal_creator}" \
  < backup-0.1.0.dump
```

Then re-run the reset. Never run `prisma migrate deploy` on the old-23-chain
database before this reset - the baseline guard aborts it. For a **fresh,
empty** database there is nothing to wipe: use the normal `db:migrate` then
`db:seed` in section 1.3, no reset.

### 1.5 Delete a single character (to recreate it)

There are times you do not want to wipe the whole database - a character has
been created with bad data, or a re-roll is needed - and you only want to
recreate that one character. The `db:delete-character` command is an explicit,
per-character **hard delete**: it deletes exactly one `characters` row and,
through the schema's `ON DELETE CASCADE` foreign keys, everything that belongs
exclusively to that character (its `assets` metadata rows, progression events,
character associations, inventory items, currency balances, skill offers and the
options belonging to those offers).

It is **never** run automatically, does **not** touch any other character, does
**not** run migrations, and does **not** reset the database. The deletion is
prefixed by the separator `--` so pnpm passes the flags through, and
`DATABASE_URL` is read from the inherited env (it is never printed; credentials
and the URL are never logged).

First, preview what would be deleted (read-only; nothing is deleted):

```bash
docker compose run --rm app pnpm db:delete-character -- \
  --id <character-id>
```

The preview prints the target character's id, name, `ownerId`, `archived` flag
and the counts of every dependent kind (assets, progression events,
associations, inventory items, currency balances, skill offers and offer
options).

Then, to actually delete, pass `--execute` and repeat the **exact** character id
as `--confirm`. `--confirm` is the operator's fail-safe: it must equal the id
being deleted, so an accidental `--confirm` for a different id is refused
before anything is deleted. No backup is required - the character is simply
gone and can be recreated by running the create flow again.

```bash
docker compose run --rm app pnpm db:delete-character -- \
  --id <character-id> --execute --confirm <character-id>
```

Safety and behaviour:

- Only the single `characters` row is deleted (`WHERE id = <id>`); its
  dependents cascade. No broad `DELETE`, no `deleteMany`, no whole-DB reset.
- `--id` is always required. A missing `--id`, a duplicate flag, an unknown
  flag, a stray positional argument, a missing `DATABASE_URL`, an invalid
  `DATABASE_URL`, a `--execute` without `--confirm`, or a `--confirm` that does
  not equal `--id` are all refused before any database connection or mutation.
- An id that does not exist reports "not found" and deletes nothing (exit code
  is nonzero); a successful deletion reports the deleted id and exits 0.

> **Portrait / upload caveat.** Deleting a character cascades and removes its
> `assets` **metadata** rows (including the `character-avatar` portrait row).
> The underlying image **bytes** on disk (the uploads volume / `UPLOAD_DIR`) are
> **not** touched, so those files become orphaned. The utility warns about this
> on every deletion. If you want to reclaim the space, remove the orphaned files
> from the uploads directory yourself; nothing in the app or this command does
> it for you.

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
- **Tags**: `type=ref,event=branch` (e.g. `main`), `type=ref,event=tag` (the `v*`
  tags, unchanged), `type=sha,format=short` (short SHA), and - on pushes to `main`
  only - `latest` plus a bare tag mirroring the root `package.json` semver (e.g.
  `0.1.2`), so a release can be pulled exactly without a git `v*` tag. The
  workflow still publishes that bare package semver on every `main` push and it is
  NOT version-gated, so it is MUTABLE: a later `main` push at the same package
  version overwrites the bare semver tag. For an immutable reference to a specific
  build, use the short SHA tag or the image digest (`@sha256:...`), which never
  change for that build - the bare semver, the `main` branch ref and `latest` are
  all moving labels.

To consume the image directly:

```bash
docker pull ghcr.io/sepffuzzball/primal-creator:main
```

Note: the image is a published target only if the workflow has actually pushed
it. The `compose.yaml` references `${DOCKER_TAG:-latest}`. Left unset, it resolves
to `latest`, which the workflow publishes only on pushes to `main`; the bare
package semver tag (e.g. `0.1.2`) is likewise published only on `main` pushes,
and the branch, short SHA and `v*` tag refs are published per the existing
workflow. Because `latest`, `main` and the bare package semver are all moving
labels that a later push can overwrite, pin an immutable deployment to the short
SHA tag or the image digest instead:
`docker pull ghcr.io/sepffuzzball/primal-creator@sha256:...`.

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

Always use a **custom-format** (`-Fc`) dump. It is the only format the one-time
0.1.0 reset will accept as `--backup-file` (section 1.4), and it restores via
`pg_restore` (available in the `postgres` container), not `psql`. A plain-SQL
`pg_dump > backup.sql` is still restorable with `psql`, but it is not a usable
backup for the reset.

```bash
# Backup (custom-format archive on the host)
docker compose exec -T postgres \
  pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-primal_creator}" \
  > backup.dump

# Verify the archive is readable BEFORE relying on it (lists the objects/data)
docker compose exec -T postgres pg_restore --list < backup.dump

# Restore (destructive; stopping the app is not required for a logical restore,
# but do it on a maintenance window)
docker compose exec -T postgres \
  pg_restore --clean --if-exists --no-owner \
  -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-primal_creator}" \
  < backup.dump
```

These examples assume the default `POSTGRES_USER=postgres` and
`POSTGRES_DB=primal_creator`. If you changed either, substitute those values. The
dump/restore commands run inside the `postgres` service container, where the
local socket / peer auth as the `postgres` OS user is trusted, so no password is
required; if you run them from the host instead, set `PGPASSWORD` (or supply
the `POSTGRES_PASSWORD` you configured).

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
4. Run `pnpm db:migrate` on a fresh/extracted database to apply the 0.1.0
   baseline (`20261016000000_initial_0_1_0`) and its additive currencies
   (`20261017000000_currencies`) and skill-grade-removal
   (`20261017200000_skill_grade_removed`) migrations - the latter clears any
   legacy skill grade/gradeDescriptions into `legacy_skill_grade_metadata` and
   enforces that a skill is grade-free. If the restored dump predates
   0.1.0 (an old `0001..0023` database), the baseline refuses to run, so run
   the one-time reset in section 1.4 instead.
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
- **`prisma migrate deploy` fails with `P3018` (a failed migration row
  exists)** - Prisma already recorded a failed attempt at the baseline
  `20261016000000_initial_0_1_0` in `_prisma_migrations` (its `finished_at` and
  `rolled_back_at` are both NULL). Inspect that row BEFORE doing anything:
  `SELECT migration_name, finished_at, rolled_back_at, logs FROM
  "_prisma_migrations" ORDER BY started_at;` and check `prisma migrate status`.
  Then inspect the public schema for partial app objects - list the public
  tables and enum types (`SELECT tablename FROM pg_tables WHERE schemaname =
  'public';` alongside the enum rows from `pg_type`) and confirm no app table or
  enum was half-created. ONLY when (a) the failed row is exactly the baseline
  migration and (b) there is no partial app schema, mark the baseline as rolled
  back and re-run deploy:
  `prisma migrate resolve --rolled-back 20261016000000_initial_0_1_0` then
  `pnpm db:migrate`. The one-time guarded reset (section 1.4) is the alternative
  for a database that genuinely holds app data.
- **`prisma migrate deploy` fails with `P3005` ("database schema is not
  empty")** - this is the no-failed-row case. Prisma refuses to even start the
  baseline because the public schema already holds objects that are NOT part of
  the app, and there is NO failed migration row to resolve. Do NOT run
  `prisma migrate resolve` here - nothing failed, and resolving a row that does
  not exist is a no-op at best. Instead inspect the non-extension objects: if
  they are app or old-chain objects (the `0001..0023` tables, or a half-applied
  schema), use the one-time guarded reset (section 1.4); if the only public
  objects are members of a Postgres extension (such as `pg_stat_statements` on a
  fresh Crunchy PGO database), the baseline ignores them and `pnpm db:migrate`
  proceeds - see the PGO bullet below.
- **The baseline already applied successfully** - if `_prisma_migrations`
  already holds a row for `20261016000000_initial_0_1_0` whose `finished_at` is
  NOT NULL, the baseline already succeeded. NEVER run
  `prisma migrate resolve --rolled-back 20261016000000_initial_0_1_0` on it, and
  NEVER re-run the baseline, just because the checksum recorded in the database
  differs from the file on disk. The baseline only ever builds from an EMPTY
  database, so a second run would wrongly refuse on its own schema. Leave the
  applied row alone - `prisma migrate status` is the source of truth.
- **A fresh PGO (Crunchy Postgres Operator) database that has `pg_stat_statements`
  installed into public** - the 0.1.0 baseline recognises the extension's views
  and composite row types as extension members (via `pg_depend`, never by name)
  and treats the database as empty, so `pnpm db:migrate` succeeds and the
  operator's extension views/functions are preserved. Never drop operator
  extensions (`DROP EXTENSION pg_stat_statements`); the baseline never touches
  them. Also do NOT reach for `prisma migrate reset` here: the one-time reset
  script expressly refuses when any extension is installed in the `public`
  schema (section 1.4), so for a fresh PGO baseline use `pnpm db:migrate` +
  `pnpm db:seed` instead of the reset.
