# primal-creator

A deterministic character-building and progression calculator for a
"Primal Hunter"-style system. It models races, grades, classes, professions,
skills, titles, blessings, bloodlines and evolution with a pure TypeScript
calculation engine (`lib/rules`), persists characters and a polymorphic catalog
via Prisma + PostgreSQL, and exposes a JSON API. No client-supplied stat awards
are accepted - every award is derived server-side from the catalog.

## Features

To avoid overstating what works, the current feature set is split explicitly
into what is shipped and what is scaffolded but not yet wired to the UI/API.

### Shipped

- **Deterministic progression engine** (`lib/rules`): a pure TypeScript model of
  races, grades, classes, professions, skills, titles, blessings, bloodlines,
  consumables and evolution. The client never supplies an award; every value is
  derived server-side from the catalog.
- **Character creation & lifecycle**: create a character through an eight-step
  questionnaire (name/description, origin, and race/class/profession picked from
  the catalog), advance class/profession, allocate attribute points, evolve the
  race grade, edit name/description, archive and restore.
- **Resumable creation drafts**: the questionnaire is persisted per user as an
  authenticated, owner-scoped draft (one per user) so work is never lost. A draft
  stores only validated, whitelisted fields (`step`, name/description, origin,
  race/class/profession, a special-abilities flag kept for backward
  compatibility with legacy drafts (always `false` from the wizard - the feature
  is deferred) and an equipment list, plus optional narrative fields), bounded
  and capped at 20KB - no uploaded binaries and no
  stat/award/effect fields. Drafts are optimistic-concurrency versioned (a stale
  write 409s) and are **not authoritative character state**: final creation of a
  `Character` (and its engine state) is a separate, still-transactional operation.
  The wizard's final create step accepts an optional `draftVersion`; when supplied
  the matching draft is deleted atomically inside the same transaction as the
  character row and its `create` journal event, and a stale version 409s
  `draft_conflict` and rolls back the whole create (no second best-effort DELETE).
  When `draftVersion` is omitted (non-wizard clients) the draft is never touched.
  The wizard only sends `name`, `description`, `origin`, `raceId`, `classId`,
  `professionId` (and `draftVersion`) to create - the `special`/`equipment`
  flags and the optional narrative fields are draft-only and never persisted to
  the character as fake powers. The wizard always persists `special: false` (it
  never submits `special: true`), so a legacy draft that carried the flag is
  normalized rather than treated as character state. An optional portrait chosen
  at creation is **not** part of this atomic create: it is uploaded after the
  character exists,
  so a failed upload never rolls back the character (the attachment is not
  atomic). Other draft metadata (nickname, pronouns, age, appearance, biography,
  notes) is preserved in the draft but not yet sent to the character.
- **Character portraits**: an authenticated owner/admin can upload, view and
  remove a character's portrait. Uploads are bounded to 4 MiB, validated
  content-based (PNG/JPEG/WebP via sharp), re-encoded to WebP and stored as an
  `Asset` binary under a private upload directory - never mounted on `/public`.
  The binary is streamed back only through the authenticated, same-origin
  `/api/assets/[id]` route (`Cache-Control: private, no-store`), so the server
  filesystem path is never exposed. Portrait reads always succeed for
  owner/admin (including archived characters); uploads are rejected for archived
  characters, while removal remains allowed.
- **Auditable attribute status**: the status endpoint returns each attribute's
  final value and the full phase-by-phase trace (base, race, track, equipment,
  consumables, caps, ...), so numbers are transparent rather than opaque.
- **Immutable history & export**: every progression event is written to an
  append-only journal, and a character (state + status + journal) can be exported
  as JSON. No sample characters are created.
- **Admin-managed catalog**: a polymorphic catalog for all of the kinds above.
  Admins can create and edit entries, set a `verified` / `inferred` / `house`
  provenance, attach a source URL, and store per-kind `config`. With
  `CATALOG_PUBLIC` unset, catalog reads require a session.
- **Title & equipment linking**: a character can attach real catalog titles and
  equip catalog equipment. Effects and equipment bonuses are synthesized live
  from the **current**, unarchived catalog config at read time; the stored
  `Character.state` and the event journal stay immutable, so editing a catalog
  entry recalculates status without rewriting history. This is direct equip, not
  an inventory claim (an inventory system is deferred).
- **Consumables on a character**: a character can consume real catalog
  consumables directly (direct consumption, not an inventory claim - an inventory
  system is deferred). Permanent consumables grant a permanent external stat gain
  capped by the grade-based race-level capacity (F3/E5/D15/C45, a **house**
  assumption pending verification); temporary potions produce a temporary effect
  that expires after a number of quarters. Every consumption mutates the stored
  state and writes an immutable `consume` progression event to the journal.
