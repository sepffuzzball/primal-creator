-- 0.1.0 initial baseline.
--
-- This migration replaces the entire 0001..0023 migration chain with a single
-- fresh baseline that builds the full final schema from an EMPTY database.
-- Because it is a from-scratch baseline (not an incremental ALTER), it must only
-- ever run against a database that has NOT been migrated before. The DO block
-- below is that guard: it runs BEFORE any CREATE, and if it finds a non-empty
-- Prisma migration history (an old-chain database) or ANY pre-existing
-- non-extension object in the public schema other than the Prisma tracking
-- table, it aborts with a clear message. Objects that belong to a Postgres
-- extension are identified by dependency (pg_depend deptype='e'), never by a
-- hard-coded name allow-list, so a database where Crunchy PGO (or anything else)
-- installs an extension such as pg_stat_statements into public is treated as
-- empty. It never drops anything: an old-chain or partially-migrated database
-- (one the guard refuses) is left untouched, while a database that merely
-- carries a Postgres extension (e.g. pg_stat_statements installed into public
-- by Crunchy PGO) is not refused - the extension's objects are preserved, and
-- the baseline still creates the full application schema around them.

DO $$
DECLARE
  applied integer;
  foreign_objects integer;
BEGIN
  -- 1. Reject any already-APPLIED Prisma migration history. Prisma inserts a row
  --    for the migration it is about to run (finished_at remains NULL until it
  --    completes), so we count only rows whose `finished_at` is NOT NULL. When
  --    such rows exist, this database was migrated by the old 0001..0023 chain
  --    (or is otherwise non-empty), so the 0.1.0 baseline must NOT re-create it.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = '_prisma_migrations'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public."_prisma_migrations" WHERE "finished_at" IS NOT NULL' INTO applied;
    IF applied > 0 THEN
      RAISE EXCEPTION
        'prisma-0.1.0-baseline: database already has % applied migration(s) in _prisma_migrations; refusing to re-create. Run migrate deploy on an empty database, or reset this database.',
        applied;
    END IF;
  END IF;

  -- 2. Reject any pre-existing NON-extension object in the public schema other
  --    than the Prisma tracking table (and its auto-created row type). This
  --    covers tables, views, materialized views, foreign tables, partitioned
  --    tables and user-defined types. Objects that are members of a Postgres
  --    extension (detected via pg_depend deptype='e', NOT by name) are ignored,
  --    so a database that has an extension installed into public - for example
  --    pg_stat_statements on a Crunchy PGO database - is treated as empty. A
  --    database that still holds app objects (the 0001..0023 chain leaves 11
  --    tables) fails here without dropping anything.
  SELECT count(*) INTO foreign_objects
  FROM (
    SELECT c.relname AS name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
      AND c.relname <> '_prisma_migrations'
      -- Skip relations that are members of a Postgres extension (deptype='e' in
      -- pg_depend). This is how we ignore an extension-installed view such as
      -- pg_stat_statements without hard-coding any name allow-list.
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
          AND d.refclassid = 'pg_extension'::regclass
      )
    UNION ALL
    SELECT t.typname
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'c', 'd', 'b', 'r', 'm')
      AND t.typcategory <> 'A'
      AND t.typname <> '_prisma_migrations'
      -- Skip a type that is itself a member of a Postgres extension ...
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
          AND d.refclassid = 'pg_extension'::regclass
      )
      -- ... and skip the COMPOSITE ROW TYPE that an extension-owned relation
      -- (e.g. the pg_stat_statements view) automatically carries, whose typrelid
      -- points at an extension-owned pg_class. A user-created view's row type is
      -- NOT extension-owned, so it is still counted and refuses.
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = t.typrelid
          AND d.deptype = 'e'
          AND d.refclassid = 'pg_extension'::regclass
      )
  ) obj;
  IF foreign_objects > 0 THEN
    RAISE EXCEPTION
      'prisma-0.1.0-baseline: public schema already contains % non-extension object(s); refusing to re-create. Run migrate deploy on an empty database, or reset this database.',
      foreign_objects;
  END IF;
