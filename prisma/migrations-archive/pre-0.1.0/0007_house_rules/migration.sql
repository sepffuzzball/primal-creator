-- CreateTable
CREATE TABLE "house_rules" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_rules_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton house-rules row during the migration so the application
-- never has to seed it and never silently falls back to an in-memory default.
-- The config is the documented default house assumption (20% individual / 15%
-- combined equipment caps; consumable F3/E5/D15/C45) pending a source citation -
-- see docs/rules/assumptions.md. It is validated server-side by
-- `houseRulesConfigSchema` (lib/db/ruleset.ts) on every read and write.
INSERT INTO "house_rules" ("id", "version", "config", "updatedAt")
VALUES (
    'active',
    0,
    '{"equipmentIndividualCapPercent":20,"equipmentCombinedCapPercent":15,"consumableGradeRates":{"F":3,"E":5,"D":15,"C":45}}',
    CURRENT_TIMESTAMP
);
