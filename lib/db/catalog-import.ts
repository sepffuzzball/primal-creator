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
 *     already exists is skipped, leaving its config / slug untouched.
 *     A skipped entry carries `existing` (read from the actual live row, never the
 *     manifest) so the admin can see exactly what was preserved; the manifest's
 *     proposed name/sourceUrl stay on the entry as the proposed values.
 *   - Created rows always set `archived: false`.
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
 * enforces on a create (bloodline effects, skill track/milestone pairs, etc). Every `sourceUrl` must be an `https:` URL naming a
 * host. A malformed manifest fails with a 400 BEFORE any write, and a duplicate
 * (kind, stableId) within the manifest also fails early.
 */

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { badRequest, conflict } from "@/lib/server/errors"
import {
  allGradeGrantedSkillStableIds,
  catalogCreateSchema,
  catalogKindSchema,
  currencyGradeDescriptionsForbidden,
  currencyGradeForbidden,
  godGradeForbidden,
  hasInvalidSkillTrack,
  hasLegacyEquipmentRequirements,
  isIncompleteEquipmentConfig,
  isIncompleteRaceConfig,
  isIncompleteSkillConfig,
  isIncompleteSkillRarity,
  isLegacyBloodlineConfig,
  isLegacyTranscendentSkillConfig,
  normalizeCatalogKind,
  parseCatalogConfig,
  singleGradeTrackIssue,
  skillClassStableIdOf,
  skillGradeDescriptionsForbidden,
  skillGradeForbidden,
  trackGradeDescriptionsForbidden,
} from "@/lib/server/schemas"
import type { Grade } from "@/lib/rules"
import {
  validateSkillUpgradeBatch,
  type SkillUpgradeNode,
} from "@/lib/skills/upgrade-graph"
import { createCatalogItemInTransaction } from "@/lib/db/service"

// ------------------------------------------------------------------ //
// Manifest types
// ------------------------------------------------------------------ //

/** The catalog kind union derived from the canonical Zod enum. */
export type CatalogKind = z.infer<typeof catalogKindSchema>

/**
 * A single curated manifest entry. `grade` is optional and null when the entry
 * has no grade band. `sourceUrl` must be an https URL pointing at the exact
 * evidence page.
 */
export interface WikiReviewedEntry {
  kind: CatalogKind
  stableId: string
  name: string
  description: string
  grade?: Grade | null
  sourceUrl: string
  config: Record<string, unknown>
  /** Optional grade-specific prose keyed by G..S; omitted means none authored. */
  gradeDescriptions?: Partial<Record<Grade, string>>
}

/** A validated manifest entry (grade normalized to `Grade | null`). */
interface ValidatedEntry {
  kind: CatalogKind
  stableId: string
  name: string
  description: string
  grade: Grade | null
  sourceUrl: string
  config: Record<string, unknown>
  gradeDescriptions: Partial<Record<Grade, string>>
}

/**
 * Metadata read from the ACTUAL existing catalog row that occupies a (kind,
 * stableId) key and is therefore preserved untouched. Copied verbatim from the
 * live row (never from the manifest).
 */
export interface CatalogImportExistingRow {
  id: string
  name: string
  sourceUrl: string | null
  archived: boolean
}

