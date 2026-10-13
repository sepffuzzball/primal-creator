/**
 * Zod schema for the trusted-backup character import document (v3 and v4).
 *
 * The v4 document is the output of `exportCharacter` (schema
 * `primal-character/4`) plus `skillOffers`. It is a *trusted backup*, NOT
 * authoritative server-verified state: the `state` is validated against the
 * engine `characterStateSchema`, but `liveState` and `status` are advisory and
 * are recomputed server-side on import. Catalog references (identity race/class/
 * profession, every association definition, every inventory definition and every
 * skill-offer option) are resolved by `kind` + `stableId` to EXISTING catalog
 * definitions - no catalog content is ever auto-created, and a
 * missing/mismatched/archived required definition is rejected with an actionable
 * error.
 *
 * The v3 document (schema `primal-character/3`) is the previous backup shape.
 * It is still ACCEPTED on import (so existing backups continue to work) but is
 * never generated: v3 carried no inventory quantities and no
 * `legacyUnowned` marker, so an imported v3 backup imports zero stock and marks
 * every equipment association `legacyUnowned: true` (grandfathered - the link
 * predates the inventory-ownership model and stays equipped regardless of stock).
 *
 * The document is strictly bounded so a huge / malformed payload is rejected
 * quickly (the request body itself is capped at 2 MiB before parsing, see the
 * import route).
 */

import { z } from "zod"
import { characterStateSchema } from "@/lib/server/schemas"

export const IMPORT_SCHEMA_V3 = "primal-character/3" as const
export const IMPORT_SCHEMA_V4 = "primal-character/4" as const
/** The current trusted-backup schema (what `exportCharacter` emits). */
export const IMPORT_SCHEMA = IMPORT_SCHEMA_V4

export const IMPORT_RULESET_VERSION = "house-2026-10-12-v1" as const

/** Bounded array caps, mirroring the import route's per-array limits. */
export const MAX_IMPORT_EVENTS = 10_000
export const MAX_IMPORT_SKILL_OFFERS = 1_000
export const MAX_IMPORT_ASSOCIATIONS = 500
/** Distinct stock definitions a backup may carry (self-roundtrip guarantee). */
export const MAX_IMPORT_INVENTORY = 500

const stableRefSchema = z.object({
  stableId: z.string().min(1).nullable(),
})

