-- Independent monstrous race skill-choice credits + configurable G-grade pacing.
--
-- This migration is additive and non-destructive:
--   1. Adds ONLY the `G` key into the singleton `house_rules.config` JSONB
--      `skillChoiceIntervals` object (default 5), preserving every existing key -
--      including any customized F/E/D/C/B/A/S interval values - and any other
--      top-level config keys (equipment caps, consumable rates, transcendent
--      cap). It never rewrites the F/S values and never touches the other keys.
--      It uses the JSONB `||` operator on the nested object so a config that
--      already carries a customized `skillChoiceIntervals` (e.g. re-running on a
--      dev database) keeps its F-S values and only gains the G entry.
--
-- There is NO skill_offers schema change this pass: `track` is already a TEXT
-- column and accepts the "race" track value, and the `earnedGrade` /
-- `trackDefinitionStableId` provenance columns (added by migration 0021) already
-- carry the schedule-credit provenance for a race offer unchanged.

BEGIN;

-- Merge the G-grade skill-choice interval into the nested skillChoiceIntervals
-- object, preserving all existing keys. If the stored config has no
-- `skillChoiceIntervals` key at all, start from an empty object.
UPDATE "house_rules"
SET "config" = "config" || jsonb_build_object(
  'skillChoiceIntervals',
  COALESCE("config" -> 'skillChoiceIntervals', '{}'::jsonb) || '{"G":5}'::jsonb
)
WHERE "id" = 'active';

COMMIT;
