-- Add physical ring position to equipment association links.
--
-- Ring is a SINGLE catalog slot ("Ring") but a character may wear two rings, one
-- per position. The chosen position is persisted per-link on
-- character_associations.equipmentPosition (nullable: null for non-ring equipment
-- links). This migration is additive and non-destructive: existing rows stay
-- intact and the unique (characterId, definitionId) constraint is unchanged (a
-- definition may still be linked at most once).

BEGIN;

ALTER TABLE "character_associations"
  ADD COLUMN "equipmentPosition" TEXT;

-- Backfill: derive the position of every pre-existing EQUIPMENT link whose linked
-- catalog definition still carries a legacy Ring 1 / Ring 2 slot (case- and
-- spacing-insensitive, so ring1 / ring 1 / RING1 ... are all recognized). Links
-- whose catalog slot is canonical "Ring" (or whose slot is absent / non-ring) are
-- left NULL; those are the ring links whose position must be supplied explicitly,
-- or which predate the per-link position model and are derived at read time.
UPDATE "character_associations" ca
SET "equipmentPosition" = CASE
  WHEN lower(replace(cd."config"->>'slot', ' ', '')) = 'ring1' THEN 'Ring 1'
  WHEN lower(replace(cd."config"->>'slot', ' ', '')) = 'ring2' THEN 'Ring 2'
  ELSE NULL
END
FROM "catalog_definitions" cd
WHERE ca."kind" = 'EQUIPMENT'
  AND ca."definitionId" = cd."id"
  AND cd."kind" = 'equipment'
  AND lower(replace(cd."config"->>'slot', ' ', '')) IN ('ring1', 'ring2');

COMMIT;
