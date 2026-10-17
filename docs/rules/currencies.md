# Currencies

## Source & status

- Source: in-world tender named by the curator; a `currencies` catalog entry is
  authored into the Catalog by an admin (via the admin catalog path, the MCP
  publisher, or a bulk/wiki-reviewed import). Individual currency definitions
  are curated content, not engine rules.
- `currencies` is a **canonical catalog kind**, created after the `items` kind
  was introduced; it appears in the canonical kind list
  (`races`, `classes`, `professions`, `titles`, `equipment`, `skills`,
  `bloodlines`, `items`, `gods`, `transcendent_skills`, `currencies`). It is NOT
  an `evolutions` style legacy alias and there is no `consumables`-style rename
  for it.

## Catalog kind shape

A `currencies` entry is **pure identity + narrative**:

- It carries **only** a `name` (required) and a nullable `description`.
- It has **no grade band**: the shared `catalog_definitions.grade` column is
  always `null`. A create/update, wiki-reviewed import, bulk upload, or managed
  publish that sets a non-null grade is rejected with 400 `invalid_grade`
  before any write (`currencyGradeForbidden`).
- It has **no grade ladder**: `gradeDescriptions` must be empty (`{}`) or
  omitted. A non-empty map is rejected with 400 `invalid_grade_descriptions`
  before any write (`currencyGradeDescriptionsForbidden`).
- Its `config` is **strictly the empty object `{}`** (`currencyConfigSchema` is
  `z.object({}).strict()`). Any key is rejected; an omitted config reads back as
  `{}`. The durable per-character holdings of a currency are NOT modeled in the
  config - they live in the `character_currency_balances` table (below).

A currency is a named in-world tender with intrinsic holdings. It carries **no
price, no purchase, no inventory quantity, and no engine effect**: it is never
synthesized from a catalog config, is not a consumable/equipment stock count, is
not consumed by the calculation engine, and its existence does not mutate
`Character.state`.

## Durable balances (character_currency_balances)

A character's holding of a currency is a durable row in
`character_currency_balances`, keyed uniquely by `(characterId, definitionId)`:

- `amount` is a nonnegative whole number `0..2147483647` (the DB CHECK upper
  bound, well below the safe-integer limit). `0` is a **legal stored value** (a
  zero-holding row is kept so the explicit character-currency association is
  preserved). An **absent** row means "no recorded balance";
  `amount: null` (a blank/unset field) removes the stored row.
- The holding persists **outside** `Character.state`. Setting a balance emits
  **no progression event** and never mutates character state - currency
  bookkeeping is an end in itself, not an economic event.
- The `character_currency_balances` table is created by the additive
  `20261017000000_currencies` migration (see below).

### Sheet / API (owner or admin only)

- `GET /api/characters/[id]/currencies` -> `{ currencies, version }`. Returns
  every **active** (unarchived) `currencies` catalog definition joined with the
  character's stored balance. An active currency the character does not hold
  reads back with `amount: null`. A balance saved against an **archived**
  currency definition is **hidden** from this view but retained, so reactivating
  the definition later reveals the kept amount.
- `PATCH /api/characters/[id]/currencies` with
  `{ definitionId, amount, version }` -> `{ version }`. `amount` is a nonnegative
  whole number `0..2147483647` or `null` (removes the row). Only an **active**
  (unarchived) `currencies` definition is accepted: a missing definition is 404,
  and an archived or non-currency definition is rejected (a balance saved
  against an archived currency is preserved for a later reactivation but cannot
  be written while archived). The write runs under SERIALIZABLE, CASes the
  character version, and maps a `P2034` (concurrent write) to a 409; a stale
  `version` 409s and rolls the change back. Setting the already-stored amount
  (or setting `null` when no row exists) is an idempotent no-op that never bumps
  the version, but a stale no-op still 409s.
- Ownership: the **owner or an admin** may read/write. A non-owner is 403
  `forbidden`. An **archived character is read-only**: the read path still
  works, but a currency write on an archived character is rejected with 400
  `character_archived`.

### Distinct balance cap (500, archived included)

