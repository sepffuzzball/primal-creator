-- Gods carry no catalog grade band. A `gods` catalog entry expresses divine power
-- and blessing tier through its `blessingEffects[tier]` map, never through the
-- shared `catalog_definitions.grade` column (which races/classes/professions and
-- other graded kinds use). Any god row that was authored before this invariant
-- existed may still carry a non-null `grade`; null it so every god reads back
-- with `grade IS NULL` and no god can carry a grade from here on.
--
-- WHAT CHANGES
--   * `catalog_definitions.grade` is set to NULL for every `kind='gods'` row.
--     No rows are deleted and no columns/tables are altered: the god's config
--     (including `blessingEffects`, `pantheon`, `divineRank`) and any character
--     associations / equipment references to it are preserved untouched.
--
-- NON-DESTRUCTIVE: only a `grade` column value is cleared on gods rows. There is
-- no user-visible data loss, so no backup is required for this migration alone.
--
-- From here on the application (service + import) enforces the same invariant:
-- a create/update/import that tries to set a non-null grade on a gods entry is
-- rejected with 400 `invalid_grade`, and only `grade IS NULL` is legal.

BEGIN;

-- Clear any stale grade on a gods entry. The WHERE clause limits the update to
-- gods rows that actually carry a grade, so a row that already has `grade IS
-- NULL` (the migrated/valid state) is left as-is.
UPDATE "catalog_definitions"
SET "grade" = NULL
WHERE "kind" = 'gods'
  AND "grade" IS NOT NULL;

COMMIT;
