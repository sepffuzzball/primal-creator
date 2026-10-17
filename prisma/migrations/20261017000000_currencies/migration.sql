-- Currencies catalog kind + durable character currency balances.
--
-- This is an additive migration on top of the 0.1.0 baseline
-- (20261016000000_initial_0_1_0). It:
--   1. Adds the `currencies` value to the existing `CatalogKind` enum, and
--   2. Creates `character_currency_balances`, a per-character durable holding of a
--      `currencies` catalog definition, keyed uniquely by (characterId,
--      definitionId).
--
-- No existing table, column or index is modified; no baseline migration or
-- archived chain is touched. There is no economic mechanic or event journal here -
-- only the persistence shape.

-- AlterEnum
-- Adds the `currencies` value to the `CatalogKind` enum. `IF NOT EXISTS` is used
-- so the migration is idempotent (a database that already carries the value is not
-- rejected), matching Prisma's "add value" intent while remaining safe to re-run.
ALTER TYPE "CatalogKind" ADD VALUE IF NOT EXISTS 'currencies';

-- CreateTable
CREATE TABLE "character_currency_balances" (
    "id" UUID NOT NULL,
    "characterId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_currency_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "character_currency_balances_characterId_idx" ON "character_currency_balances"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "character_currency_balances_characterId_definitionId_key" ON "character_currency_balances"("characterId", "definitionId");

-- AddForeignKey
ALTER TABLE "character_currency_balances" ADD CONSTRAINT "character_currency_balances_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_currency_balances" ADD CONSTRAINT "character_currency_balances_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "catalog_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------ //
-- Additions NOT expressible in the Prisma schema (carried verbatim so
-- the app and the DB agree on the invariant).
-- ------------------------------------------------------------------ //

-- Character currency balance amount bound. Prisma schema cannot express a CHECK,
-- so it is appended here. A balance is a nonnegative integer, bounded to the
-- 32-bit signed INT range, and 0 IS a legal stored value (unlike inventory
-- quantity, a zero balance row is kept so the character-currency association
-- stays explicit).
ALTER TABLE "character_currency_balances"
  ADD CONSTRAINT "character_currency_balances_amount_check"
  CHECK ("amount" >= 0 AND "amount" <= 2147483647);