- **Skill milestone offers & selection**: skills are **offered, never
  auto-awarded**. The milestone schedule and rarity ladder are data-driven
  (per-skill catalog config), not hard-coded formulas. When a character levels up
  a class/profession track, the service generates one skill offer per choice group
  from the unarchived skills catalog (snapshotted options, so later catalog edits
  never rewrite what was offered). The player (or an admin) selects an option, which
  links the skill to the character; administrators can also grant a skill manually
  with a reason (provenance `manual`). Skill effects are synthesized live from the
  current, unarchived catalog config - history stays immutable, and an upgrade
  group never stacks superseded tiers.
- **Auth & sessions**: email/password login with a JWT session cookie and an
  admin role. No real credentials are committed.
- **Admin-managed users, no public registration**: only an admin may create a
  user (`POST /api/admin/users`); there is no sign-up endpoint. Admins can list
  users, grant/revoke the admin role, disable access, and reset passwords from
  the Settings page. Emails are normalized to lowercase (a duplicate is a 409),
  and every password is hashed with bcrypt cost 12 (minimum 12 characters).
- **Self-service password change with immediate session revocation**: an
  authenticated user can change their own password (`POST /api/auth/password`)
  after verifying the current one. Every role/disable/password change bumps a
  per-user `sessionVersion`; a JWT carrying an older version is rejected, so a
  password reset invalidates all of a user's previous tokens immediately. A
  disabled user's session is revoked on the next request (login rejects them
  with the same generic `invalid_credentials` response so account state is never
  leaked).
- **Last-admin protection**: an admin can never be demoted or disabled if that
  would leave zero enabled admins. The check runs under a SERIALIZABLE
  transaction so two concurrent demotions cannot both commit (the loser gets a
  409). An admin also cannot demote or disable their own account from the
  Settings page (self-demotion is rejected as an additional safety).

### Deferred (modelled or scaffolded, not yet exposed)

The engine and schema already account for these, but they are not wired up:

- **Special abilities calculation**: blessings, bloodlines and transcendents can
  be defined in the encyclopedia/catalog, but they are not yet attached to a
  character. The creation wizard does not record a "has special abilities" flag;
  it shows the step as "Not assigned" and never treats the special category as
  character state until that feature is wired up.
- **Catalog import**: the catalog is populated by `db:seed`; there is no bulk
  import from the wiki, CSV or JSON.
- **Character import**: characters can be exported but not re-imported.

## Fan project disclaimer & attribution

This is an unofficial, non-commercial fan project. It is not affiliated with,
endorsed by, or sponsored by the author or publisher of _The Primal Hunter_.

- Source material: **The Primal Hunter Wiki (Fandom)** -
  `https://the-primal-hunter.fandom.com`.
- "The Primal Hunter" name and related world/setting material remain the
  property of their respective owners. No copyright is claimed over any source
  content; this project only re-expresses system rules as code.

Because the wiki is the only source, facts gathered from it are deliberately
labelled. See `docs/lore/README.md` for the source table and the
`verified` / `wiki-uncertain` / `house assumption` conventions.

## House rules and unresolved mechanics

The engine never invents canon. Anything the source does not state is an
explicit, configurable **house assumption**, and anything the wiki does not
fully define is left **unresolved** rather than filled with a made-up number.

- **Assumptions** (explicit, configurable): `docs/rules/assumptions.md`.
- **Staying-canon rules**: `docs/rules/` per-topic files.
- **What is deliberately unresolved**: see "What is NOT assumed" in
  `docs/rules/assumptions.md`.
- **Engine contract / phase pipeline / versioning**: `docs/architecture/calculation-engine.md`.

Never present a house value or an unresolved number as canon in the UI or prose
without a source citation.

## Stack

- **Next.js 16.4** (App Router, `output: "standalone"`), React 19
- **Prisma 6.19** + PostgreSQL (client + migration tooling)
- **pnpm 12** (see `packageManager`/lockfile)
- TypeScript, ESLint, Vitest, Prettier (Tailwind plugin)

## Local development

Requirements: Node 24+, pnpm 12+, and a reachable PostgreSQL.

```bash
pnpm install               # install dependencies
pnpm prisma generate       # generate the Prisma client
pnpm db:migrate            # apply migrations (explicit, never on boot)
pnpm db:seed               # bootstrap admin + catalog (explicit)
pnpm dev                   # http://localhost:3000
```

