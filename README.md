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
  questionnaire for an enlightened race - race type first, then name/description,
  origin, and race/class/profession picked from the catalog (a monster race
  branch is six steps: race type, name, origin, race, special abilities, review) -
  advance class/profession, allocate attribute points, evolve the race grade,
  edit name, description and all six narrative profile fields (nickname, pronouns, age description, appearance, biography and notes), archive and restore.
- **Contextual race evolution paths**: race evolution is not a single hard-coded
  house formula. The `evolutions` catalog kind defines editable race paths
  (`track: "race"` with `fromRaceStableId`/`toRaceStableId`/`fromGrade`/`toGrade`
  and optional `minRaceLevel`, required title/skill stableIds, and a
  `manualRequirementsText` gate). The client fetches the contextual options via
  `GET /api/characters/[id]/evolutions` and submits a chosen `optionId` to
  `POST /api/characters/[id]/evolve`. The legacy grade-only house evolution is
  retained as a fallback and is accepted only when NO valid catalog path to the
  requested grade exists (otherwise the server returns `409
evolution_choice_required`).
- **Contextual class/profession track evolution paths**: class and profession
  tracks are graded independently of the race. A new character is stamped with
  the race's exact `naturalGrade` grade (legacy fallback `F`) and a
  `stableId:<grade>` definition on each selected track, so each track has its own
  progression gate (the catalog must define a `grades.<grade>` per-level config
  for the track). The `evolutions` catalog kind also carries
  active **class/profession paths** (`track: "class"|"profession"` with
  `fromDefinitionStableId`/`toDefinitionStableId`/`fromGrade`/`toGrade`, plus
  optional `minTrackLevel`, required title/skill stableIds, and a
  `manualRequirementsText` gate). The client fetches the track-specific options
  via `GET /api/characters/[id]/evolutions?track=class|profession` and submits a
  chosen `optionId` to `POST /api/characters/[id]/evolve`. There is **no**
  grade-only legacy fallback for class/profession; only the target track's grade
  and definition are updated, and the race grade is never auto-changed.
- **Resumable creation drafts**: the questionnaire is persisted per user as an
  authenticated, owner-scoped draft (one per user) so work is never lost. A draft
  stores only validated, whitelisted fields (`step`, name/description, origin,
  race/class/profession, an explicit `specialAbilities` selection of catalog ids -
  at most one blessing, at most one bloodline and up to 8 transcendent skills
  (the `transcendentSkillIds` array is bounded at 8 by the transport/request
  schema; the effective per-character cap is the admin-configurable
  `maxTranscendentSkills`, default 3, bounded 0..8) - plus
  a legacy `special` boolean kept read-only (always normalized to `false` from the
  wizard) and an equipment list, plus optional narrative fields), bounded and
  capped at 256KiB - no uploaded binaries and no stat/award/effect fields. Drafts
  are optimistic-concurrency versioned (a stale write 409s) and are **not
  authoritative character state**: final creation of a `Character` (and its engine
  state) is a separate, still-transactional operation. The wizard's final create
  step accepts an optional `draftVersion`; when supplied the matching draft is
  deleted atomically inside the same transaction as the character row and its
  `create` journal event, and a stale version 409s `draft_conflict` and rolls back
  the whole create (no second best-effort DELETE). When `draftVersion` is omitted
  (non-wizard clients) the draft is never touched. The wizard sends `name`,
  `description`, `origin`, `raceId`, `classId`, `professionId` (as applicable),
  `specialAbilities` and `draftVersion` to create; the `special`/`equipment` flags
  and the optional narrative fields are draft-only and never persisted to the
  character as fake powers. Each selected `specialAbilities` id is resolved by its
  catalog kind, required to be unarchived (active) and the right kind, and checked
  for overlap/collision (one blessing, one bloodline, at most
  `maxTranscendentSkills` transcendent skills, distinct ids with no cross-field
  overlap), and the resulting `BLESSING` /
  `BLOODLINE` / `TRANSCENDENT` associations are inserted atomically inside the
  same transaction as the character row, the `create` event and the optional draft
  delete - a missing/archived/wrong-kind/duplicate/collision selection rejects the
  whole create, and the legacy `special` boolean never grants a power on its own.
  The wizard always persists `special: false` (it never submits `special: true`),
  so a legacy draft that carried the flag is normalized rather than treated as
  character state. An optional portrait chosen at creation is **not** part of this
  atomic create: it is uploaded after the character exists, so a failed upload
  never rolls back the character (the attachment is not atomic). Other draft
  metadata (nickname, pronouns, age, appearance, biography, notes) is preserved in
  the draft but not yet sent to the character.
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
- **Immutable history & trusted-backup export/import**: every progression event is
  written to an append-only journal, and a character (state + live status + skill
  offers + journal) can be exported as a `primal-character/6` JSON backup keyed by
  stable catalog identifiers. A backup can be re-imported (`POST
/api/characters/import`) as a NEW character owned by the current user; it is a
  trusted-but-unverified backup, so it is marked `imported` in the UI and its
  history is stored as source provenance (`import_history` events) rather than
  treated as server-verified. The live status is recomputed from the current
  catalog, catalog references are resolved by `kind` + `stableId` (no catalog
  content is auto-created), and any required definition that is missing, archived,
  or the wrong kind rejects the whole import. The current v6 backup carries owned
  inventory quantities and a `legacyUnowned` marker on equipment associations
  (grandfathered links may round-trip with zero stock), a per-link ring
  `equipmentPosition` so a character's two `Ring`-slot rings round-trip their
  physical positions, and the append-only skill-offer generation and cancellation
  state (every exported offer records a `generation` and a nullable `canceledAt`).
  The v5 backup carried the inventory, `legacyUnowned` marker and ring positions
  but no such offer-generation/cancellation state; the legacy
  `primal-character/3` through `primal-character/5` backups are still accepted (v5
  imports without offer generations, v4 imports stock, and v3 imports none and
  marks every equipment link grandfathered). No sample characters are created.