END $$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Origin" AS ENUM ('integrated', 'born');

-- CreateEnum
CREATE TYPE "CatalogKind" AS ENUM ('races', 'classes', 'professions', 'titles', 'equipment', 'skills', 'blessings', 'bloodlines', 'items', 'evolutions', 'gods', 'transcendent_skills');

-- CreateEnum
CREATE TYPE "AssociationKind" AS ENUM ('TITLE', 'EQUIPMENT', 'SKILL', 'BLESSING', 'BLOODLINE', 'TRANSCENDENT');

-- CreateEnum
CREATE TYPE "BlessingTier" AS ENUM ('Baptism', 'Minor', 'Lesser', 'Intermediate', 'Major', 'Greater', 'Divine', 'True');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "characterId" TEXT,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_drafts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nickname" TEXT,
    "pronouns" TEXT,
    "ageDescription" TEXT,
    "appearance" TEXT,
    "biography" TEXT,
    "notes" TEXT,
    "origin" "Origin" NOT NULL DEFAULT 'integrated',
    "raceId" TEXT,
    "classId" TEXT,
    "professionId" TEXT,
    "state" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progression_events" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progression_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_definitions" (
    "id" TEXT NOT NULL,
    "kind" "CatalogKind" NOT NULL,
    "stableId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "grade" TEXT,
    "sourceUrl" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "gradeDescriptions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_associations" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "kind" "AssociationKind" NOT NULL,
    "blessingTier" "BlessingTier",
    "legacyUnowned" BOOLEAN NOT NULL DEFAULT false,
    "equipmentPosition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_associations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_inventory_items" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_offers" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "choiceGroup" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "selectedDefinitionId" TEXT,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selectedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "earnedGrade" TEXT,
    "trackDefinitionStableId" TEXT,
    "classStableIdAtEarn" TEXT,

    CONSTRAINT "skill_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_offer_options" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,

    CONSTRAINT "skill_offer_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_rules" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "assets_kind_idx" ON "assets"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "character_drafts_userId_key" ON "character_drafts"("userId");

-- CreateIndex
CREATE INDEX "characters_ownerId_idx" ON "characters"("ownerId");

-- CreateIndex
CREATE INDEX "characters_archived_idx" ON "characters"("archived");

-- CreateIndex
CREATE INDEX "characters_ownerId_archived_idx" ON "characters"("ownerId", "archived");

-- CreateIndex
CREATE INDEX "progression_events_characterId_createdAt_idx" ON "progression_events"("characterId", "createdAt");

-- CreateIndex
CREATE INDEX "catalog_definitions_kind_idx" ON "catalog_definitions"("kind");

-- CreateIndex
CREATE INDEX "catalog_definitions_kind_archived_idx" ON "catalog_definitions"("kind", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_definitions_kind_stableId_key" ON "catalog_definitions"("kind", "stableId");

-- CreateIndex
CREATE INDEX "character_associations_characterId_idx" ON "character_associations"("characterId");

-- CreateIndex
CREATE INDEX "character_associations_kind_idx" ON "character_associations"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "character_associations_characterId_definitionId_key" ON "character_associations"("characterId", "definitionId");

-- CreateIndex
CREATE INDEX "character_inventory_items_characterId_idx" ON "character_inventory_items"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "character_inventory_items_characterId_definitionId_key" ON "character_inventory_items"("characterId", "definitionId");

-- CreateIndex
CREATE INDEX "skill_offers_characterId_idx" ON "skill_offers"("characterId");

-- CreateIndex
CREATE INDEX "skill_offers_track_level_idx" ON "skill_offers"("track", "level");

-- CreateIndex
CREATE UNIQUE INDEX "skill_offers_characterId_track_level_choiceGroup_generation_key" ON "skill_offers"("characterId", "track", "level", "choiceGroup", "generation");

-- CreateIndex
CREATE INDEX "skill_offer_options_offerId_idx" ON "skill_offer_options"("offerId");

-- CreateIndex
CREATE INDEX "skill_offer_options_definitionId_idx" ON "skill_offer_options"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_offer_options_offerId_definitionId_key" ON "skill_offer_options"("offerId", "definitionId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_drafts" ADD CONSTRAINT "character_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "catalog_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_classId_fkey" FOREIGN KEY ("classId") REFERENCES "catalog_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_professionId_fkey" FOREIGN KEY ("professionId") REFERENCES "catalog_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progression_events" ADD CONSTRAINT "progression_events_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_associations" ADD CONSTRAINT "character_associations_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_associations" ADD CONSTRAINT "character_associations_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_inventory_items" ADD CONSTRAINT "character_inventory_items_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_inventory_items" ADD CONSTRAINT "character_inventory_items_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offers" ADD CONSTRAINT "skill_offers_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offers" ADD CONSTRAINT "skill_offers_selectedDefinitionId_fkey" FOREIGN KEY ("selectedDefinitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offer_options" ADD CONSTRAINT "skill_offer_options_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "skill_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offer_options" ADD CONSTRAINT "skill_offer_options_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------ //
-- Additions NOT expressible in the Prisma schema (carried verbatim from
-- the 0001..0023 chain so the 0.1.0 baseline is byte-for-byte equivalent
-- to the schema the old chain produced).
-- ------------------------------------------------------------------ //

-- Character inventory quantity bound. Present in migration 0010; Prisma schema
-- cannot express a CHECK, so it is appended here. 1..999999, and never 0 - a
-- quantity of 0 is never stored (removing the final unit deletes the row).
ALTER TABLE "character_inventory_items"
  ADD CONSTRAINT "character_inventory_items_quantity_check"
  CHECK ("quantity" BETWEEN 1 AND 999999);

-- Blessing-tier invariant. Present in migration 0019: a BLESSING link always
-- carries an explicit tier (never null), and every other kind always carries NO
-- tier (always null).
ALTER TABLE "character_associations"
  ADD CONSTRAINT "character_associations_blessing_tier_check"
  CHECK (
    ("kind" = 'BLESSING' AND "blessingTier" IS NOT NULL)
    OR ("kind" <> 'BLESSING' AND "blessingTier" IS NULL)
  );

-- At most one BLESSING link per character (active or archived). Present in
-- migration 0011; the partial unique index is not modelable in Prisma schema.
CREATE UNIQUE INDEX "character_associations_characterId_blessing_key"
  ON "character_associations"("characterId")
  WHERE "kind" = 'BLESSING';

-- At most one BLOODLINE link per character (active or archived). Present in
-- migration 0012; the partial unique index is not modelable in Prisma schema.
CREATE UNIQUE INDEX "character_associations_characterId_bloodline_key"
  ON "character_associations"("characterId")
  WHERE "kind" = 'BLOODLINE';

-- Singleton house-rules row. Seeded during the migration (never by the seed
-- script) so the application never silently falls back to an in-memory default.
-- Carries the FULL final default config (equipment caps, consumable grade rates,
-- transcendent-skill cap and the skill-choice interval schedule) as it stood
-- after migrations 0007 + 0012 + 0021 + 0022; validated server-side by
-- `houseRulesConfigSchema` (lib/db/ruleset.ts) on every read and write.
INSERT INTO "house_rules" ("id", "version", "config", "updatedAt")
VALUES (
  'active',
  0,
  '{"equipmentIndividualCapPercent":20,"equipmentCombinedCapPercent":15,"consumableGradeRates":{"F":3,"E":5,"D":15,"C":45},"maxTranscendentSkills":3,"skillChoiceIntervals":{"G":5,"F":5,"E":5,"D":20,"C":30,"B":40,"A":50,"S":60}}',
  CURRENT_TIMESTAMP
);
