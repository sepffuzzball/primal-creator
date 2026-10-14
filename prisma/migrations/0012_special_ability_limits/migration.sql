-- Additive migration: configurable special-ability limits.
--
-- Two independent constraints are introduced and applied via explicit
-- transactional reconciliation (no data is silently dropped):
--
-- 1. The server-wide house-rules config gains `maxTranscendentSkills` (an admin
--    configured cap on how many transcendent skills a single character may
--    carry, default 3, bounded 0..8). The existing `house_rules.config` JSONB is
--    updated with `jsonb_set` so no other key is replaced or reordered, and the
--    version is bumped ONCE so any client that held the pre-migration version
--    observes a deliberate change. If an admin value is ever already present it
--    is preserved (the CASE only writes the default `3` when the key is absent).
--
-- 2. A character may hold AT MOST ONE bloodline association (active or archived).
--    Existing data may violate this (prior migrations allowed multiple BLOODLINE
--    links), so the migration reconciles deterministically BEFORE creating the
--    partial unique index, exactly as migration 0011 did for blessings: for each
--    character with more than one BLOODLINE link, keep the unarchived link
--    (falling back to an archived one only when none is unarchived), then the
--    newest association `createdAt`, then the highest link id. Every other link
--    is deleted, a reconciliation progression event is appended per removed link,
--    and the character version is bumped ONCE so a stale client never silently
--    overwrites the reconciliation.

BEGIN;

-- 1. Add the transcendent-skill cap to the singleton house-rules config without
-- replacing any existing key. The default is 3 (the transport upper bound is 8,
-- set by `specialAbilitiesSchema`); the CASE preserves a value an admin may have
-- set before this migration ran.
UPDATE "house_rules"
SET "config" = CASE
        WHEN "config" ? 'maxTranscendentSkills' THEN "config"
        ELSE jsonb_set("config", '{maxTranscendentSkills}', '3', true)
    END,
    "version" = "version" + 1
WHERE "id" = 'active';

-- 2. Deterministic bloodline-singleton reconciliation.
--
-- Identify the losers among each character's BLOODLINE links. Winner selection
-- (per character), in order:
--   (a) unarchived before archived,
--   (b) newest association `createdAt`,
--   (c) highest link id (a stable, deterministic tiebreak).
CREATE TEMP TABLE "bloodline_reconcile_losers" (
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
    WHERE a."kind" = 'BLOODLINE'
)
INSERT INTO "bloodline_reconcile_losers"
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
USING "bloodline_reconcile_losers" l
WHERE a."id" = l."linkId";

-- Append a reconciliation progression event per removed link. These use generated
-- ids (not the app's cuid) because the migration cannot call the app's cuid
-- generator; `gen_random_uuid()` is a built-in on modern PostgreSQL (13+) and the
-- cast to TEXT is safe because ProgressionEvent.id is TEXT.
INSERT INTO "progression_events" ("id", "characterId", "kind", "payload", "createdAt")
SELECT
    gen_random_uuid()::text,
    l."characterId",
    'bloodline_singleton_reconcile',
    jsonb_build_object(
        'removedAssociationId', l."linkId",
        'removedDefinitionId', l."definitionId",
        'removedStableId', l."definitionStableId",
        'reason', 'enforce_one_bloodline'
    ),
    now()
FROM "bloodline_reconcile_losers" l;

-- Bump the version ONCE per affected character (even with multiple losers) so a
-- stale client cannot silently overwrite the reconciliation; `updatedAt` is
-- bumped to match the app's @updatedAt semantics.
UPDATE "characters" c
SET "version" = c."version" + 1,
    "updatedAt" = now()
FROM (
    SELECT DISTINCT "characterId" FROM "bloodline_reconcile_losers"
) l
WHERE c."id" = l."characterId";

-- Drop the working table before commit (it is session-scoped, but be explicit).
DROP TABLE "bloodline_reconcile_losers";

-- 3. Database-level guard for the singleton invariant. Partial unique index: at
-- most one BLOODLINE row per character (archived or active). The service's
-- `associateCharacter` already deletes all old BLOODLINE links before creating a
-- new one, so this index is the safety net for a concurrent same-or-different
-- bloodline add and also backstops a direct/imported write.
CREATE UNIQUE INDEX "character_associations_characterId_bloodline_key"
    ON "character_associations"("characterId")
    WHERE "kind" = 'BLOODLINE';

COMMIT;
