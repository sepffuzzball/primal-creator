-- Retire the `evolutions` catalog kind.
--
-- Race / class / profession evolution no longer reads an `evolutions` catalog
-- row. Instead a race evolves into ANY unarchived compatible race definition at
-- exactly the next grade, and a class/profession evolves into ANY unarchived
-- class/profession definition that defines the next grade's per-grade gain. No
-- progression requirement/compendium row exists anymore, so every `evolutions`
-- catalog row is deleted.
--
-- The `CatalogKind` enum value `evolutions` is intentionally left dormant (the
-- enum type is not altered), so any stale backup/manifest that still names it
-- keeps validating; only the rows are removed.
--
-- Safety: `catalog_definitions` is referenced by RESTRICT foreign keys from
-- `characters` (raceId/classId/professionId), `character_associations`
-- (definitionId), `character_inventory_items` (definitionId),
-- `skill_offer_options` (definitionId) and `skill_offers`
-- (selectedDefinitionId). An `evolutions` row should never be referenced by any
-- of these (characters point at races/classes/professions, links point at their
-- own kinds), but we preflight-check before deleting so a genuinely-referenced
-- row aborts the migration with a clear message instead of a raw FK error.

BEGIN;

DO $$
DECLARE
  referenced integer;
BEGIN
  SELECT count(*)
  INTO referenced
  FROM catalog_definitions evo
  WHERE evo.kind = 'evolutions'
    AND (
      EXISTS (SELECT 1 FROM characters c WHERE c."raceId" = evo.id OR c."classId" = evo.id OR c."professionId" = evo.id)
      OR EXISTS (SELECT 1 FROM character_associations a WHERE a."definitionId" = evo.id)
      OR EXISTS (SELECT 1 FROM character_inventory_items i WHERE i."definitionId" = evo.id)
      OR EXISTS (SELECT 1 FROM skill_offer_options o WHERE o."definitionId" = evo.id)
      OR EXISTS (SELECT 1 FROM skill_offers s WHERE s."selectedDefinitionId" = evo.id)
    );

  IF referenced > 0 THEN
    RAISE EXCEPTION 'cannot retire evolutions: % definition(s) are still referenced', referenced;
  END IF;
END $$;

DELETE FROM catalog_definitions WHERE kind = 'evolutions';

COMMIT;