- **Admin-managed catalog**: a polymorphic catalog for all of the kinds above.
  Admins can create and edit entries, attach a source URL, and store per-kind
  `config`. With
  `CATALOG_PUBLIC` unset, catalog reads require a session.
- **Admin opt-in catalog import (reviewed manifest)**: an admin can apply a
  manually reviewed, version-controlled manifest
  (`prisma/catalog/wiki-reviewed.ts`) with `GET` / `POST /api/admin/catalog-import`.
  The `GET` preview is read-only; the `POST` apply inserts every missing row in one
  atomic `SERIALIZABLE` transaction and never overwrites an existing row (the
  entry is skipped instead). It is never run by `db:seed` or app startup. See
  `docs/catalog/wiki-reviewed.md` for the source policy, exact per-entry URLs and
  the "no fabricated numeric bonus" policy.
- **Admin bulk catalog upload (JSON / CSV)**: an admin can paste a JSON or CSV
  catalog file and preview it (`POST /api/admin/catalog-import/bulk/preview`),
  then apply it (`POST /api/admin/catalog-import/bulk/apply`). The preview is
  read-only; the apply inserts every missing row in one atomic `SERIALIZABLE`
  transaction and never overwrites an existing row. `sourceUrl` is optional but
  HTTPS when supplied (an unverified admin paste must not claim a `verified`
  status), and would-create blessings revalidate their patron god against
  both the live catalog and gods created by the same upload (archived / missing
  patrons roll back the whole import). An optional content digest (SHA256 of the
  uploaded text) is a content-integrity check, not proof that a preview ran;
  preview is UI policy, not a server-enforced prerequisite. Like the reviewed
  manifest, it is never run by `db:seed` or app startup, and created rows are
  never auto-granted to characters.
  See `docs/catalog/bulk-import.md`.
- **Title & equipment linking**: a character can attach real catalog titles and
  equip catalog equipment. Effects and equipment bonuses are synthesized live
  from the **current**, unarchived catalog config at read time; the stored
  `Character.state` and the event journal stay immutable, so editing a catalog
  entry recalculates status without rewriting history. This is direct equip
  backed by owned stock, not a free inventory assumption: new equips require an
  owned equipment quantity of at least 1 (`qty >= 1`). Legacy equipped
  associations (created before owned stock was enforced) are grandfathered and
  remain usable and removable at zero stock. A same-slot swap retains the
  existing stock rather than consuming a new copy. Live effects still recalculate
  from the current catalog as before.