Configure `DATABASE_URL` and `AUTH_SECRET` via a local `.env` (see
`.env.example`). The admin credentials are taken from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` during seed.

Quality gates (also run in CI):

```bash
pnpm lint
pnpm exec prettier --check "**/*.{ts,tsx}"
pnpm typecheck
pnpm test
pnpm build
```

## Docker / Compose

A multi-stage Dockerfile builds a non-root, standalone Next.js image and
publishes it to `ghcr.io/sepffuzzball/primal-creator`. Migrations and seed are
always explicit.

```bash
# 1. Provide a real secret (>= 32 chars), a strong admin password
#    (>= 12 chars, not a placeholder), and a real Postgres password. Compose
#    fails fast if AUTH_SECRET, ADMIN_PASSWORD or POSTGRES_PASSWORD is missing.
#    The Postgres default only looks like "postgres" for local dev; never rely
#    on it on a service exposed to the network.
export AUTH_SECRET="$(openssl rand -base64 48)"
export ADMIN_PASSWORD="$(openssl rand -base64 12)"
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"

# 2. Build and start app + postgres.
docker compose up -d --build

# 3. Explicitly migrate and seed (never automatic).
docker compose run --rm app pnpm db:migrate
docker compose run --rm app pnpm db:seed

# 4. Open http://localhost:3000 and log in with the seeded admin.
```

The app container waits for Postgres to be healthy before starting
(`depends_on` + healthcheck) and is itself health-checked against
`/api/health`.

## Environment variables

| Variable                                              | Required                                                     | Default                                    | Purpose                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | yes                                                          | (compose sets it)                          | Prisma connection string                                                                                                                                               |
| `AUTH_SECRET`                                         | yes (>= 32 chars)                                            | -                                          | HS256 JWT signing secret                                                                                                                                               |
| `ADMIN_EMAIL`                                         | for seed                                                     | `admin@primal.local`                       | Bootstrap admin email                                                                                                                                                  |
| `ADMIN_PASSWORD`                                      | for seed (required in production)                            | `admin` (dev)                              | Bootstrap admin password. In production the seed refuses `admin`, `password`, and other placeholder values and requires >= 12 chars; compose requires it (no fallback) |
| `CATALOG_PUBLIC`                                      | no                                                           | `false`                                    | Whether catalog reads are public                                                                                                                                       |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `POSTGRES_PASSWORD` required by compose; the others optional | `postgres` / `postgres` / `primal_creator` | Compose Postgres only. The default `postgres` password is a dev-only value; production must set a real one (see `docs/deployment.md`)                                  |
| `APP_PORT`                                            | no                                                           | `3000`                                     | Host port published by compose                                                                                                                                         |
| `DOCKER_TAG`                                          | no                                                           | `latest`                                   | Image tag referenced by compose                                                                                                                                        |

No real credentials are committed. The defaults above are safe development
values; override them in a git-ignored `.env` or a deployment secret store.
See `.env.example` and `docs/deployment.md`.

## Data, volumes, and backup/restore

- **Database**: named volume `pgdata`.
- **Uploads**: named volume `uploads`, mounted at `/app/data/uploads` in the app
  container. It holds character portrait binaries (the bytes backing an `Asset`
  row). The location is operator-controlled: set `UPLOAD_DIR` to override where
  the app writes and reads portrait files (the default is `/app/data/uploads` in
  production, or `<cwd>/data/uploads` outside production). Files here are private
  by convention - never mounted under `/public` - and are only served through the
  authenticated `/api/assets/[id]` route. Back up this volume together with the
  database: the portrait metadata row lives in Postgres, but the bytes exist only
  on this volume (see `docs/deployment.md`).

```bash
# Dump the database (run on the host next to compose):
docker compose exec postgres pg_dump -U postgres primal_creator > backup.sql

# Restore:
docker compose exec -T postgres psql -U postgres primal_creator < backup.sql

# Back up the uploads volume:
docker run --rm \
  -v primal-creator_uploads:/data \
  -v "$PWD":/backup alpine \
  tar czf /backup/uploads.tar.gz -C /data .
```

See `docs/deployment.md` for the full deployment, operation and restore guide.

## CI / CD

- **CI (`ci.yml`)**: on pull requests only - lint, formatting, typecheck, unit
  tests, build, plus a Postgres-backed migration + seed + smoke job. Never
  publishes.
- **Docker (`docker.yml`)**: on push to `main` and version tags - prerequisite
  checks, then a multi-arch (`linux/amd64`, `linux/arm64`) Buildx build with
  GHCR caching, using a scoped `GITHUB_TOKEN`, pushed to
  `ghcr.io/sepffuzzball/primal-creator`.

## License

MIT - see [LICENSE](LICENSE).
