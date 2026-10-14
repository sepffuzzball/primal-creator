/**
 * Admin-only, repeatable, atomic catalog import for version-controlled manifests.
 *
 * The import is a two-step, explicit operation (never implicit):
 *   - `previewWikiReviewedImport` computes, against the live database and WITHOUT
 *     mutating anything, which manifest entries would be created and which would
 *     be skipped because a row with the same (kind, stableId) already exists.
 *   - `applyWikiReviewedImport` validates every entry, then inserts ALL missing
 *     rows in ONE Prisma SERIALIZABLE transaction, re-checking existence inside
 *     the transaction. An identical repeat call skips every existing row, and a
 *     concurrent conflicting import surfaces as a 409 with no partial write.
 *
 * Policy:
 *   - The manifest is the single source of truth. The route that drives this never
 *     accepts arbitrary user-provided rows; the manifest is passed in as an
 *     argument so tests can inject a fixture manifest while the production route
 *     stays fixed on `WIKI_REVIEWED_ENTRIES`.
 *   - Existing catalog rows are never overwritten: an entry whose (kind, stableId)
 *     already exists is skipped, leaving its config / provenance / slug untouched.
 *     A skipped entry carries `existing` (read from the actual live row, never the
 *     manifest) so the admin can see exactly what was preserved; the manifest's
 *     proposed name/sourceUrl/provenance stay on the entry as the proposed values.
 *   - Created rows always set `archived: false` and `provenance: inferred`.
 *   - No scraping: this module never fetches a URL, it only reads a static array.
 *   - Every `sourceUrl` must be an `https:` URL that names a host. An `http:` or
 *     hostless value is rejected with a 400 even though `catalogCreateSchema`
 *     would accept such a URL, so a broken evidence link fails at import time.
 *   - No audit table and no immutable import event journal: the apply response
 *     identifies the created row ids, and catalog rows carry their own
 *     timestamps/metadata, but the catalog table is not an append-only audit
 *     trail of import operations.
 *
 * Every entry is validated against `catalogCreateSchema` plus the per-kind config
 * schema (`parseCatalogConfig`) and the same modern-shape checks the service layer
 * enforces on a create (blessing tier/effects, bloodline effects, skill
 * track/milestone pairs, etc). Every `sourceUrl` must be an `https:` URL naming a
 * host. A malformed manifest fails with a 400 BEFORE any write, and a duplicate
 * (kind, stableId) within the manifest also fails early.
 */

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { badRequest, conflict } from "@/lib/server/errors"
import {
  catalogCreateSchema,
  catalogKindSchema,
  hasInvalidSkillTrack,
  isIncompleteRaceConfig,
  isIncompleteSkillConfig,
  isLegacyBlessingConfig,
  isLegacyBloodlineConfig,
  isLegacyConsumableConfig,
  isLegacyTranscendentSkillConfig,
  isValidEvolutionConfig,
  parseCatalogConfig,
} from "@/lib/server/schemas"
import type { Grade } from "@/lib/rules"

// ------------------------------------------------------------------ //
// Manifest types
// ------------------------------------------------------------------ //

/** The catalog kind union derived from the canonical Zod enum. */
export type CatalogKind = z.infer<typeof catalogKindSchema>

/**
 * A single curated manifest entry. `provenance` is fixed to `"inferred"` because
 * the manifest is fan-wiki-derived (see docs/catalog/wiki-reviewed.md); `grade`
 * is optional and null when the entry has no grade band. `sourceUrl` must be an
 * https URL pointing at the exact evidence page.
 */
export interface WikiReviewedEntry {
  kind: CatalogKind
  stableId: string
  name: string
  description: string
  grade?: Grade | null
  provenance: "inferred"
  sourceUrl: string
  config: Record<string, unknown>
}

/** A validated manifest entry (grade normalized to `Grade | null`). */
interface ValidatedEntry {
  kind: CatalogKind
  stableId: string
  name: string
  description: string
  grade: Grade | null
  provenance: "inferred"
  sourceUrl: string
  config: Record<string, unknown>
}