const identitySchema = z.object({
  name: z.string().min(1),
  description: z.string().max(8000).nullable().optional(),
  // Character-profile metadata, mirroring lib/server/schemas.ts and
  // lib/server/draft-schema.ts. Optional + nullable: an omitted or null field in
  // a backup is imported as NULL (old backups without these fields still import).
  nickname: z.string().max(200).nullable().optional(),
  pronouns: z.string().max(100).nullable().optional(),
  ageDescription: z.string().max(4000).nullable().optional(),
  appearance: z.string().max(8000).nullable().optional(),
  biography: z.string().max(8000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  origin: z.enum(["integrated", "born"]),
  race: stableRefSchema,
  class: stableRefSchema,
  profession: stableRefSchema.nullable(),
})

/** A referenced catalog definition for an association / offer option. */
const definitionRefSchema = z.object({
  kind: z.string().min(1),
  stableId: z.string().min(1),
})

const ASSOC_KINDS = [
  "title",
  "equipment",
  "skill",
  "blessing",
  "bloodline",
  "transcendent",
] as const

const NON_EQUIPMENT_KINDS = [
  "title",
  "skill",
  "blessing",
  "bloodline",
  "transcendent",
] as const

/** An exported/imported character association reference (v3 shape). */
const v3AssociationSchema = z.object({
  kind: z.enum(ASSOC_KINDS),
  definition: definitionRefSchema,
})

/**
 * v4 association references. Equipment links carry a required `legacyUnowned`
 * boolean (true only when the link predates the inventory-ownership model and may
 * stay equipped with zero owned stock); non-equipment links must NOT be
 * grandfathered, so any `legacyUnowned` on them must be `false` (a `true` is
 * rejected). The non-equipment schemas are kept literal per kind so the union is
 * a true discriminated union with precise error paths.
 */
const equipmentAssociationSchema = z.object({
  kind: z.literal("equipment"),
  definition: definitionRefSchema,
  legacyUnowned: z.boolean(),
})

const nonEquipmentAssociationSchema = z.object({
  kind: z.enum(NON_EQUIPMENT_KINDS),
  definition: definitionRefSchema,
  legacyUnowned: z.literal(false).optional(),
})
const v4AssociationSchema = z.discriminatedUnion("kind", [
  equipmentAssociationSchema,
  ...NON_EQUIPMENT_KINDS.map((kind) =>
    nonEquipmentAssociationSchema.extend({ kind: z.literal(kind) })
  ),
])

/**
 * A single exported inventory entry. `definition.kind` is always `"equipment"` or
 * `"consumables"` (the only kinds that can be inventoried); `quantity` is bounded
 * 1..999999 (the same bound the migration's CHECK constraint enforces).
 */
const inventoryRefSchema = z.object({
  definition: z.object({
    kind: z.enum(["equipment", "consumables"]),
    stableId: z.string().min(1),
  }),
  quantity: z.number().int().min(1).max(999999),
})

/** A single snapshotted skill option offered on the source character. */
const skillOfferOptionSchema = z.object({
  stableId: z.string().min(1),
  nameSnapshot: z.string(),
  configSnapshot: z.record(z.string(), z.unknown()).optional(),
})

/** A skill offer exported from the source character. */
const skillOfferSchema = z.object({
  track: z.enum(["class", "profession"]),
  level: z.number().int().nonnegative(),
  choiceGroup: z.string().min(1),
  offeredAt: z.union([z.string(), z.number()]).optional(),
  selectedStableId: z.string().min(1).nullable().optional(),
  // Historical selection timestamp, preserved verbatim on import so an answer
  // keeps its original time rather than being restamped. Optional/nullable for
  // backward compatibility with backups that only carried `selectedStableId`.
  selectedAt: z.union([z.string(), z.number()]).optional().nullable(),
  options: z.array(skillOfferOptionSchema).max(MAX_IMPORT_ASSOCIATIONS),
})

/** A raw exported progression event, stored as provenance (never a live id). */
const importedEventSchema = z.object({
  kind: z.string().optional(),
  payload: z.unknown().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
})

const documentBase = {
  rulesetVersion: z.literal(IMPORT_RULESET_VERSION),
  identity: identitySchema,
  state: characterStateSchema,
  liveState: z.unknown().optional(),
  status: z.unknown().optional(),
  events: z.array(importedEventSchema).max(MAX_IMPORT_EVENTS),
  skillOffers: z.array(skillOfferSchema).max(MAX_IMPORT_SKILL_OFFERS),
}

/**
 * The legacy v3 trusted-backup document. `state` is the only authoritative field
 * used to build the new character; `liveState` / `status` are advisory and are
 * validated loosely (they are ignored on import, status is recomputed). There is
 * no `inventory` field and no `legacyUnowned` marker, so an imported v3 backup
 * creates no stock and grandfathered every equipment link.
 */
const v3DocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA_V3),
  ...documentBase,
  associations: z.array(v3AssociationSchema).max(MAX_IMPORT_ASSOCIATIONS),
})

/**
 * The current v4 trusted-backup document. Adds the `inventory` array and the
 * `legacyUnowned` equipment marker so a backup captures both owned stock and the
 * grandfathering status of equipment links, guaranteeing exported characters
 * round-trip (a grandfathered link may import with zero stock).
 */
const v4DocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA_V4),
  ...documentBase,
  associations: z.array(v4AssociationSchema).max(MAX_IMPORT_ASSOCIATIONS),
  inventory: z.array(inventoryRefSchema).max(MAX_IMPORT_INVENTORY),
})

/**
 * The full trusted-backup document: either the current v4 shape or the legacy v3
 * shape. `state` is the only authoritative field used to build the new character;
 * `liveState` / `status` are advisory and are validated loosely (they are ignored
 * on import, status is recomputed). The arrays are bounded so a pathological
 * backup is rejected before any DB write.
 */
export const characterImportDocumentSchema = z.discriminatedUnion("schema", [
  v3DocumentSchema,
  v4DocumentSchema,
])

/** The validated import document type (v3 or v4). */
export type CharacterImportDocument = z.infer<
  typeof characterImportDocumentSchema
>

/** The outer request payload accepted by POST /api/characters/import. */
export const characterImportPayloadSchema = z.object({
  document: characterImportDocumentSchema,
})
