-- Configurable class/profession skill-choice milestone credits.
--
-- This migration is additive and non-destructive:
--   1. Adds `skillChoiceIntervals` to the singleton `house_rules.config` JSONB
--      (preserving every other key) so the admin-editable schedule is available
--      to the offer creator. The singleton row is seeded during migration 0007;
--      this only merges the new key in and never touches the other keys.
--   2. Adds two nullable provenance columns to `skill_offers` for schedule
--      credits. Both are NULL on legacy/imported offers (no backfill).

BEGIN;

-- Merge the default skill-choice interval schedule into the stored config,
-- preserving all existing keys (equipment caps, consumable rates, transcendent
-- cap). Uses the JSONB `||` operator so an existing config that already carries
-- `skillChoiceIntervals` (e.g. re-running on a dev database) is overwritten with
-- the documented default rather than double-nested.
UPDATE "house_rules"
SET "config" = "config" || '{"skillChoiceIntervals":{"F":5,"E":5,"D":20,"C":30,"B":40,"A":50,"S":60}}'::jsonb
WHERE "id" = 'active';

-- Provenance on a schedule (milestone) credit. `earnedGrade` is the grade whose
-- skill-choice interval awarded the offer; `trackDefinitionStableId` is the
-- selected track's catalog stableId. Both stay NULL for legacy/imported offers.
ALTER TABLE "skill_offers"
  ADD COLUMN "earnedGrade" TEXT,
  ADD COLUMN "trackDefinitionStableId" TEXT;

COMMIT;