/**
 * Metadata read from the ACTUAL existing catalog row that occupies a (kind,
 * stableId) key and is therefore preserved untouched. Copied verbatim from the
 * live row (never from the manifest); `provenance` reflects the real row
 * (`verified` | `inferred` | `house`), NOT the manifest's fixed `"inferred"`.
 */
export interface CatalogImportExistingRow {
  id: string
  name: string
  sourceUrl: string | null
  provenance: "verified" | "inferred" | "house"
  archived: boolean
}

/** One row of the preview/apply result. */
export interface CatalogImportEntryPreview {
  kind: CatalogKind
  stableId: string
  /**
   * The PROPOSED wiki entry from the manifest. `name` / `sourceUrl` /
   * `provenance:'inferred'` always describe what the manifest WOULD create; they
   * are never overwritten by an existing row.
   */
  name: string
  sourceUrl: string | null
  provenance: "inferred"
  status: "create" | "skip_existing"
  /**
   * Present ONLY when `status` is `"skip_existing"`: metadata read directly
   * from the actual existing catalog row (never copied from the manifest), so an
   * admin can see exactly what was preserved instead of the proposed wiki
   * values. Omitted for `"create"` rows.
   */
  existing?: CatalogImportExistingRow
}

/** The read-only preview result (GET) and the apply result shape. */
export interface WikiReviewedImportResult {
  source: "wiki-reviewed"
  entries: CatalogImportEntryPreview[]
  createCount: number
  skipCount: number
}

/** The apply result; additionally identifies the created catalog row ids. */
export interface WikiReviewedApplyResult extends WikiReviewedImportResult {
  createdIds: string[]
}

// ------------------------------------------------------------------ //
// Validation
// ------------------------------------------------------------------ //

/**
 * Validate the whole manifest BEFORE any database write. Throws a 400 for an
 * unknown kind, an entry that fails `catalogCreateSchema`, an invalid per-kind
 * config, a legacy/partial config that the service layer would reject on a create,
 * or a duplicate (kind, stableId) pair within the manifest.
 */