/** One row of the preview/apply result. */
export interface CatalogImportEntryPreview {
  kind: CatalogKind
  stableId: string
  /**
   * The PROPOSED wiki entry from the manifest. `name` / `sourceUrl` always
   * describe what the manifest WOULD create; they are never overwritten by an
   * existing row.
   */
  name: string
  sourceUrl: string | null
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
  // Accept the legacy `consumables` kind as an alias for `items`; the legacy value
  // is never persisted (create/write always uses the canonical kind).
  const kind = normalizeCatalogKind(entry.kind) as CatalogKind
  if (!catalogKindSchema.safeParse(kind).success) {
    throw badRequest("invalid_kind", `Unknown catalog kind "${entry.kind}"`)
  }
  assertHttpsSourceUrl(entry.sourceUrl, entry.stableId)
  // A gods manifest entry carries no catalog grade band (see `godGradeForbidden`):
  // a non-null grade is rejected before any write, so both preview and apply fail
  // up front (migration 0020, archived 0001..0023 chain, nulled any pre-existing
  // god grade).
  if (godGradeForbidden(kind, entry.grade)) {
    throw badRequest(
      "invalid_grade",
      `Manifest god entry "${entry.stableId}" carries a grade; gods have no catalog grade band`
    )
  }
  // A currencies manifest entry likewise carries no catalog grade band (see
  // `currencyGradeForbidden`): a non-null grade is rejected before any write.
  if (currencyGradeForbidden(kind, entry.grade)) {
    throw badRequest(
      "invalid_grade",
      `Manifest currency entry "${entry.stableId}" carries a grade; currencies have no catalog grade band`
    )
  }
  // A currencies entry carries no grade ladder, so no grade-specific prose is
  // legal. A non-empty gradeDescriptions map is rejected before any write.
  if (currencyGradeDescriptionsForbidden(kind, entry.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      `Manifest currency entry "${entry.stableId}" carries gradeDescriptions; currencies have no grade ladder`
    )
  }
  // A skills entry likewise carries no catalog grade band (see
  // `skillGradeForbidden`): a skill is offered to the advancing track by config
  // `track` alone, never by a catalog grade, so a non-null grade is rejected
  // before any write (migration 20261017200000_skill_grade_removed nulled any
  // pre-existing skill grade).
  if (skillGradeForbidden(kind, entry.grade)) {
    throw badRequest(
      "invalid_grade",
      `Manifest skill entry "${entry.stableId}" carries a grade; skills have no catalog grade band`
    )
  }
  // A skills entry carries no grade ladder, so no grade-specific prose is legal: a
  // non-empty gradeDescriptions map is rejected before any write.
  if (skillGradeDescriptionsForbidden(kind, entry.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      `Manifest skill entry "${entry.stableId}" carries gradeDescriptions; skills have no grade ladder`
    )
  }
  const parsed = catalogCreateSchema.safeParse({
    stableId: entry.stableId,
    name: entry.name,
    description: entry.description,
    grade: entry.grade ?? null,
    sourceUrl: entry.sourceUrl,
    config: entry.config,
    gradeDescriptions: entry.gradeDescriptions,
  })
  if (!parsed.success) {
    throw badRequest(
      "validation",
      `Invalid catalog manifest entry "${entry.stableId}" (${kind})`
    )
  }
  let config: Record<string, unknown>
  try {
    config = parseCatalogConfig(kind, entry.config)
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid catalog config"
    throw badRequest(
      "invalid_config",
      `Invalid config for "${entry.stableId}" (${kind}): ${message}`
    )
  }
  assertModernConfig(kind, config)
  // A classes/professions entry is a SINGLE-grade definition: its catalog `grade`
  // column is the one grade it belongs to, and its `config.grades` map must
  // authorize EXACTLY that one grade. Zero-grade, multi-grade, and mismatched
  // definitions (and grade grants outside the selected grade) are rejected before
  // any write, mirroring the service-layer create path. No-op for races / other
  // kinds (the helper returns null for non-track kinds).
  const trackIssue = singleGradeTrackIssue(kind, entry.grade, config)
  if (trackIssue) {
    throw badRequest("invalid_config", trackIssue)
  }
  // A classes/professions entry carries no authored grade-specific prose (the
  // legacy `description` is the prose for that one grade), so a non-empty
  // gradeDescriptions map is rejected before any write.
  if (trackGradeDescriptionsForbidden(kind, entry.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      'Classes and professions carry no grade ladder: "gradeDescriptions" must be empty or omitted'
    )
  }
  return {
    kind,
    stableId: entry.stableId,
    name: entry.name,
    description: entry.description,
    grade: entry.grade ?? null,
    sourceUrl: entry.sourceUrl,
    config,
    gradeDescriptions: parsed.data.gradeDescriptions ?? {},
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
  if (kind === "skills" && isIncompleteSkillConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config requires a "track": expected "race", "class" or "profession"'
    )
  }
  if (kind === "skills" && hasInvalidSkillTrack(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config has an invalid "track": expected "race", "class" or "profession"'
    )
  }
  // A NEW manifest skill must declare a valid rarity, same as a new skill POST.
  if (kind === "skills" && isIncompleteSkillRarity(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config requires a valid "rarity" (one of Inferior/Common/Uncommon/Rare/Epic/Ancient/Legendary/Mythical/Sacred/Divine/Unique)'
    )
  }
  if (kind === "races" && isIncompleteRaceConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Race config must declare a valid "raceType": expected "enlightened" or "monster"'
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
  // A NEW equipment entry requires a valid slot AND a valid rarity; a legacy
  // metadata-only config (no slot / no rarity) is never authoritative here.
  if (kind === "equipment" && isIncompleteEquipmentConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Equipment config requires a valid "slot" (one of Head/Chest/Back/Arms/Hands/Legs/Feet/Neck/Ring/Weapon, or a documented legacy alias) and a valid "rarity"'
    )
  }
  // A NEW equipment manifest entry must persist the CANONICAL requirement keys,
  // never the legacy `minRaceLevel` / `requiredRaceType` (the editor migrates
  // them); an existing row that carries them stays readable and enforced.
  if (kind === "equipment" && hasLegacyEquipmentRequirements(config)) {
    throw badRequest(
      "invalid_config",
      'Equipment config uses the legacy "minRaceLevel"/"requiredRaceType"; use the canonical "minimumLevel"/"requiredLevelType"'
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
  archived?: boolean
}

function toExistingRow(row: ExistingCatalogRow): CatalogImportExistingRow {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.sourceUrl ?? null,
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
    status,
    ...(status === "skip_existing" && existingRow
      ? { existing: toExistingRow(existingRow) }
      : {}),
  }
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
 * Verify that every equipment manifest entry's divine-patron reference
 * (`requiredGodStableId`) resolves to a god that will exist unarchived after the
 * import: either an existing unarchived god row, or a god created by this same
 * manifest (import always creates rows with `archived: false`). A dangling patron
 * would render the item permanently ineligible, so it is rejected up front before
 * any write.
 */
function assertManifestEquipmentGodRefs(
  entries: readonly Pick<WikiReviewedEntry, "kind" | "stableId" | "config">[],
  unarchivedGodStableIds: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (entry.kind !== "equipment") continue
    const godStableId = entry.config.requiredGodStableId
    if (typeof godStableId !== "string" || godStableId.length === 0) continue
    if (!unarchivedGodStableIds.has(godStableId)) {
      throw badRequest(
        "invalid_config",
        `Equipment manifest entry "${entry.stableId}" requires divine patron "${godStableId}" which is neither an unarchived catalog god nor a god created by this manifest`
      )
    }
  }
}

/**
 * Verify that every equipment manifest entry's granted-passive-skill reference
 * (`grantedSkillStableIds`) resolves to a skill that will exist unarchived after
 * the import: either an existing unarchived skill row, or a skill created by this
 * same manifest (import always creates rows with `archived: false`). A dangling
 * or archived skill would render the granted passive permanently inert, so it is
 * rejected up front before any write. No-op when the entry is not equipment or
 * grants no skill.
 */
function assertManifestEquipmentSkillRefs(
  entries: readonly Pick<WikiReviewedEntry, "kind" | "stableId" | "config">[],
  unarchivedSkillStableIds: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (entry.kind !== "equipment") continue
    const granted = entry.config.grantedSkillStableIds
    if (!Array.isArray(granted) || granted.length === 0) continue
    for (const stableId of granted) {
      if (typeof stableId !== "string" || stableId.length === 0) continue
      if (!unarchivedSkillStableIds.has(stableId)) {
        throw badRequest(
          "invalid_config",
          `Equipment manifest entry "${entry.stableId}" grants skill "${stableId}" which is neither an unarchived catalog skill nor a skill created by this manifest`
        )
      }
    }
  }
}

