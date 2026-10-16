-- AlterEnum: blessings and bloodlines become character-linkable association
-- kinds.
ALTER TYPE "AssociationKind" ADD VALUE 'BLESSING';
ALTER TYPE "AssociationKind" ADD VALUE 'BLOODLINE';

-- AlterEnum: introduce the separate Gods/Patrons catalog kind.
ALTER TYPE "CatalogKind" ADD VALUE 'gods';

-- AlterTable: the optional patron-god reference on a catalog definition. Only
-- `blessings` entries populate it (resolved from the config's patronGodStableId).
-- The self-FK uses RESTRICT because a referenced god is never deleted, and its
-- stableId must not change while any blessing references it (service enforces 409).
ALTER TABLE "catalog_definitions" ADD COLUMN "patronId" TEXT;

-- CreateIndex
CREATE INDEX "catalog_definitions_patronId_idx" ON "catalog_definitions"("patronId");

-- AddForeignKey
ALTER TABLE "catalog_definitions" ADD CONSTRAINT "catalog_definitions_patronId_fkey" FOREIGN KEY ("patronId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
