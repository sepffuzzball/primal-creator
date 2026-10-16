-- Retire the legacy `blessings` catalog kind and god-patron blessing model in
-- favor of a god + tier model, and add a nullable tier column to blessing links.
--
-- WHAT CHANGES
--   * A `BLESSING` CharacterAssociation no longer points at a `blessings`
--     catalog row. Its `definitionId` now references a `gods` catalog entry
--     (the god that granted the blessing), and the link carries a nullable
--     `blessingTier` (the eight-tier blessing hierarchy) that was granted. The
--     live effect is synthesized from the god's current `blessingEffects[tier]`
--     at read time; the tier is never inferred from the god config.
--   * The legacy `blessings` catalog kind is retired: every `blessings` row is
--     deleted after a FK preflight check, and every legacy `BLESSING` link is
--     deleted. A legacy link that cannot be mapped to a god + tier is dropped
--     (never guessed) - see docs/rules/blessings.md.
--   * `catalog_definitions.patronId` (and its FK / index) are removed. The
--     `CatalogKind` enum value `blessings` is intentionally left DORMANT (the
--     enum type is NOT altered), so a stale backup/manifest that still names
--     `blessings` keeps validating; only the rows are removed.
--
-- DESTRUCTIVE: legacy `BLESSING` links and `blessings` catalog rows are deleted.
--
-- Safety preflight: `catalog_definitions` is referenced by RESTRICT foreign keys
-- from `characters`, `character_associations`, `character_inventory_items`,
-- `skill_offer_options` and `skill_offers`. A `blessings` row should never be
-- referenced by any of these after the BLESSING links are removed, but we
-- preflight-check before deleting so a genuinely-referenced row aborts the
-- migration with a clear message instead of a raw FK error.

BEGIN;

-- Create the eight-tier blessing enum. Baptism is the lowest entry tier (a
-- ritual marking a follower as an adherent, below the seven substantive
-- blessing levels Minor..True).
CREATE TYPE "BlessingTier" AS ENUM (
  'Baptism', 'Minor', 'Lesser', 'Intermediate', 'Major', 'Greater', 'Divine', 'True'
);

-- Add the nullable tier column to character_associations. Only a BLESSING link
-- stores a value; every other kind stays null.
ALTER TABLE "character_associations" ADD COLUMN "blessingTier" "BlessingTier";

-- Delete every legacy BLESSING association. Its `definitionId` pointed at a
-- `blessings` catalog row, which is being retired; the new god + tier model
-- re-links via the god's definitionId and the per-link tier. A legacy link that
-- cannot be mapped (the catalog row / patron is gone) is dropped, never guessed.
DELETE FROM "character_associations" WHERE "kind" = 'BLESSING';

-- Preflight-check that no `blessings` catalog row is still referenced by a
-- RESTRICT FK before deleting it.
DO $$
DECLARE
  referenced integer;
BEGIN
  SELECT count(*)
  INTO referenced
  FROM catalog_definitions bl
  WHERE bl.kind = 'blessings'
    AND (
      EXISTS (SELECT 1 FROM characters c WHERE c."raceId" = bl.id OR c."classId" = bl.id OR c."professionId" = bl.id)
      OR EXISTS (SELECT 1 FROM character_associations a WHERE a."definitionId" = bl.id)
      OR EXISTS (SELECT 1 FROM character_inventory_items i WHERE i."definitionId" = bl.id)
      OR EXISTS (SELECT 1 FROM skill_offer_options o WHERE o."definitionId" = bl.id)
      OR EXISTS (SELECT 1 FROM skill_offers s WHERE s."selectedDefinitionId" = bl.id)
    );

  IF referenced > 0 THEN
    RAISE EXCEPTION 'cannot retire blessings: % definition(s) are still referenced', referenced;
  END IF;
END $$;

DELETE FROM "catalog_definitions" WHERE "kind" = 'blessings';

-- Drop the now-unused `patronId` column / FK / index on catalog_definitions.
-- Only `blessings` rows populated it; the kind is retired, so the column goes.
ALTER TABLE "catalog_definitions" DROP CONSTRAINT "catalog_definitions_patronId_fkey";
DROP INDEX "catalog_definitions_patronId_idx";
ALTER TABLE "catalog_definitions" DROP COLUMN "patronId";

-- Enforce the blessing-tier invariant at the database layer: a BLESSING link
-- must always carry an explicit tier (it is never null), and every other kind
-- must carry NO tier (it is always null). This check runs AFTER the legacy
-- BLESSING links are deleted above (all of them had a null tier), so it only
-- constrains rows created from here on.
--
-- The expression is the canonical association invariant:
--   (kind='BLESSING' AND "blessingTier" IS NOT NULL)
--   OR (kind<>'BLESSING' AND "blessingTier" IS NULL)
ALTER TABLE "character_associations"
  ADD CONSTRAINT "character_associations_blessing_tier_check"
  CHECK (
    ("kind" = 'BLESSING' AND "blessingTier" IS NOT NULL)
    OR ("kind" <> 'BLESSING' AND "blessingTier" IS NULL)
  );

COMMIT;
