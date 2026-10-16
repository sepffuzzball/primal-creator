-- Remove the catalog provenance taxonomy (Verified / Inferred / House).
--
-- The `catalog_definitions.provenance` column and the `Provenance` enum are
-- dropped in ONE transaction. No retroactive change is made to the immutable
-- progression_events / character backups: their recorded event payloads and the
-- synthesized effect `provenance` strings are preserved verbatim. Source URLs
-- are preserved - only the provenance column is removed, never `sourceUrl`.

BEGIN;

ALTER TABLE "catalog_definitions" DROP COLUMN "provenance";

DROP TYPE "Provenance";

COMMIT;
