-- Rename the `consumables` catalog kind to `items`.
--
-- The `CatalogKind` enum is used only by `catalog_definitions.kind`; no other
-- column references it. Renaming the value in place converts every existing
-- catalog row (and any historical journal/backup reference keyed by kind) to the
-- new canonical `items` value with no data rewrite, so owned inventory quantities
-- and previously consumed/recorded permanent gains and active effects (which live
-- in the immutable Character.state and are keyed by `kind: "consumable"`,
-- `source: "consumable"` engine concepts, not by this enum) are preserved.
ALTER TYPE "CatalogKind" RENAME VALUE 'consumables' TO 'items';
