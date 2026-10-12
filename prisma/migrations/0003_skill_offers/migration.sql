-- AlterEnum
ALTER TYPE "AssociationKind" ADD VALUE 'SKILL';

-- CreateTable
CREATE TABLE "skill_offers" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "choiceGroup" TEXT NOT NULL,
    "selectedDefinitionId" TEXT,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selectedAt" TIMESTAMP(3),

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

-- CreateIndex
CREATE UNIQUE INDEX "skill_offers_characterId_track_level_choiceGroup_key" ON "skill_offers"("characterId", "track", "level", "choiceGroup");

-- CreateIndex
CREATE INDEX "skill_offers_characterId_idx" ON "skill_offers"("characterId");

-- CreateIndex
CREATE INDEX "skill_offers_track_level_idx" ON "skill_offers"("track", "level");

-- CreateIndex
CREATE UNIQUE INDEX "skill_offer_options_offerId_definitionId_key" ON "skill_offer_options"("offerId", "definitionId");

-- CreateIndex
CREATE INDEX "skill_offer_options_offerId_idx" ON "skill_offer_options"("offerId");

-- CreateIndex
CREATE INDEX "skill_offer_options_definitionId_idx" ON "skill_offer_options"("definitionId");

-- AddForeignKey
ALTER TABLE "skill_offers" ADD CONSTRAINT "skill_offers_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offers" ADD CONSTRAINT "skill_offers_selectedDefinitionId_fkey" FOREIGN KEY ("selectedDefinitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offer_options" ADD CONSTRAINT "skill_offer_options_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "skill_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_offer_options" ADD CONSTRAINT "skill_offer_options_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
