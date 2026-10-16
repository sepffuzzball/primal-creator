-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Origin" AS ENUM ('integrated', 'born');

-- CreateEnum
CREATE TYPE "CatalogKind" AS ENUM ('races', 'classes', 'professions', 'titles', 'equipment', 'skills', 'blessings', 'bloodlines', 'consumables', 'evolutions');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('verified', 'inferred', 'house');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "origin" "Origin" NOT NULL DEFAULT 'integrated',
    "raceId" TEXT,
    "classId" TEXT,
    "professionId" TEXT,
    "state" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
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
    "provenance" "Provenance" NOT NULL DEFAULT 'house',
    "sourceUrl" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "assets_kind_idx" ON "assets"("kind");

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

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

