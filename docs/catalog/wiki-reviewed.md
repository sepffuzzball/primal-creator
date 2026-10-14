# Wiki-reviewed catalog manifest

This document describes the manually reviewed, version-controlled catalog
manifest that can be applied to the database by an admin. It is **not** a
scraper and it is never applied automatically: an authenticated admin calls
`POST /api/admin/catalog-import` to opt in, and no other code path mutates the
catalog on behalf of this manifest.

## Provenance policy

Every entry in this manifest is labelled `inferred`. The source is the
fan-maintained **The Primal Hunter Wiki (Fandom)** - a secondary source - so this
manifest conservatively marks anything derived from it as `inferred` rather than
asserting it as canon.

That is a choice about this manifest's own entries; it makes no claim about the
rest of the catalog. Rows from other sources (for example, a row created through
the admin catalog UI, or the curated rows the seed writes) carry their own
provenance, and that is independent of this manifest. Because the import never
overwrites an existing row, a pre-existing row's provenance is never rewritten to
`inferred` by the import itself: whatever provenance a row was seeded with is
preserved.

There is **no scraping** here. The Fandom wiki returns HTTP 403 to most direct
page fetches, so the project never fetches a URL at import time. An admin edits
this manifest in code, reviews it, and then applies it.

## Source terms

The Fandom wiki forbids automated scraping (direct HTML page fetches commonly
return 403). That is exactly why these entries are curated by hand into a static
array rather than pulled at build/run time.

## The import operation

- `GET /api/admin/catalog-import` - admin-only **preview**. Computes, against the
  live database and without writing anything, which manifest entries would be
  created and which would be skipped because a row with the same `(kind,
stableId)` already exists.
- `POST /api/admin/catalog-import` - admin-only **apply**. Validates every entry,
  then inserts all missing rows in **one** `SERIALIZABLE` transaction. Existing
  rows are never overwritten; an identical repeated call skips every existing row.
  A conflicting concurrent import surfaces as a 409 with no partial write.

There is no separate audit table and no immutable import event journal. Catalog
rows carry their own metadata - the `createdAt` / `updatedAt` timestamps,
`sourceUrl`, `provenance`, and `archived` flag - but these are ordinary, editable
row fields, not an append-only record of import events. The apply response
identifies the created row ids, and the row timestamps indicate when a row was
written, but there is no journal that logs the sequence of import operations.

## Curated entries

All entries list the exact source page they were reviewed against. A
"corroboration" link, where present, is a secondary reference (the fan wiki page
is the primary evidence). None of these entries assert a universal numeric bonus
unless the source supports one.

### 1. Alchemist of the Malefic Viper (profession, grade F)

- kind: `professions`
- stableId: `alchemist-of-the-malefic-viper`
- grade: `F`
- config: `grades.F = { fixed: { vitality: 2, wisdom: 2, willpower: 1,
toughness: 1 }, free: 2 }` (per grade-F level).
- source: https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Profession
- corroboration (secondary): https://system-codex.com/series/the-primal-hunter/entries/alchemist-of-the-malefic-viper

The exact per-level numbers are an inferred reading; they are stored in
`config.grades.F` so an admin can correct them against the source. The row grade
is `F`.

### 2. True Blessing of the Malefic Viper (blessing, tier True)

- kind: `blessings`
- stableId: `true-blessing-malefic-viper`
- config: `{ tier: "True", effects: [] }`
- source: https://the-primal-hunter.fandom.com/wiki/True_Blessing_of_the_Malefic_Viper

`effects` is intentionally an **empty list**. Blessing tiers evolve in the source
and the numerical stage at this tier is not pinned by a reliable table, so the
manifest records it as narrative-only rather than inventing a numeric bonus. No
universal numeric bonus is asserted for this blessing.

### 3. Bloodline of the Primal Hunter (bloodline)

- kind: `bloodlines`
- stableId: `bloodline-primal-hunter`
- config: `{ effects: [], gradeEffects: {} }`
- source: https://the-primal-hunter.fandom.com/wiki/Bloodline_of_the_Primal_Hunter

`gradeEffects` is deliberately **empty**. The wiki documents only fragmentary
grade evidence for this bloodline, so no general numeric default is inferred. A
future curator can populate `gradeEffects` once reliable per-grade numbers are
sourced.

### 4. One Step Mile (skill)

- kind: `skills`
- stableId: `one-step-mile`
- config: `{ effects: [] }`
- source: https://the-primal-hunter.fandom.com/wiki/One_Step_Mile

This entry has **no** `track` / `milestone`. It is a descriptive skill: the offer
generator never auto-offers it at a class/profession milestone. It remains
metadata-only until an admin adds a milestone.

### 5. Gaze of the Apex Hunter (skill)

- kind: `skills`
- stableId: `gaze-of-the-apex-hunter`
- config: `{ effects: [] }`
- source: https://the-primal-hunter.fandom.com/wiki/Gaze_of_the_Apex_Hunter

Same treatment as One Step Mile: no `track` / `milestone`, so it is never
auto-offered at a milestone.

### 6. Legendary Prodigy (title)

- kind: `titles`
- stableId: `legendary-prodigy`
- config: `flat` +10 and `percentBasisPoints` +1000 (i.e. +10%) on all nine
  attributes (`strength`, `agility`, `endurance`, `vitality`, `toughness`,
  `perception`, `intelligence`, `wisdom`, `willpower`).
- source: https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy
- corroboration (secondary): https://system-codex.com/series/the-primal-hunter/entries/legendary-prodigy

The values are an inferred reading and are stored as `flat` / `percentBasisPoints`
so an admin can correct them against the source.

## Relationship to the seeded Jake catalog

The reviewed manifest above is the **admin opt-in** import, not what `db:seed`
runs. `pnpm db:seed` separately seeds a curated Jake Thayne catalog
(`prisma/catalog/jake-seed.ts`): the Human race table, Jake's five class
progression definitions, his five alchemist profession progression definitions,
and the fifteen god names (each god a metadata-only row with an empty `config`,
backed by its own wiki page). That seed and this manifest share exactly one
stableId - the F-grade profession `alchemist-of-the-malefic-viper` - so whichever
applies first creates the row and the other preserves it: the seed never
overwrites an existing row, and the import skips existing rows. See
`docs/rules/races.md`, `docs/rules/classes.md` and `docs/rules/professions.md` for
the seeded definitions.

## What is deliberately not asserted

- **Blessings**: no numeric `effects` for a tier whose numbers are not sourced.
- **Bloodlines**: no general numeric bonus; `gradeEffects` is empty.
- **Skills**: no universal numeric effect and no default milestone offer.
- **Acquisition**: these entries never grant anything to a character and never
  enforce acquisition. They only make the catalog row available so an admin or
  the engine can reference it later.