A character may hold at most **500 distinct** currency balance rows
(`MAX_IMPORT_CURRENCIES`), and archived balances count toward the cap - a hidden
amount must survive a backup round-trip. Creating the 501st distinct row on a
manual set is a 409 `currency_defs_cap_exceeded` ("the trusted-backup export
cannot round-trip more"). Updating or deleting an existing row is always allowed
at the cap. This mirrors the trusted-backup import cap (below) so an exported
character always re-imports cleanly.

## Export / import (trusted-backup schema v8)

`exportCharacter` emits the **only** schema it ever produces:
`primal-character/8`. The v8 document is everything v7 carries PLUS a **required**
`currencyBalances` array:

- Each entry is `{ definition: { kind: "currencies", stableId }, amount }` where
  `amount` is a nonnegative whole number `0..2147483647`; `0` is exported as a
  legal stored value. The reference uses the catalog **stableId** (never the DB
  id) so a re-import on another server instance can resolve it against its own
  catalog. An **archived** currency definition's balance is still exported - a
  hidden amount must survive a backup round-trip. Only rows whose definition is
  actually a `currencies` entry are emitted.
- The document schema bounds `currencyBalances` to 500 distinct entries and
  rejects a duplicate currency stableId at the schema boundary (`Duplicate
  currency definition stableId`).

A legacy **v3-v7** document has **no** `currencyBalances` field, so importing one
produces **no balances**.

On import, every reference is matched by local `kind` + `stableId` to an EXISTING
`currencies` catalog definition; an archived currency definition is allowed and
imported inert (a hidden amount survives). The following are rejected before any
DB write:

- a wrong-kind reference (the stableId belongs to a non-`currencies` catalog
  entry) - 400 `import_currency_wrong_kind`;
- a genuinely missing definition - 400 `import_currency_missing` (the resolver
  distinguishes a wrong-kind reference from a missing currency so the error is
  actionable);
- a duplicated definition reference - 400 `import_duplicate_currency`;
- an out-of-range / non-integer amount - 400 `import_currency_invalid`.

Balances are written transactionally with the character and its associations/
inventory; any resolve failure above rolls the whole import back.

## Migration (20261017000000_currencies)

The `prisma/migrations/20261017000000_currencies` migration is **additive** on
top of the 0.1.0 baseline (`20261016000000_initial_0_1_0`). It:

1. Adds the `currencies` value to the `CatalogKind` enum (`ALTER TYPE ...
   ADD VALUE IF NOT EXISTS`, so it is idempotent - a database that already
   carries the value is not rejected); and
2. Creates `character_currency_balances` (uuid PK, `characterId`, `definitionId`,
   `amount` INTEGER NOT NULL, timestamps, a unique `(characterId, definitionId)`
   index, an FK to `characters` on `ON DELETE CASCADE`, an FK to
   `catalog_definitions` on `ON DELETE RESTRICT`), plus a CHECK constraint
   (`character_currency_balances_amount_check`) enforcing
   `0 <= amount <= 2147483647`.

No existing table, column or index is modified and no baseline migration or
archived chain is touched. There is no economic mechanic or event journal here -
only the persistence shape.

### Deployment

- The currencies migration is part of the **normal** `prisma migrate deploy`
  run (`pnpm db:migrate`), which applies migrations in order under
  `prisma/migrations` (the baseline, then the additive currencies migration).
  Because it is additive, a fresh or handed-off database needs only
  `db:migrate` + `db:seed` - **no destructive reset** is required to gain the
  currencies feature.
- The one-time guarded reset (`pnpm db:reset:0.1.0`, see `docs/deployment.md`
  section 1.4) applies **both** the 0.1.0 baseline AND the additive currencies
  migration and verifies the combined result. It is explicitly opt-in and
  fail-closed and is **not** the routine path: a fresh/empty database (or one
  already on the 0.1.0 baseline, hardened by `db:migrate`) never needs it.

## Engine note

Currencies are inert to the engine: no stat/skill/inventory effect is derived
from a currency, no formula invents a price or value, and the only authoritative
number is the integer `amount` the owner/admin bookkeeps. That number is stored
verbatim, never computed. Where the world needs a currency for a cost, the
curator authors that as catalog prose/description rather than as a mechanic.
