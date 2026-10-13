/**
 * Zod schema for the trusted-backup character import document (v3).
 *
 * The v3 document is the output of `exportCharacter` (schema
 * `primal-character/3`) plus `skillOffers`. It is a *trusted backup*, NOT
 * authoritative server-verified state: the `state` is validated against the
 * engine `characterStateSchema`, but `liveState` and `status` are advisory and
 * are recomputed server-side on import. Catalog references (identity race/class/
 * profession, every association definition and every skill-offer option) are
 * resolved by `kind` + `stableId` to EXISTING catalog definitions - no catalog
 * content is ever auto-created, and a missing/mismatched/archived required
 * definition is rejected with an actionable error.
 *
 * The document is strictly bounded so a huge / malformed payload is rejected
 * quickly (the request body itself is capped at 2 MiB before parsing, see the
 * import route).
 */

import { z } from "zod"
import { characterStateSchema } from "@/lib/server/schemas"

export const IMPORT_SCHEMA = "primal-character/3" as const
export const IMPORT_RULESET_VERSION = "house-2026-10-12-v1" as const

/** Bounded array caps, mirroring the import route's per-array limits. */
export const MAX_IMPORT_EVENTS = 10_000
export const MAX_IMPORT_SKILL_OFFERS = 1_000
export const MAX_IMPORT_ASSOCIATIONS = 500

const stableRefSchema = z.object({
  stableId: z.string().min(1).nullable(),
})

const identitySchema = z.object({
  name: z.string().min(1),
  description: z.string().max(8000).nullable().optional(),
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

/** An exported character association, resolved by kind + stableId on import. */
const associationRefSchema = z.object({
  kind: z.enum(["title", "equipment", "skill", "blessing", "bloodline"]),
  definition: definitionRefSchema,
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

/**
 * The full v3 trusted-backup document. `state` is the only authoritative field
 * used to build the new character; `liveState` / `status` are advisory and are
 * validated loosely (they are ignored on import, status is recomputed). The
 * arrays are bounded so a pathological backup is rejected before any DB write.
 */
export const characterImportDocumentSchema = z.object({
  schema: z.literal(IMPORT_SCHEMA),
  rulesetVersion: z.literal(IMPORT_RULESET_VERSION),
  identity: identitySchema,
  state: characterStateSchema,
  liveState: z.unknown().optional(),
  status: z.unknown().optional(),
  associations: z.array(associationRefSchema).max(MAX_IMPORT_ASSOCIATIONS),
  events: z.array(importedEventSchema).max(MAX_IMPORT_EVENTS),
  skillOffers: z.array(skillOfferSchema).max(MAX_IMPORT_SKILL_OFFERS),
})

/** The validated import document type. */
export type CharacterImportDocument = z.infer<
  typeof characterImportDocumentSchema
>

/** The outer request payload accepted by POST /api/characters/import. */
export const characterImportPayloadSchema = z.object({
  document: characterImportDocumentSchema,
})
