-- Skills carry no catalog grade band nor grade-specific prose.
--
-- This is an additive migration on top of the 0.1.0 baseline
-- (20261016000000_initial_0_1_0) and its additive currencies migration
-- (20261017000000_currencies). It:
--   1. Creates `legacy_skill_grade_metadata`, an immutable audit table that
--      archives any pre-existing `grade` / `gradeDescriptions` value BEFORE it is
--      cleared, so authored legacy skill grade data is not irretrievably lost;
--   2. Archives only skill rows carrying authored grade data (a non-null `grade`
--      OR a `gradeDescriptions` map that is not the empty `{}`) into that table;
--   3. Clears the `grade` / `gradeDescriptions` value on every `skills` catalog
--      row, and
--   4. Adds a CHECK constraint enforcing the invariant going forward: a `skills`
--      row must always store `grade IS NULL` and `gradeDescriptions = '{}'` (the
--      value may also be NULL, which reads back as the empty map).
--
-- The archive table is keyed by the original catalog definition id (TEXT PRIMARY
-- KEY) and deliberately carries NO foreign key, so the audit record survives even
-- if the catalog row is later deleted. It is a migration-only historical audit, not
-- a live skills feature: no runtime, service, import, MCP or UI path reads or
-- writes it. No other table, column, index or foreign key is modified; no other
-- catalog kind, baseline migration or archived chain is touched. `grade` /
-- `gradeDescriptions` remain fully populated for the graded kinds
-- (races/classes/professions and any other banded definition) and stay read-only
-- null/empty for `gods`, `currencies` and now `skills`. This migration never
-- rewrites an existing offer snapshot or the immutable event journal:
-- `skill_offers.earnedGrade` (the grade whose schedule interval awarded an offer)
-- and its config snapshots are unchanged. Future skill offers match the advancing
-- track only, never a catalog grade.

-- CreateTable
-- Immutable audit table holding the authored legacy skill grade data that this
-- migration is about to clear. Written only by this migration; never read or
-- written by the application.
CREATE TABLE "legacy_skill_grade_metadata" (
    "id" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "grade" TEXT,
    "gradeDescriptions" JSONB NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_skill_grade_metadata_pkey" PRIMARY KEY ("id")
);

-- Archive any pre-existing authored skill grade / gradeDescriptions BEFORE it is
-- cleared. Only a row that actually carries authored grade data is preserved: a
-- skill row with `grade IS NULL` and `gradeDescriptions = '{}'` has nothing worth
-- archiving and is skipped. A NULL `gradeDescriptions` is normalized to the empty
-- map (the value may be NULL, which reads back as the empty map), so the archive's
-- NOT NULL column is never violated.
INSERT INTO "legacy_skill_grade_metadata" ("id", "stableId", "grade", "gradeDescriptions")
SELECT "id", "stableId", "grade", COALESCE("gradeDescriptions", '{}'::jsonb)
FROM "catalog_definitions"
WHERE "kind" = 'skills'
  AND ("grade" IS NOT NULL OR "gradeDescriptions" <> '{}'::jsonb);

-- Clear any leftover skill grade / grade prose so every skills row is uniform.
UPDATE "catalog_definitions"
SET "grade" = NULL, "gradeDescriptions" = '{}'::jsonb
WHERE "kind" = 'skills';

-- Enforce the skill grade invariant at the database layer. A `skills` row must
-- always carry a null grade and an empty (or NULL) gradeDescriptions map; any
-- other value is rejected. Other catalog kinds are unaffected (kind <> 'skills'
-- passes unconditionally). The Prisma schema cannot express a CHECK, so it is
-- appended verbatim, matching the existing quantity / blessing-tier / currency
-- amount constraints.
ALTER TABLE "catalog_definitions"
  ADD CONSTRAINT "catalog_definitions_skill_grade_check"
  CHECK (
    "kind" <> 'skills'::"CatalogKind"
    OR ("grade" IS NULL AND "gradeDescriptions" = '{}'::jsonb)
  );