/**
 * Verify that every titles manifest entry's granted-skill reference
 * (`grantedSkillStableIds`) resolves to a skill that will exist unarchived after
 * the import: either an existing unarchived skill row, or a skill created by this
 * same manifest (import always creates rows with `archived: false`). A dangling
 * or archived skill would render the granted passive permanently inert, so it is
 * rejected up front before any write. No-op when the entry is not a title or
 * grants no skill. An empty list (a narrative-only title) is valid.
 */
function assertManifestTitleSkillRefs(
  entries: readonly Pick<WikiReviewedEntry, "kind" | "stableId" | "config">[],
  unarchivedSkillStableIds: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (entry.kind !== "titles") continue
    const granted = entry.config.grantedSkillStableIds
    if (!Array.isArray(granted) || granted.length === 0) continue
    for (const stableId of granted) {
      if (typeof stableId !== "string" || stableId.length === 0) continue
      if (!unarchivedSkillStableIds.has(stableId)) {
        throw badRequest(
          "invalid_config",
          `Title manifest entry "${entry.stableId}" grants skill "${stableId}" which is neither an unarchived catalog skill nor a skill created by this manifest`
        )
      }
    }
  }
}

/**
 * Verify that every race/class/profession manifest entry's grade-granted skill
 * reference (`gradeGrantedSkillStableIds`) resolves to a skill that will exist
 * unarchived after the import: either an existing unarchived skill row, or a
 * skill created by this same manifest (import always creates rows with
 * `archived: false`). A dangling or archived skill would render the grade grant
 * permanently inert, so it is rejected up front before any write. No-op when the
 * entry is not a race/class/profession or grants no grade skill.
 */
