-- Additive migration: character profile metadata plus the single-blessing rule.
--
-- 1. Adds six nullable profile-metadata columns to `characters` (nickname,
--    pronouns, ageDescription, appearance, biography, notes). Each is bounded
--    only by Zod at the API boundary (the columns are TEXT); no CHECK is added
--    because a Prisma `String?` maps to a null-allowed TEXT with no
--    server-enforced length.
--
-- 2. Enforces AT MOST ONE BLESSING association per character (active or
--    archived) at the database level with a partial unique index. Existing data
--    may already violate this (prior migrations allowed multiple BLESSING links),
--    so the migration reconciles deterministically BEFORE creating the index:
--    for each character with more than one BLESSING link, keep the unarchived
--    link (falling back to an archived one only when none is unarchived), then
--    the newest association `createdAt`, then the highest link id. Every other
--    link is deleted, a reconciliation progression event is appended per removed
--    link, and the character version is bumped ONCE so a stale client never
--    silently overwrites the reconciliation.

BEGIN;

-- 1. Profile metadata columns (all nullable; boundaries enforced via Zod).
ALTER TABLE "characters" ADD COLUMN "nickname" TEXT;
ALTER TABLE "characters" ADD COLUMN "pronouns" TEXT;
ALTER TABLE "characters" ADD COLUMN "ageDescription" TEXT;
ALTER TABLE "characters" ADD COLUMN "appearance" TEXT;
ALTER TABLE "characters" ADD COLUMN "biography" TEXT;
ALTER TABLE "characters" ADD COLUMN "notes" TEXT;

-- 2. Deterministic blessing-singleton reconciliation.
--
-- Identify the losers among each character's BLESSING links. Winner selection
-- (per character), in order:
--   (a) unarchived before archived,
--   (b) newest association `createdAt`,
--   (c) highest link id (a stable, deterministic tiebreak).
CREATE TEMP TABLE "blessing_reconcile_losers" (
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "definitionName" TEXT,
    "definitionStableId" TEXT
);

WITH "ranked" AS (
    SELECT
        a."id",
        a."characterId",
        a."definitionId",
        d."name" AS "definitionName",
        d."stableId" AS "definitionStableId",
        d."archived" AS "definitionArchived",
        ROW_NUMBER() OVER (
            PARTITION BY a."characterId"
            ORDER BY
                d."archived" ASC,
                a."createdAt" DESC,
                a."id" DESC
        ) AS "rn"
    FROM "character_associations" a
    JOIN "catalog_definitions" d ON d."id" = a."definitionId"
    WHERE a."kind" = 'BLESSING'
)
INSERT INTO "blessing_reconcile_losers"
    ("characterId", "definitionId", "linkId", "definitionName", "definitionStableId")
SELECT
    "characterId",
    "definitionId",
    "id",
    "definitionName",
    "definitionStableId"
FROM "ranked"
WHERE "rn" > 1;

-- Delete the losing links.
DELETE FROM "character_associations" a
USING "blessing_reconcile_losers" l
WHERE a."id" = l."linkId";

-- Append a reconciliation progression event per removed link. These use generated
-- ids (not the app's cuid) because the migration cannot call the app's cuid
-- generator; `gen_random_uuid()` is a built-in on modern PostgreSQL (13+) and the
-- cast to TEXT is safe because ProgressionEvent.id is TEXT.
INSERT INTO "progression_events" ("id", "characterId", "kind", "payload", "createdAt")
SELECT
    gen_random_uuid()::text,
    l."characterId",
    'blessing_singleton_reconcile',
    jsonb_build_object(
        'removedAssociationId', l."linkId",
        'removedDefinitionId', l."definitionId",
        'removedStableId', l."definitionStableId",
        'reason', 'enforce_one_blessing'
    ),
    now()
FROM "blessing_reconcile_losers" l;

-- Bump the version ONCE per affected character (even with multiple losers) so a
-- stale client cannot silently overwrite the reconciliation; `updatedAt` is
-- bumped to match the app's @updatedAt semantics.
UPDATE "characters" c
SET "version" = c."version" + 1,
    "updatedAt" = now()
FROM (
    SELECT DISTINCT "characterId" FROM "blessing_reconcile_losers"
) l
WHERE c."id" = l."characterId";

-- Drop the working table before commit (it is session-scoped, but be explicit).
DROP TABLE "blessing_reconcile_losers";

-- 3. Database-level guard for the singleton invariant. Partial unique index: at
-- most one BLESSING row per character (archived or active). The service's
-- `associateCharacter` already deletes all old BLESSING links before creating a
-- new one, so this index is the safety net for a concurrent same-or-different
-- blessing add and also backstops a direct/imported write.
CREATE UNIQUE INDEX "character_associations_characterId_blessing_key"
    ON "character_associations"("characterId")
    WHERE "kind" = 'BLESSING';

COMMIT;
