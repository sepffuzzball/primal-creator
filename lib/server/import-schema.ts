/**
 * Zod schema for the trusted-backup character import document (v3, v4, v5 and v6).
 *
 * The v6 document is the output of `exportCharacter` (schema
 * `primal-character/6`) plus `skillOffers`. It is a *trusted backup*, NOT
 * authoritative server-verified state: the `state` is validated against the
 * engine `characterStateSchema`, but `liveState` and `status` are advisory and
 * are recomputed server-side on import. Catalog references (identity race/class/
 * profession, every association definition, every inventory definition and every
 * skill-offer option) are resolved by `kind` + `stableId` to EXISTING catalog
 * definitions - no catalog content is ever auto-created, and a
 * missing/mismatched/archived required definition is rejected with an actionable
 * error. Every v5/v6 equipment association carries the ring `equipmentPosition` so
 * a Ring-slot character round-trips its two physical ring positions.
 *
 * A v6 backup additionally carries the append-only skill-offer cancellation model:
 * every exported skill offer includes a REQUIRED non-negative `generation` and a
 * REQUIRED-but-nullable `canceledAt` timestamp. A canceled offer is never dropped,
 * so a restore preserves the full historical offer identity; the importer
 * re-validates the offer invariants (unique per track/level/choiceGroup/generation,
 * at most one active offer per base key, no selected+canceled row) before any
 * write. A legacy v3/v4/v5 backup omits both fields; they default to 0/null.
 *
 * The v4 document (schema `primal-character/4`) adds the `inventory` array and the
 * `legacyUnowned` equipment marker and is still accepted on import; it carries no
 * ring position, so a Ring-slot link's position is derived from the CURRENT
 * catalog slot (legacy `Ring 1`/`Ring 2`) or, when the current slot has been
 * migrated to the generic `Ring`, from the backup's own
 * `definition.config.slot` snapshot (a pre-migration catalog still named
 * `Ring 1`/`Ring 2`), or rejected with an actionable `import_ring_position_required`
 * when neither provides a position. The `definition.config` snapshot is preserved
 * on import solely for this recovery - never used as live catalog mechanics.
 *
 * The v3 document (schema `primal-character/3`) is the previous backup shape. It
 * is still ACCEPTED on import (so existing backups continue to work) but is never
 * generated: v3 carried no inventory quantities and no `legacyUnowned` marker, so
 * an imported v3 backup imports zero stock and marks every equipment association
 * `legacyUnowned: true` (grandfathered - the link predates the inventory-ownership
 * model and stays equipped regardless of stock).
 *
 * The document is strictly bounded so a huge / malformed payload is rejected
 * quickly (the request body itself is capped at 2 MiB before parsing, see the
 * import route).
 */

import { z } from "zod"
import { characterStateSchema } from "@/lib/server/schemas"

export const IMPORT_SCHEMA_V3 = "primal-character/3" as const
export const IMPORT_SCHEMA_V4 = "primal-character/4" as const
export const IMPORT_SCHEMA_V5 = "primal-character/5" as const
export const IMPORT_SCHEMA_V6 = "primal-character/6" as const
/** The current trusted-backup schema (what `exportCharacter` emits). */
export const IMPORT_SCHEMA = IMPORT_SCHEMA_V6

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

/**
 * A referenced catalog definition for an association / offer option.
 *
 * A trusted-backup reference may additionally carry a `config` snapshot of the
 * definition as it existed at EXPORT time. It is NOT live catalog mechanics: the
 * CURRENT catalog row always wins for how an imported link behaves. It exists so
 * a legacy v3/v4 backup whose `definition.config.slot` still names `Ring 1` /
 * `Ring 2` (an old, pre-migration catalog) can recover a ring position that the
 * current catalog no longer exposes after its slot was migrated to the single
 * canonical `Ring`. Optional for backward compatibility - old backups and
 * non-equipment links omit it.
 */