function assertManifestGradeGrantedSkillRefs(
  entries: readonly Pick<WikiReviewedEntry, "kind" | "stableId" | "config">[],
  unarchivedSkillStableIds: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (
      entry.kind !== "races" &&
      entry.kind !== "classes" &&
      entry.kind !== "professions"
    ) {
      continue
    }
    const refs = allGradeGrantedSkillStableIds(entry.config)
    for (const stableId of refs) {
      if (typeof stableId !== "string" || stableId.length === 0) continue
      if (!unarchivedSkillStableIds.has(stableId)) {
        throw badRequest(
          "invalid_config",
          `Manifest entry "${entry.stableId}" (${entry.kind}) grants grade skill "${stableId}" which is neither an unarchived catalog skill nor a skill created by this manifest`
        )
      }
    }
  }
}

/**
 * Verify that every skills manifest entry's optional class tie
 * (`classStableId`) resolves to a class that will exist after the import: either
 * an existing class row, or a class created by this same manifest (import always
 * creates rows with `archived: false`). A dangling class tie would quietly drop
 * the skill's class-priority sorting, so it is rejected up front before any write.
 * No-op when the entry is not a skill or names no class. This checks existence
 * only - ACTIVENESS of a newly referenced class is the single-entity create path's
 * concern; a manifest class is always created unarchived, so a same-upload
 * reference is always satisfiable.
 */
function assertManifestSkillClassRefs(
  entries: readonly Pick<WikiReviewedEntry, "kind" | "stableId" | "config">[],
  availableClassStableIds: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (entry.kind !== "skills") continue
    const classStableId = skillClassStableIdOf(entry.config)
    if (classStableId == null) continue
    if (!availableClassStableIds.has(classStableId)) {
      throw badRequest(
        "invalid_config",
        `Skills manifest entry "${entry.stableId}" ties to class "${classStableId}" which is neither an existing catalog class nor a class created by this manifest`
      )
    }
  }
}

/**
 * Validate the FINAL skill upgrade graph that this import would commit, using the
 * same pure primitive the service layer uses. Existing skill rows are taken
 * VERBATIM (archived included) so a reference to an existing target stays
 * resolvable; proposed nodes are built from ONLY the new skills this import will
 * actually create (an entry already occupying a (kind, stableId) key - even
 * archived - is skipped and keeps its current archived state, so it is NOT
 * treated as newly unarchived). Because the batch validator overlays every
 * proposed node onto the persisted set and checks the FULL final graph, forward
 * references work regardless of manifest order. A graph error is mapped to a 400
 * import validation error (never a 500).
 */
