-- CreateEnum
CREATE TYPE "AssociationKind" AS ENUM ('TITLE', 'EQUIPMENT');

-- CreateTable
CREATE TABLE "character_associations" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "kind" "AssociationKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_associations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "character_associations_characterId_definitionId_key" ON "character_associations"("characterId", "definitionId");

-- CreateIndex
CREATE INDEX "character_associations_characterId_idx" ON "character_associations"("characterId");

-- CreateIndex
CREATE INDEX "character_associations_kind_idx" ON "character_associations"("kind");

-- AddForeignKey
ALTER TABLE "character_associations" ADD CONSTRAINT "character_associations_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_associations" ADD CONSTRAINT "character_associations_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