const definitionRefSchema = z.object({
  kind: z.string().min(1),
  stableId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
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
 * v5 equipment association references. Adds the physical ring position to every
 * equipment link: `equipmentPosition` is `'Ring 1'`/`'Ring 2'` for a Ring-slot
 * item, and `null` for any non-ring equipment link (Ring is ONE catalog slot, but
 * the wearable position is per-link). The field is REQUIRED (a v5 backup is
 * expected to report it explicitly on every equipment link - `null` for non-ring,
 * an exact position for a ring) so a missing position is a Zod rejection rather
 * than a silent guess; `null` is the explicit "not a ring" report. Non-equipment
 * links carry no position field, mirroring v4.
 */
const equipmentAssociationSchemaV5 = z.object({
  kind: z.literal("equipment"),
  definition: definitionRefSchema,
  legacyUnowned: z.boolean(),
  equipmentPosition: z.enum(["Ring 1", "Ring 2"]).nullable(),
})
const v5AssociationSchema = z.discriminatedUnion("kind", [
  equipmentAssociationSchemaV5,
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

/**
 * A legacy (v3/v4/v5) skill-offer timestamp value. It may be an ISO string or a
 * Unix ms epoch number, but when supplied it MUST represent a real, finite Date -
 * it is never silently restamped to "now". A malformed value (`"not-a-date"`, `""`)
 * is rejected rather than defaulted, so a canceled offer's cancellation time (or a
 * selection time) survives a backup unchanged.
 */
const importDateValueSchema = z
  .union([z.string(), z.number()])
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "Expected a valid ISO timestamp",
  })

/** A skill offer exported from the source character (legacy v3/v4/v5 shape). */
const skillOfferSchema = z.object({
  track: z.enum(["class", "profession"]),
  level: z.number().int().nonnegative(),
  choiceGroup: z.string().min(1),
  // Offer generation. Present only in a v6 backup; a legacy v3/v4/v5 backup omits
  // it and the importer defaults it to 0 (the initial offer generation). A
  // re-offer after a cancellation increments it, so historical generations coexist.
  generation: z.number().int().nonnegative().optional(),
  // Cancellation timestamp. Present only in a v6 backup; a legacy v3/v4/v5 backup
  // omits it and the importer defaults it to null (still active). Null = active.
  // When a legacy backup DOES supply it, it must be a valid timestamp (never a
  // silent "now" restamp), so an invalid value is rejected instead.
  canceledAt: importDateValueSchema.nullable().optional(),
  offeredAt: z.union([z.string(), z.number()]).optional(),
  selectedStableId: z.string().min(1).nullable().optional(),
  // Historical selection timestamp, preserved verbatim on import so an answer
  // keeps its original time rather than being restamped. Optional/nullable for
  // backward compatibility with backups that only carried `selectedStableId`.
  selectedAt: z.union([z.string(), z.number()]).optional().nullable(),
  options: z.array(skillOfferOptionSchema).max(MAX_IMPORT_ASSOCIATIONS),
})

/**
 * The v6 skill-offer shape. Unlike the legacy v3/v4/v5 shape, `generation` is
 * REQUIRED (a non-negative integer) and `canceledAt` is REQUIRED but nullable (an
 * ISO timestamp or null), because a v6 backup is expected to carry the full
 * append-only offer identity and cancellation state. The option snapshots are
 * preserved verbatim - a re-offered generation never rewinds or rewrites a
 * historical offer's snapshots.
 */
const skillOfferSchemaV6 = z.object({
  track: z.enum(["class", "profession"]),
  level: z.number().int().nonnegative(),
  choiceGroup: z.string().min(1),
  generation: z.number().int().nonnegative(),
  // REQUIRED but nullable. A v6 backup must report a real ISO-8601 datetime WITH a
  // timezone (Z or an explicit offset), or null for an active offer. An invalid or
  // timezone-less value is rejected rather than restamped to "now", so a canceled
  // offer's cancellation instant survives a backup round-trip exactly.
  canceledAt: z.iso.datetime({ offset: true }).nullable(),
  offeredAt: z.union([z.string(), z.number()]).optional(),
  selectedStableId: z.string().min(1).nullable().optional(),
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
 * The v4 trusted-backup document. Adds the `inventory` array and the
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
 * The current v5 trusted-backup document. Everything v4 carries plus, on every
 * equipment association, the ring `equipmentPosition` (a per-link physical ring
 * position for a Ring-slot item, null for non-ring equipment). This is what
 * `exportCharacter` emits; the importer validates the category-position match
 * against the CURRENT catalog and preserves the exact position. Non-equipment
 * associations carry no position field.
 */
const v5DocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA_V5),
  ...documentBase,
  associations: z.array(v5AssociationSchema).max(MAX_IMPORT_ASSOCIATIONS),
  inventory: z.array(inventoryRefSchema).max(MAX_IMPORT_INVENTORY),
})

/**
 * The current v6 trusted-backup document. It is everything v5 carries (v5
 * association slots with the ring position, inventory, and skill offers) plus the
 * append-only skill-offer cancellation model: every exported skill offer carries a
 * REQUIRED non-negative `generation` and a REQUIRED-but-nullable `canceledAt`
 * timestamp. A canceled offer stays in the backup (never dropped) so a restore
 * preserves the full historical offer identity and cancellation state; the importer
 * enforces the offer invariants (unique per track/level/choiceGroup/generation, at
 * most one active offer per base key, no selected+canceled row) before any write.
 */
const v6DocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA_V6),
  ...documentBase,
  associations: z.array(v5AssociationSchema).max(MAX_IMPORT_ASSOCIATIONS),
  inventory: z.array(inventoryRefSchema).max(MAX_IMPORT_INVENTORY),
  // Override the lenient legacy skill-offer schema with the strict v6 shape.
  skillOffers: z.array(skillOfferSchemaV6).max(MAX_IMPORT_SKILL_OFFERS),
})

/**
 * The full trusted-backup document: the current v6 shape, or a legacy v5/v4/v3
 * shape. `state` is the only authoritative field used to build the new character;
 * `liveState` / `status` are advisory and are validated loosely (they are ignored
 * on import, status is recomputed). The arrays are bounded so a pathological
 * backup is rejected before any DB write.
 */
export const characterImportDocumentSchema = z.discriminatedUnion("schema", [
  v3DocumentSchema,
  v4DocumentSchema,
  v5DocumentSchema,
  v6DocumentSchema,
])

/** The validated import document type (v3, v4, v5 or v6). */
export type CharacterImportDocument = z.infer<
  typeof characterImportDocumentSchema
>

/** The outer request payload accepted by POST /api/characters/import. */
export const characterImportPayloadSchema = z.object({
  document: characterImportDocumentSchema,
})