function assertSkillUpgradeGraphBatch(
  rows: readonly {
    kind: string
    stableId: string
    archived: boolean
    config: unknown
  }[],
  newEntries: readonly {
    kind: string
    stableId: string
    config: Record<string, unknown>
  }[]
): void {
  const existingNodes: SkillUpgradeNode[] = []
  for (const row of rows) {
    if (row.kind !== "skills") continue
    existingNodes.push({
      stableId: row.stableId,
      archived: row.archived,
      config: row.config ?? {},
    })
  }
  const proposedNodes: SkillUpgradeNode[] = []
  for (const entry of newEntries) {
    if (entry.kind !== "skills") continue
    proposedNodes.push({
      stableId: entry.stableId,
      archived: false,
      config: entry.config,
    })
  }
  const error = validateSkillUpgradeBatch(existingNodes, proposedNodes)
  if (error != null) {
    // Mirror the service layer's codes for the two kinds of graph failure: a
    // structural defect (self-link, missing target, cycle, duplicate) versus a
    // NEW edge to an ARCHIVED target.
    const code = error.includes("archived skill")
      ? "skill_upgrade_archived_target"
      : "invalid_skill_upgrade_graph"
    throw badRequest(code, error)
  }
}

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
  // Only entries whose (kind, stableId) key is ABSENT from the existing catalog
  // will actually be written; an entry already occupying the key is skipped and
  // its config is never touched. Reference availability is therefore only
  // meaningful for the NEW entries that would be created, so a skipped row whose
  // referenced god/skill was later archived (or never existed) must not fail the
  // import.
  const newEntries = validated.filter(
    (entry) => !byKey.has(keyOf(entry.kind, entry.stableId))
  )
  const unarchivedGods = new Set(
    rows.filter((r) => r.kind === "gods" && !r.archived).map((r) => r.stableId)
  )
  // A manifest god only becomes newly unarchived when its (kind, stableId) key is
  // ABSENT from the existing catalog. If a god row already exists - even archived -
  // the manifest entry is skipped (existing rows are never overwritten), so the god
  // keeps its current archived state and must NOT satisfy an equipment patron ref.
  for (const entry of newEntries) {
    if (entry.kind === "gods") {
      unarchivedGods.add(entry.stableId)
    }
  }
  // A manifest skill only becomes newly unarchived when its (kind, stableId) key is
  // ABSENT from the existing catalog. If a skill row already exists - even
  // archived - the manifest entry is skipped (existing rows are never
  // overwritten), so the skill keeps its current archived state and must NOT
  // satisfy an equipment granted-skill reference.
  const unarchivedSkillStableIds = new Set(
    rows
      .filter((r) => r.kind === "skills" && !r.archived)
      .map((r) => r.stableId)
  )
  for (const entry of newEntries) {
    if (entry.kind === "skills") {
      unarchivedSkillStableIds.add(entry.stableId)
    }
  }
  // A skills manifest entry's optional class tie must resolve to a class that
  // will exist after import: either an existing UNARCHIVED class row, or a class
  // created by this same manifest (a manifest class is always created unarchived).
  // An archived existing class is rejected, mirroring the single-entity create
  // path (a NEW class-tie selection must be active).
  const availableClassStableIds = new Set(
    rows
      .filter((r) => r.kind === "classes" && !r.archived)
      .map((r) => r.stableId)
  )
  for (const entry of newEntries) {
    if (entry.kind === "classes") {
      availableClassStableIds.add(entry.stableId)
    }
  }
  assertManifestEquipmentGodRefs(newEntries, unarchivedGods)
  assertManifestEquipmentSkillRefs(newEntries, unarchivedSkillStableIds)
  assertManifestTitleSkillRefs(newEntries, unarchivedSkillStableIds)
  assertManifestGradeGrantedSkillRefs(newEntries, unarchivedSkillStableIds)
  assertManifestSkillClassRefs(newEntries, availableClassStableIds)
  assertSkillUpgradeGraphBatch(rows, newEntries)
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
        // Only entries whose (kind, stableId) key is ABSENT from the existing
        // catalog will actually be written; an entry already occupying the key is
        // skipped and its config is never touched. Reference availability is only
        // meaningful for NEW entries, so a skipped row whose referenced god/skill
        // was later archived must not fail the import. Recomputed INSIDE the
        // serializable transaction so an apply never trusts a stale preview.
        const newEntries = validated.filter(
          (entry) => !byKey.has(keyOf(entry.kind, entry.stableId))
        )
        const unarchivedGods = new Set(
          rows
            .filter((r) => r.kind === "gods" && !r.archived)
            .map((r) => r.stableId)
        )
        // Only a manifest god whose (kind, stableId) key is ABSENT from the
        // existing catalog is treated as newly unarchived. A god that already
        // exists - even archived - is skipped (existing rows are never
        // overwritten), so it keeps its current archived state and must NOT
        // satisfy an equipment patron reference.
        for (const entry of newEntries) {
          if (entry.kind === "gods") {
            unarchivedGods.add(entry.stableId)
          }
        }
        // Only a manifest skill whose (kind, stableId) key is ABSENT from the
        // existing catalog is treated as newly unarchived. A skill that already
        // exists - even archived - is skipped (existing rows are never
        // overwritten), so it keeps its current archived state and must NOT
        // satisfy an equipment granted-skill reference.
        const unarchivedSkillStableIds = new Set(
          rows
            .filter((r) => r.kind === "skills" && !r.archived)
            .map((r) => r.stableId)
        )
        for (const entry of newEntries) {
          if (entry.kind === "skills") {
            unarchivedSkillStableIds.add(entry.stableId)
          }
        }
        // A skills manifest entry's optional class tie must resolve to a class that
        // will exist after import: either an existing UNARCHIVED class row, or a
        // class created by this same manifest (a manifest class is always created
        // unarchived). An archived existing class is rejected, mirroring the
        // single-entity create path (a NEW class-tie selection must be active).
        const availableClassStableIds = new Set(
          rows
            .filter((r) => r.kind === "classes" && !r.archived)
            .map((r) => r.stableId)
        )
        for (const entry of newEntries) {
          if (entry.kind === "classes") {
            availableClassStableIds.add(entry.stableId)
          }
        }
        assertManifestEquipmentGodRefs(newEntries, unarchivedGods)
        assertManifestEquipmentSkillRefs(newEntries, unarchivedSkillStableIds)
        assertManifestTitleSkillRefs(newEntries, unarchivedSkillStableIds)
        assertManifestGradeGrantedSkillRefs(
          newEntries,
          unarchivedSkillStableIds
        )
        assertManifestSkillClassRefs(newEntries, availableClassStableIds)
        assertSkillUpgradeGraphBatch(rows, newEntries)
        // Create rows in TWO passes so a skill's per-item classStableId ref and the
        // prevalidated upgrade graph can never observe an interim state. Every
        // non-skill row is written first (the default raw path), then every new
        // skill is written through the service-layer helper with the batch flag,
        // because the FINAL skill upgrade graph was validated above against this
        // same SERIALIZABLE snapshot. The returned entries and createdIds stay in
        // manifest (input) order.
        const createdIdByCreateIndex = new Map<number, string>()
        const pendingSkillCreates: Array<{
          entry: ValidatedEntry
          createIndex: number
        }> = []
        let skipCount = 0
        let createIndexCounter = 0
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
          const createIndex = createIndexCounter++
          resultEntries.push(toPreviewEntry(entry, "create"))
          if (entry.kind === "skills") {
            pendingSkillCreates.push({ entry, createIndex })
          } else {
            const row = await tx.catalogDefinition.create({
              data: {
                kind: entry.kind as never,
                stableId: entry.stableId,
                name: entry.name,
                description: entry.description,
                grade: entry.grade,
                sourceUrl: entry.sourceUrl,
                archived: false,
                config: entry.config as Prisma.InputJsonValue,
                gradeDescriptions:
                  entry.gradeDescriptions as Prisma.InputJsonValue,
              },
            })
            createdIdByCreateIndex.set(createIndex, row.id)
          }
        }
        // Now that every non-skill row exists, create the new skills. Only these
        // skill creates get the `skillGraphValidatedInBatch` flag, because the
        // final graph was validated once up front; every other kind keeps the
        // default per-item path.
        for (const { entry, createIndex } of pendingSkillCreates) {
          const item = await createCatalogItemInTransaction(
            tx,
            "skills",
            {
              stableId: entry.stableId,
              name: entry.name,
              description: entry.description,
              grade: entry.grade,
              sourceUrl: entry.sourceUrl,
              archived: false,
              config: entry.config,
              gradeDescriptions: entry.gradeDescriptions,
            },
            { skillGraphValidatedInBatch: true }
          )
          createdIdByCreateIndex.set(createIndex, item.id)
        }
        const createdIds = [...createdIdByCreateIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, id]) => id)
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