- **Consumables on a character**: a character can consume real catalog
  consumables, and each consumption requires and decrements exactly one owned
  stock of that consumable in the same compare-and-swap (CAS) transaction as the
  stat gain/effect and the immutable journal event - there is no free direct
  consumption. Permanent consumables grant a permanent external stat gain
  capped by the grade-based race-level capacity (F3/E5/D15/C45, a **house**
  assumption pending verification); temporary potions produce a temporary effect
  that expires after a number of quarters. Every consumption mutates the stored
  state and writes an immutable `consume` progression event to the journal.
- **Manual inventory management UI/API**: an authenticated owner/admin can adjust
  the owned equipment and consumable stock on an active character from a
  dedicated inventory UI/API. Adjustments are made in bounded quantities, each
  requires a source note (recorded, audited), and stock on an archived character
  is discarded. An equipment's final owned copy cannot be discarded while it is
  still equipped. There is no economy, stack-cap or instance system - stock is a
  bounded owned quantity per association, not a market of instances. The v4/v3
  backup behavior for owned stock is already documented above.
- **Admin-editable house rules**: the equipment (20% individual / 15% combined)
  and consumable (F3/E5/D15/C45) defaults are NOT hard-coded. They are served from
  a single server-wide `house_rules` row and edited by an admin from the Settings
  page (`GET`/`PATCH /api/admin/rules`, optimistic-concurrency versioned - a stale
  write 409s and never silently clobbers a concurrent edit). The same config also
  carries `maxTranscendentSkills` (default 3, bounded 0..8) - the maximum number
  of transcendent skills a character may carry, enforced at create, on
  association add, and on backup import. A change takes effect
  on the next read or mutation (live status is always re-derived from the current
  config) and never rewrites historically awarded stats or the persisted state;
  the current version is exposed as `rulesetVersion` on character reads. Non-admin
  users see no editor.
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
- **Transcendent skills**: transcendents are no longer encyclopedia-only. A
  `transcendent_skills` catalog kind and a `transcendent` character association
  kind let an owner/admin explicitly link distinct transcendent skills to a
  character (no automatic reward, no blessing singleton, no `upgradeGroup`
  replacement). A character may carry at most `maxTranscendentSkills` such links
  (admin-configurable, default 3); an add is rejected (`link_limit`) once the cap
  is reached and a create/import over the cap is rejected before any write. Each
  entry declares a modern `passiveEffects` list (typed
  flat/percent with per-effect stacking group + condition, using the shared skill
  effect schema) and optional prose `costDescription` / `acquisitionNotes` that
  are surfaced but never treated as a mechanical cost or triggered power. The
  character detail derives an `isTranscendent` boolean from whether at least one
  linked, unarchived `transcendent_skills` definition exists - recomputed at read
  time, never persisted - and passive effects are synthesized live from the
  current catalog config so history stays immutable. See
  `docs/rules/transcendents.md`.
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

The engine and schema already account for these, but they are not fully wired up:

- **Catalog auto-creation**: `db:seed` seeds a curated Jake Thayne catalog
  (`prisma/catalog/jake-seed.ts`) - the Human race table, Jake's five class and
  five profession progression definitions, and the fifteen god names. A reviewed,
  version-controlled manifest (`prisma/catalog/wiki-reviewed.ts`) can additionally
  be applied by an admin as an explicit opt-in (`POST /api/admin/catalog-import`) -
  see `docs/catalog/wiki-reviewed.md` - and an admin can bulk-upload JSON/CSV
  content (`POST /api/admin/catalog-import/bulk/preview` and `/bulk/apply`) - see
  `docs/catalog/bulk-import.md`. The manifest and bulk upload are explicit opt-ins
  and are never run by `db:seed` or app startup; nothing auto-creates catalog
  content at startup. Character backups are imported, but external catalog content
  is never created implicitly outside the curated seed and the admin opt-ins.

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
- TypeScript, ESLint, Vitest, Prettier (Tailwind plugin), Playwright (browser E2E)

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

### Browser E2E (Playwright)

The authenticated character lifecycle is covered by a Playwright Chromium E2E
test (`e2e/character-flow.spec.ts`). It logs in through the UI, asserts the
dashboard starts empty, walks the eight-step enlightened-branch questionnaire
(born / Human / Archer / no profession), creates a uniquely-named character,
advances the class
track four quarters, allocates one attribute point, and archives the character.

