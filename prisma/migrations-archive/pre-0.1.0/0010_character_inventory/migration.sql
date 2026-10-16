-- Additive migration: owner-managed inventory quantities plus the grandfathered
-- ownerless-equipment marker.
--
-- Inventory is per-definition house bookkeeping, not canon. A `quantity` is
-- bounded to 1..999999 by a CHECK constraint; a quantity of 0 is never stored
-- (removing the final unit deletes the row), so an absent row means zero stock.
-- No item-instance, slot, capacity or stacking tracking: the only state is the
-- integer count per (character, definition) pair.

-- CreateTable
CREATE TABLE "character_inventory_items" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_inventory_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "character_inventory_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999999)
);

-- CreateIndex
CREATE INDEX "character_inventory_items_characterId_idx" ON "character_inventory_items"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "character_inventory_items_characterId_definitionId_key" ON "character_inventory_items"("characterId", "definitionId");

-- AddForeignKey
ALTER TABLE "character_inventory_items" ADD CONSTRAINT "character_inventory_items_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_inventory_items" ADD CONSTRAINT "character_inventory_items_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: marker for equipment links that predate the inventory-ownership
-- model. Every pre-existing EQUIPMENT association was created before ownership
-- existed, so it is grandfathered (may stay equipped and removable even with zero
-- owned stock). Links created afterwards default to false and require stock.
ALTER TABLE "character_associations" ADD COLUMN "legacyUnowned" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: all pre-existing EQUIPMENT links are grandfathered ownerless.
UPDATE "character_associations" SET "legacyUnowned" = true WHERE "kind" = 'EQUIPMENT';
