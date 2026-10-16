-- Skill track is mandatory + class-priority offer ordering.
--
-- This migration is additive and non-destructive:
--   1. Adds a nullable `classStableIdAtEarn` provenance column to `skill_offers`:
--      the catalog stableId of the character's selected CLASS at the moment a
--      schedule-credit offer was EARNED (class/profession credits), null for a
--      monster race credit and for legacy/imported offers. Priority-only (drives
--      deterministic option ordering), never eligibility. NULL on all existing
--      rows (no backfill).
--   2. Backfills a missing `track` key in every persisted `skills` config JSONB
--      to 'race', preserving every existing key (rarity, effects, milestone, any
--      existing track). A skill without a track is incomplete under the modern
--      config rules, so legacy rows that never declared one are normalized to the
--      'race' default; an existing track (race/class/profession) is left intact.

BEGIN;

-- Earning-time class snapshot for schedule-credit offers. Null on legacy/imported
-- offers and on monster race credits; never backfilled.
ALTER TABLE "skill_offers"
  ADD COLUMN "classStableIdAtEarn" TEXT;

-- Backfill the mandatory `track` on any persisted skills config that lacks it.
-- The JSONB || operator preserves every existing key (including a legacy
-- `milestone` annotation and any existing track value); it only supplies the
-- missing 'race' default. Rows that already carry a valid track are untouched.
UPDATE "catalog_definitions"
SET "config" = "config" || jsonb_build_object('track', 'race')
WHERE "kind" = 'skills'
  AND "config" ->> 'track' IS NULL;

COMMIT;
