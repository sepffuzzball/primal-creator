-- AlterEnum: introduce the explicit transcendent-skills catalog kind.
ALTER TYPE "CatalogKind" ADD VALUE 'transcendent_skills';

-- AlterEnum: transcendents become a character-linkable association kind.
ALTER TYPE "AssociationKind" ADD VALUE 'TRANSCENDENT';
