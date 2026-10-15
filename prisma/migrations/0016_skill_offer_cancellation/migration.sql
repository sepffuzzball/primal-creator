-- Add offer generation + cancellation to skill offers, in support of append-only
-- skill-offer cancellation and re-offer on a re-earned level (prerequisite for EXP
-- undo).
--
-- `generation` counts successive offers for the same (characterId, track, level,
-- choiceGroup): the initial offer is generation 0 and each re-offer after a
-- cancellation increments it (max existing generation + 1). Letting a canceled
-- offer be superseded by a new generation keeps the offer history immutable
-- (append-only): the old row is never deleted or rewritten. `canceledAt` is set
-- (non-null) when a pending offer is canceled; null means the offer is still
-- active and selectable. At most one offer per base key may be active at a time;
-- that invariant is enforced at the application layer.
--
-- This migration is additive and non-destructive: every existing row keeps its
-- identity with generation 0 and canceledAt null, so no rows are deleted and no
-- historical offers are lost.

BEGIN;

ALTER TABLE "skill_offers"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "canceledAt" TIMESTAMP(3);

-- Replace the original unique index on (characterId, track, level, choiceGroup)
-- with the generation-extended key. Existing rows all carry generation 0, so the
-- swap never collides and no rows are deleted.
DROP INDEX "skill_offers_characterId_track_level_choiceGroup_key";

-- Recreate as a unique index (the original was created as a unique index in
-- migration 0003).
CREATE UNIQUE INDEX "skill_offers_characterId_track_level_choiceGroup_generation_key"
  ON "skill_offers"("characterId", "track", "level", "choiceGroup", "generation");

COMMIT;