function validateEntries(
  entries: readonly WikiReviewedEntry[]
): ValidatedEntry[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.stableId}`
    if (seen.has(key)) {
      throw badRequest(
        "duplicate_manifest_entry",
        `Catalog manifest has a duplicate (kind, stableId) pair: "${entry.stableId}" (${entry.kind})`
      )
    }
    seen.add(key)
  }
  return entries.map(validateEntry)
}

/**
 * Curated manifest entries must cite HTTPS evidence. Although
 * `catalogCreateSchema` accepts any valid URL (an `http:` link is a valid URL),
 * the reviewed manifest requires an `https:` URL that actually names a host, so a
 * typo or a downgraded scheme in an evidence link is caught at import time rather
 * than silently stored. Throws a 400 `validation` error for a missing, non-https,
 * or hostless value.
 */
function assertHttpsSourceUrl(sourceUrl: string, stableId: string): void {
  let url: URL | null = null
  try {
    url = new URL(sourceUrl)
  } catch {
    url = null
  }
  if (!url || url.protocol !== "https:" || !url.host) {
    throw badRequest(
      "validation",
      `Manifest entry "${stableId}" sourceUrl must be an https URL with a host (got "${sourceUrl}")`
    )
  }
}

function validateEntry(entry: WikiReviewedEntry): ValidatedEntry {
  if (!catalogKindSchema.safeParse(entry.kind).success) {
    throw badRequest("invalid_kind", `Unknown catalog kind "${entry.kind}"`)
  }
  if (entry.provenance !== "inferred") {
    throw badRequest(
      "validation",
      `Manifest entry "${entry.stableId}" must use provenance "inferred" (got "${entry.provenance}")`
    )
  }
  assertHttpsSourceUrl(entry.sourceUrl, entry.stableId)
  const parsed = catalogCreateSchema.safeParse({
    stableId: entry.stableId,
    name: entry.name,
    description: entry.description,
    grade: entry.grade ?? null,
    provenance: entry.provenance,
    sourceUrl: entry.sourceUrl,
    config: entry.config,
  })
  if (!parsed.success) {
    throw badRequest(
      "validation",
      `Invalid catalog manifest entry "${entry.stableId}" (${entry.kind})`
    )
  }
  let config: Record<string, unknown>
  try {
    config = parseCatalogConfig(entry.kind, entry.config)
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid catalog config"
    throw badRequest(
      "invalid_config",
      `Invalid config for "${entry.stableId}" (${entry.kind}): ${message}`
    )
  }
  assertModernConfig(entry.kind, config)
  return {
    kind: entry.kind,
    stableId: entry.stableId,
    name: entry.name,
    description: entry.description,
    grade: entry.grade ?? null,
    provenance: "inferred",
    sourceUrl: entry.sourceUrl,
    config,
  }
}

/**
 * The same modern-shape guards `createCatalogItem` applies to a brand-new row.
 * A NEW manifest entry must carry the full modern shape; a legacy metadata-only
 * config that is fine for an existing row is rejected here.
 */
export function assertModernConfig(
  kind: string,
  config: Record<string, unknown>
): void {
  if (kind === "consumables" && isLegacyConsumableConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Consumable config is missing required "type" and "amount" fields'
    )
  }
  if (kind === "skills" && isIncompleteSkillConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config is offer-incomplete: an offer-eligible milestone skill requires both a "track" and a "milestone"'
    )
  }
  if (kind === "skills" && hasInvalidSkillTrack(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config has an invalid "track": expected "class" or "profession"'
    )
  }
  if (kind === "races" && isIncompleteRaceConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Race config must declare a valid "raceType": expected "enlightened" or "monster"'
    )
  }
  if (kind === "evolutions" && !isValidEvolutionConfig(config)) {
    throw badRequest(
      "invalid_config",
      "Evolution config is not a valid path: it must be a complete race path OR a complete class/profession path"
    )
  }
  if (kind === "blessings" && isLegacyBlessingConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Blessing config is missing required "tier" and "effects" fields'
    )
  }
  if (kind === "bloodlines" && isLegacyBloodlineConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Bloodline config is missing required "effects" field'
    )
  }
  if (
    kind === "transcendent_skills" &&
    isLegacyTranscendentSkillConfig(config)
  ) {
    throw badRequest(
      "invalid_config",
      'Transcendent skill config is missing required "passiveEffects" field'
    )
  }
}

// ------------------------------------------------------------------ //
// Import helpers
// ------------------------------------------------------------------ //

function keyOf(kind: string, stableId: string): string {
  return `${kind}:${stableId}`
}

/**
 * The subset of a live catalog row that is echoed into a `skip_existing` preview
 * entry. Only identity/metadata fields are needed; the manifest's proposed
 * values are never used here.
 */
interface ExistingCatalogRow {
  id: string
  name: string
  sourceUrl?: string | null
  provenance?: string | null
  archived?: boolean
}

function toExistingRow(row: ExistingCatalogRow): CatalogImportExistingRow {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.sourceUrl ?? null,
    provenance: (row.provenance ??
      "house") as CatalogImportExistingRow["provenance"],
    archived: row.archived ?? false,
  }
}

function toPreviewEntry(
  entry: ValidatedEntry,
  status: "create" | "skip_existing",
  existingRow?: ExistingCatalogRow
): CatalogImportEntryPreview {
  return {
    kind: entry.kind,
    stableId: entry.stableId,
    name: entry.name,
    sourceUrl: entry.sourceUrl,
    provenance: entry.provenance,
    status,
    ...(status === "skip_existing" && existingRow
      ? { existing: toExistingRow(existingRow) }
      : {}),
  }
}

/**
 * Resolve the `patronId` FK for a `blessings` entry, mirroring the service's
 * `resolveBlessingPatronId`. Runs inside the SAME transaction as the create so an
 * invalid/archived patron fails the whole import and never leaves a dangling FK.
 * A non-blessing entry returns no patron data.
 */
async function blessingPatronData(
  db: Prisma.TransactionClient,
  entry: ValidatedEntry
): Promise<{ patronId?: string | null }> {
  if (entry.kind !== "blessings") return {}
  const config = entry.config as Record<string, unknown>
  const stableId = config.patronGodStableId
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { patronId: null }
  }
  const god = await db.catalogDefinition.findUnique({
    where: { kind_stableId: { kind: "gods", stableId } },
  })
  if (!god) {
    throw badRequest(
      "patron_god_not_found",
      `Patron god "${stableId}" is not in the catalog`
    )
  }
  if (god.archived) {
    throw badRequest(
      "patron_god_archived",
      `Patron god "${god.name}" is archived; unarchive it before granting its blessing`
    )
  }
  return { patronId: god.id }
}

function isUniqueViolation(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    return true
  }
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

function isSerializationFailure(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
  )
}

// ------------------------------------------------------------------ //
// Preview / apply
// ------------------------------------------------------------------ //

/**
 * Compute the import against the live database without mutating anything. The
 * returned per-entry status is `create` (no row with that (kind, stableId) yet)
 * or `skip_existing` (a row already occupies the key, so it is never overwritten).
 */
export async function previewWikiReviewedImport(
  entries: readonly WikiReviewedEntry[]
): Promise<WikiReviewedImportResult> {
  const validated = validateEntries(entries)
  const rows = await prisma.catalogDefinition.findMany({})
  const byKey = new Map(rows.map((row) => [keyOf(row.kind, row.stableId), row]))
  let createCount = 0
  let skipCount = 0
  const resultEntries = validated.map((entry) => {
    const existingRow = byKey.get(keyOf(entry.kind, entry.stableId))
    const exists = existingRow !== undefined
    if (exists) skipCount++
    else createCount++
    return toPreviewEntry(
      entry,
      exists ? "skip_existing" : "create",
      existingRow
    )
  })
  return {
    source: "wiki-reviewed",
    entries: resultEntries,
    createCount,
    skipCount,
  }
}

/**
 * Apply the manifest: validate everything, then create every MISSING entry in ONE
 * SERIALIZABLE transaction, re-checking existence inside the transaction so an
 * identical repeated call skips all already-present rows and a concurrent import
 * never produces a partial write. Existing rows are never touched. On a P2002 /
 * P2034 conflict from a concurrent import the whole transaction is rolled back and
 * a 409 is returned; the next retry is idempotent.
 */
export async function applyWikiReviewedImport(
  entries: readonly WikiReviewedEntry[]
): Promise<WikiReviewedApplyResult> {
  const validated = validateEntries(entries)
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = await tx.catalogDefinition.findMany({})
        const byKey = new Map(
          rows.map((row) => [keyOf(row.kind, row.stableId), row])
        )
        const createdIds: string[] = []
        let skipCount = 0
        const resultEntries: CatalogImportEntryPreview[] = []
        for (const entry of validated) {
          const existingRow = byKey.get(keyOf(entry.kind, entry.stableId))
          if (existingRow !== undefined) {
            skipCount++
            resultEntries.push(
              toPreviewEntry(entry, "skip_existing", existingRow)
            )
            continue
          }
          const row = await tx.catalogDefinition.create({
            data: {
              kind: entry.kind as never,
              stableId: entry.stableId,
              name: entry.name,
              description: entry.description,
              grade: entry.grade,
              provenance: entry.provenance,
              sourceUrl: entry.sourceUrl,
              archived: false,
              config: entry.config as Prisma.InputJsonValue,
              ...(await blessingPatronData(tx, entry)),
            },
          })
          createdIds.push(row.id)
          resultEntries.push(toPreviewEntry(entry, "create"))
        }
        return {
          source: "wiki-reviewed" as const,
          entries: resultEntries,
          createCount: createdIds.length,
          skipCount,
          createdIds,
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        "A concurrent catalog import created one of these entries; retry the request"
      )
    }
    if (isSerializationFailure(err)) {
      throw conflict(
        "catalog_serialization_conflict",
        "Concurrent catalog import conflict; retry the request"
      )
    }
    throw err
  }
}