The E2E is designed to run against a **fresh, isolated test database** with a
**dedicated test-only admin account** - never against your real user data. The
seed creates no characters and no draft, so a freshly migrated and seeded test
database starts empty, and the test asserts that up front (it fails loudly
rather than cleaning up) before creating anything. The only character it ever
changes is the one it creates, which it archives at the end and never restores.
Repeated runs against the same test database are fine: prior runs leave that
character archived, and the dashboard excludes archived characters by default,
so leftovers never reappear as active and are never touched.

These tests are **gated**: an ordinary `pnpm test:e2e` refuses to run unless both
hold, so your dev database is never accidentally mutated:

- `RUN_BROWSER_TESTS=1` is set, and
- the effective `DATABASE_URL` names an isolated **test** database (the name
  must contain `_test` or `test_`, e.g. `primal_creator_test`).

The test database must start with **no active characters and no resumable
draft**; if it does, the test fails with a clear message telling you to
drop/reseed. Do not point it at a database that already holds real characters.

To run them locally against a scratch database (Chromium is installed on first
run; Linux may need `pnpm exec playwright install --with-deps chromium`):

```bash
# 1. Create a fresh, isolated test database (name contains `_test`).
createdb primal_creator_test

# 2. Migrate and seed it with test-only admin credentials. The seed creates no
#    characters and no draft, so the database starts empty.
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/primal_creator_test?schema=public" \
ADMIN_EMAIL="admin@primal.local" \
ADMIN_PASSWORD="PrimalE2eStrongPass-9713" \
  pnpm db:migrate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/primal_creator_test?schema=public" \
ADMIN_EMAIL="admin@primal.local" \
ADMIN_PASSWORD="PrimalE2eStrongPass-9713" \
  pnpm db:seed

# 3. Run the browser tests with the SAME dedicated test account. The credentials
#    must match the seeded admin exactly, and this account is the only one the
#    tests log in as - user data is never touched.
RUN_BROWSER_TESTS=1 \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/primal_creator_test?schema=public" \
E2E_ADMIN_EMAIL="admin@primal.local" \
E2E_ADMIN_PASSWORD="PrimalE2eStrongPass-9713" \
  pnpm test:e2e
```

Playwright starts the app itself on `127.0.0.1:3101` via the `webServer` block
(`pnpm dev -p 3101`), so you do not need to run `pnpm dev` first. It always
starts its own server (`reuseExistingServer: false`): if something is already
listening on that port (for example a dev server pointed at a different
database), the run fails on the port conflict instead of silently reusing the
wrong server. Passwords are test-only placeholders and are never committed.

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

Behind a reverse proxy, set `APP_ORIGIN` to the real public origin (for this
deployment, `APP_ORIGIN=https://primalcreator.fuzzball.enterprises`) so the
strict, exact-origin CSRF check accepts the browser's origin; without it sign-in
writes fail with `403 bad_origin`. The optional `TRUST_PROXY_HEADERS` and
`APP_BIND_ADDRESS` variants are described in `docs/deployment.md`.

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
| `APP_BIND_ADDRESS`                                    | no                                                           | `0.0.0.0`                                  | Host interface the published port binds to. Set `127.0.0.1` for a same-host reverse proxy (see `docs/deployment.md`)                                                   |
| `APP_ORIGIN`                                          | no (recommended behind a reverse proxy)                      | unset                                      | Real public browser origin for the strict CSRF same-origin check; the immediate fix for `403 bad_origin` behind a proxy (see `docs/deployment.md`)                     |
| `TRUST_PROXY_HEADERS`                                 | no                                                           | `false`                                    | Opt-in: rebuild the expected origin from exactly one `X-Forwarded-Proto`/`X-Forwarded-Host` when `APP_ORIGIN` is unset (see `docs/deployment.md`)                      |
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
  tests, build, plus a Postgres-backed migration + seed + smoke job and an
  isolated `primal_creator_test` Playwright browser-checks job (Chromium). Never
  publishes.
- **Docker (`docker.yml`)**: on push to `main` and version tags - prerequisite
  checks, DB integration checks, and a Playwright browser-checks job (Chromium)
  against an isolated `primal_creator_test` database; only then a multi-arch
  (`linux/amd64`, `linux/arm64`) Buildx build with GHCR caching, using a scoped
  `GITHUB_TOKEN`, pushed to `ghcr.io/sepffuzzball/primal-creator`.

## License

MIT - see [LICENSE](LICENSE).
