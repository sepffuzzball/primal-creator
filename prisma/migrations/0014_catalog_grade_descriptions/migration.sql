-- Add independently editable, grade-specific catalog descriptions.
--
-- `catalog_definitions.gradeDescriptions` is a JSONB map keyed by the grade
-- ladder (G..S) carrying prose authored independently of the legacy
-- `description` string and of the entry's own `grade` band. It is additive and
-- non-destructive: existing rows default to `{}`, so an entry with no authored
-- grade text reads back as an empty map, and no legacy data is migrated or
-- rewritten. Cannot be NULL - the `{}` default is the only value an entry with
-- no authored grade text ever carries.

BEGIN;

ALTER TABLE "catalog_definitions"
  ADD COLUMN "gradeDescriptions" JSONB NOT NULL DEFAULT '{}';

COMMIT;
