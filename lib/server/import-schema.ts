/**
 * Zod schema for the trusted-backup character import document (v3 through v7).
 *
 * The v7 document is the output of `exportCharacter` (schema
 * `primal-character/7`) plus `skillOffers`. It is a *trusted backup*, NOT
 * authoritative server-verified state: the `state` is validated against the
 * engine `characterStateSchema`, but `liveState` and `status` are advisory and
 * are recomputed server-side on import. Catalog references (identity race/class/
 * profession, every association definition, every inventory definition and every
 * skill-offer option) are resolved by `kind` + `stableId` to EXISTING catalog
 * definitions - no catalog content is ever auto-created, and a
 * missing/mismatched/archived required definition is rejected with an actionable
 * error. Every v5/v6/v7 equipment association carries the ring
 * `equipmentPosition` so a Ring-slot character round-trips its two physical ring
 * positions.
 *
 * A v6/v7 backup additionally carries the append-only skill-offer cancellation
 * model: every exported skill offer includes a REQUIRED non-negative `generation`
 * and a REQUIRED-but-nullable `canceledAt` timestamp. A canceled offer is never
 * dropped, so a restore preserves the full historical offer identity; the importer
 * re-validates the offer invariants (unique per track/level/choiceGroup/generation,
 * at most one active offer per base key, no selected+canceled row) before any
 * write. A legacy v3/v4/v5 backup omits both fields; they default to 0/null.
 *
 * The v7 document changes the BLESSING association model (the legacy `blessings`
 * catalog kind was retired): a blessing association references a `gods`
 * definition by `definition.kind: "gods"` and carries a REQUIRED `tier` (the
 * eight-tier blessing hierarchy). The importer persists that tier on the
 * association link so the live effect is synthesized from the god's
 * `blessingEffects[tier]`. A v7 document NEVER carries a `blessings` inventory or
 * association kind; its inventory `definition.kind` is `"equipment"` or `"items"`
 * only (the legacy `consumables` alias is rejected, not normalized).
 *
 * The v4/v5/v6 documents (schemas `primal-character/4`/`/5`/`/6`) still parse, but
 * the SERVICE LAYER rejects any document carrying a legacy `blessing` association
 * with an actionable 400 migration notice - even when that association would
 * otherwise resolve - because the `blessings` catalog rows no longer exist. A
 * legacy v4/v5/v6 inventory `consumables` kind is normalized to `items` (see
 * `inventoryRefSchema`), never persisted. Legacy v3/v4/v5 documents omit the
 * skill-offer generation/cancellation fields; they default to 0/null.
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
import {
  blessingTierSchema,
  characterStateSchema,
  gradeSchema,
} from "@/lib/server/schemas"

export const IMPORT_SCHEMA_V3 = "primal-character/3" as const
export const IMPORT_SCHEMA_V4 = "primal-character/4" as const
export const IMPORT_SCHEMA_V5 = "primal-character/5" as const
export const IMPORT_SCHEMA_V6 = "primal-character/6" as const
export const IMPORT_SCHEMA_V7 = "primal-character/7" as const
/** The current trusted-backup schema (what `exportCharacter` emits). */
export const IMPORT_SCHEMA = IMPORT_SCHEMA_V7

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
 * `"items"` (the only kinds that can be inventoried - `items` replaces the legacy
 * `consumables` kind); `quantity` is bounded 1..999999 (the same bound the
 * migration's CHECK constraint enforces).
 *
 * A legacy backup (v4/v5/v6) that predates the rename may still carry
 * `definition.kind: "consumables"`. It is ACCEPTED and normalized to `"items"`
 * here, before any resolver runs, so an old backup never references a catalog
 * kind the enum no longer holds. The legacy value is never persisted.
 */
const inventoryRefSchema = z.object({
  definition: z.object({
    kind: z
      .enum(["equipment", "consumables", "items"])
      .transform((kind) => (kind === "consumables" ? "items" : kind)),
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
  track: z.enum(["class", "profession", "race"]),
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
  track: z.enum(["class", "profession", "race"]),
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

/**
 * The v7 skill-offer shape. It is the v6 shape plus the schedule-credit
 * provenance, all optional nullable for backward compatibility with a
 * legacy backup that predates provenance (a v3/v4/v5/v6 offer omits them and
 * reads back as null on import). For a SCHEDULED offer `earnedGrade` and
 * `trackDefinitionStableId` must be present together: `earnedGrade` is the grade
 * whose skill-choice interval awarded the offer, and `trackDefinitionStableId` is
 * the selected track's catalog stableId at the moment the credit was earned.
 * `classStableIdAtEarn` is the character's selected CLASS at EARNING time (null
 * for a monster race credit); when supplied it must be a nonempty stableId and it
 * is priority-only (deterministic option ordering), never eligibility. It is only
 * MEANINGFUL on a scheduled class/profession credit: an offer that carries BOTH
 * `earnedGrade` and `trackDefinitionStableId` AND is on the 'class' or
 * 'profession' track. A monster RACE credit has no earned class, and a
 * legacy/untyped offer (no provenance) has no snapshot, so on those the snapshot
 * must be null or omitted - never a real value that would attach earned-class
 * priority where none belongs. The superRefine rejects a malformed grade, an
 * empty stableId, a mismatched provenance pair (one set without the other), and a
 * nonnull `classStableIdAtEarn` on a race or legacy offer.
 */
const skillOfferSchemaV7 = skillOfferSchemaV6
  .extend({
    earnedGrade: gradeSchema.nullable().optional(),
    trackDefinitionStableId: z.string().min(1).nullable().optional(),
    // Snapshot of the character's selected class stableId at EARNING time.
    // Optional nullable; when present it must be a nonempty string. Priority-only,
    // never eligibility. Null for a monster (race) credit. Allowed only on a
    // scheduled class/profession offer (see superRefine).
    classStableIdAtEarn: z.string().min(1).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const hasGrade = data.earnedGrade != null
    const hasTrack = data.trackDefinitionStableId != null
    if (hasGrade !== hasTrack) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A scheduled skill offer must carry both earnedGrade and trackDefinitionStableId together (or neither)",
        path: ["earnedGrade"],
      })
    }

    // A nonnull `classStableIdAtEarn` is valid only on a scheduled class or
    // profession credit: BOTH provenance halves present AND the offer track is
    // 'class'/'profession'. A race credit has no earned class and a legacy/untyped
    // offer (no provenance) has no snapshot, so a supplied snapshot on those is
    // rejected rather than silently attaching earned-class priority.
    const hasProvenance =
      data.earnedGrade != null && data.trackDefinitionStableId != null
    const isClassProfTrack =
      data.track === "class" || data.track === "profession"
    if (
      data.classStableIdAtEarn != null &&
      !(hasProvenance && isClassProfTrack)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `An earned-class snapshot (classStableIdAtEarn) is only valid on a scheduled class or profession offer that carries both earnedGrade and trackDefinitionStableId (got track "${data.track}")`,
        path: ["classStableIdAtEarn"],
      })
    }
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
 * v7 blessing association. The legacy `blessings` catalog kind was retired, so a
 * blessing now references a `gods` definition by `definition.kind: "gods"` and
 * carries a REQUIRED `tier` (the eight-tier blessing hierarchy). The importer
 * persists that tier verbatim on the association link, so the live effect is
 * synthesized from the god's `blessingEffects[tier]` at read time. A non-gods
 * definition (e.g. a stale `blessings` kind) is rejected at the schema boundary.
 */
const v7BlessingAssociationSchema = z
  .object({
    kind: z.literal("blessing"),
    tier: blessingTierSchema,
    definition: definitionRefSchema,
    legacyUnowned: z.literal(false).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.definition.kind !== "gods") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A blessing association must reference a gods definition (got "${data.definition.kind}")`,
        path: ["definition", "kind"],
      })
    }
  })

/**
 * v7 association references. Non-blessing kinds keep the v5 shape (ring position
 * on equipment); a blessing is the god + tier form above. Blessing links carry no
 * `legacyUnowned` marker beyond the v5 non-equipment allowance.
 */
const v7AssociationSchema = z.discriminatedUnion("kind", [
  equipmentAssociationSchemaV5,
  ...NON_EQUIPMENT_KINDS.filter((k) => k !== "blessing").map((kind) =>
    nonEquipmentAssociationSchema.extend({ kind: z.literal(kind) })
  ),
  v7BlessingAssociationSchema,
])

/**
 * v7 inventory entry. The legacy `consumables` alias is REJECTED (not normalized):
 * a v7 document names the kind `"equipment"` or `"items"` only.
 */
const inventoryRefSchemaV7 = z.object({
  definition: z.object({
    kind: z.enum(["equipment", "items"]),
    stableId: z.string().min(1),
  }),
  quantity: z.number().int().min(1).max(999999),
})

/**
 * The current v7 trusted-backup document. Everything v6 carries (the strict v6
 * skill-offer shape, inventory, ring positions) plus the god + tier blessing
 * model: a blessing association references a `gods` definition and carries a
 * REQUIRED `tier`. A v7 skill offer may additionally carry the schedule-credit
 * provenance (`earnedGrade` + `trackDefinitionStableId`, optional nullable and
 * validated together, plus the optional nullable `classStableIdAtEarn` earning-time
 * class snapshot that is nonempty-when-present). This is the ONLY schema
 * `exportCharacter` emits; legacy v3-v6 documents still parse and are accepted unless they carry a
 * blessing association (the service layer rejects those with a migration
 * notice).
 */
const v7DocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA_V7),
  ...documentBase,
  associations: z.array(v7AssociationSchema).max(MAX_IMPORT_ASSOCIATIONS),
  inventory: z.array(inventoryRefSchemaV7).max(MAX_IMPORT_INVENTORY),
  skillOffers: z.array(skillOfferSchemaV7).max(MAX_IMPORT_SKILL_OFFERS),
})

/**
 * The full trusted-backup document: the current v7 shape, or a legacy v6/v5/v4/v3
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
  v7DocumentSchema,
])

/** The validated import document type (v3, v4, v5, v6 or v7). */
export type CharacterImportDocument = z.infer<
  typeof characterImportDocumentSchema
>

/** The outer request payload accepted by POST /api/characters/import. */
export const characterImportPayloadSchema = z.object({
  document: characterImportDocumentSchema,
})
