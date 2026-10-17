/**
 * MCP managed catalog publisher: atomic create-or-update batch preview/apply.
 *
 * Unlike the wizard/CSV bulk upload (which only ever CREATES rows and skips an
 * existing key) and unlike the manifest import, a managed publisher batch is
 * authoritative: an entry whose (kind, stableId) key is absent is created
 * `archived: false`; an entry whose key already exists is UPDATED in place; an
 * entry that would be a no-op is reported `unchanged` and never written. There is
 * no delete, no archive toggle and no stableId rename.
 *
 * The two functions drive a strict two-step flow:
 *   - `previewManagedCatalog(entries)` enters ONE SERIALIZABLE transaction,
 *     computes a conservative `stateDigest` of the ENTIRE catalog (every row,
 *     every field, deep-sorted canonical JSON) BEFORE any write, materializes the
 *     exact same sorted create/update writes the apply would perform, then throws
 *     a private rollback sentinel that is caught only OUTSIDE the transaction so
 *     the writes are rolled back (a real ROLLBACK, never a simulated "we did not
 *     write"). P2002 / P2034 / SQLSTATE 40001 serialization failures are mapped
 *     to 409 `catalog_conflict` exactly as in the apply, and no preview ticket is
 *     minted on a conflict. After the rollback it mints an HMAC `previewTicket`
 *     binding the payload and state digests.
 *   - `applyManagedCatalog(entries, previewTicket)` enters ONE SERIALIZABLE
 *     transaction, recomputes the `stateDigest` BEFORE any write, verifies the
 *     ticket (binding BOTH digests and expiry) BEFORE any mutation, then runs the
 *     same sorted batch writes and commits all or none. P2002 / P2034 /
 *     SQLSTATE 40001 serialization failures are mapped to 409 `catalog_conflict`;
 *     there is never a partial success.
 *
 * The `stateDigest` intentionally hashes EVERY catalog row (not just the batch's
 * keys), so any unrelated edit - including a brand-new key that is not part of
 * this batch - invalidates a preview ticket. This is deliberately conservative:
 * a publisher must re-preview after any other catalog change.
 *
 * Dependency ordering: a batch is topologically sorted so that an entry which
 * references another NEW batch key absent from the database is written after the
 * target. The reference set is exactly the in-batch identity edges the
 * transactional helpers validate (equipment `requiredGodStableId` /
 * `grantedSkillStableIds`; race/class/profession `gradeGrantedSkillStableIds`;
 * title `grantedSkillStableIds`; skill `classStableId`). A reference to an
 * existing (or archived) row outside
 * the batch is validated by the helper itself, which already rejects a missing or
 * archived target. A cycle is impossible to satisfy and is rejected with a 400
 * `catalog_dependency_cycle` BEFORE any write; a valid forward reference is
 * ordered correctly and succeeds.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { badRequest, conflict } from "@/lib/server/errors"
import {
  allGradeGrantedSkillStableIds,
  catalogKindSchema,
  gradeDescriptionsSchema,
  gradeSchema,
  skillClassStableIdOf,
} from "@/lib/server/schemas"
import type { CatalogKind } from "@/lib/db/catalog-import"
import {
  createCatalogItemInTransaction,
  updateCatalogItemInTransaction,
  type CatalogItem,
  type CreateCatalogItemInput,
  type DbClient,
  type UpdateCatalogItemPatch,
} from "@/lib/db/service"
import {
  issueMcpPreviewTicket,
  verifyMcpPreviewTicket,
} from "@/lib/server/mcp-catalog-auth"
import type { Grade } from "@/lib/rules"

// ------------------------------------------------------------------ //
// Limits
// ------------------------------------------------------------------ //

/** At most this many entries per managed batch. */
export const MAX_MANAGED_ENTRIES = 50

/** Individually capped field sizes (>= the admin bulk-upload limits). */

export const MAX_MANAGED_STABLE_ID = 128
export const MAX_MANAGED_NAME = 256
export const MAX_MANAGED_DESCRIPTION = 8000
export const MAX_MANAGED_SOURCE_URL = 2048

/** Serialized config JSON may not exceed this many bytes. */
export const MAX_MANAGED_CONFIG_JSON_BYTES = 64 * 1024

/** A config object may not nest deeper than this many levels. */
export const MAX_MANAGED_CONFIG_NESTING = 12

// ------------------------------------------------------------------ //
// Schema
// ------------------------------------------------------------------ //

/**
 * A `sourceUrl` must be an https URL that names a host. The generic
 * `z.string().url()` would accept an `http:` link or a hostless value, both of
 * which are rejected here so a publisher can never store a broken evidence link.
 */
const optionalHttpsUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value)
        return url.protocol === "https:" && !!url.host
      } catch {
        return false
      }
    },
    { message: "sourceUrl must be an https URL with a host" }
  )

/**
 * A single managed catalog entry. STRICT: only these keys are accepted, so an
 * `archived` flag (or any misspelled / unsupported field) is rejected rather than
 * silently dropped. `kind` is the canonical `catalogKindSchema` (no
 * `consumables` alias). `stableId` and `name` are required and nonempty on BOTH a
 * create and an update (an update must re-declare its name). Every other field is
 * optional; on an update an omitted field is preserved and an explicit `null`
 * clears the nullable ones.
 */
export const managedCatalogEntrySchema = z
  .object({
    kind: catalogKindSchema,
    stableId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    grade: gradeSchema.nullable().optional(),
    sourceUrl: optionalHttpsUrl.nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    gradeDescriptions: gradeDescriptionsSchema.optional(),
  })
  .strict()

export type ManagedCatalogEntry = z.infer<typeof managedCatalogEntrySchema>

/** One entry of the preview/apply result. */
export interface ManagedCatalogChange {
  kind: CatalogKind
  stableId: string
  status: "create" | "update" | "unchanged"
  /** Present only when the key already existed (an update/unchanged entry). */
  before?: CatalogItem
  /** The catalog row as it would be (preview) or is (apply) after the batch. */
  after: CatalogItem
  /** The substantive fields that differ (never createdAt/updatedAt). */
  changedFields: string[]
}

export interface ManagedCatalogPreviewResult {
  changes: ManagedCatalogChange[]
  payloadDigest: string
  stateDigest: string
  previewTicket: string
}

export interface ManagedCatalogApplyResult {
  changes: ManagedCatalogChange[]
  payloadDigest: string
  stateDigest: string
}

// ------------------------------------------------------------------ //
// Deterministic canonical JSON
// ------------------------------------------------------------------ //

/**
 * Lexicographically sort object keys at every level and serialize to a stable
 * string. Used so a content hash never depends on JSON key order (which the
 * database and a caller's object literal may produce differently).
 */
function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`
}

// ------------------------------------------------------------------ //
// Row shape
// ------------------------------------------------------------------ //

/**
 * The subset of a catalog row the publisher reads. Optional fields are modeled as
 * optional so the in-memory test fixture (which may omit a nullable column) and a
 * real Prisma row (where they are `null`) both satisfy the type.
 */
interface CatalogRowLike {
  id: string
  kind: string
  stableId: string
  name: string
  description?: string | null
  grade?: string | null
  sourceUrl?: string | null
  archived?: boolean
  config?: unknown
  gradeDescriptions?: unknown
  createdAt: Date
  updatedAt: Date
}

function normalizeGradeDescriptions(
  value: unknown
): Partial<Record<Grade, string>> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  const out: Partial<Record<Grade, string>> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue
    if (
      !gradeSchema.options.includes(key as (typeof gradeSchema.options)[number])
    ) {
      continue
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    out[key as Grade] = trimmed
  }
  return out
}

function toCatalogItem(row: CatalogRowLike): CatalogItem {
  return {
    id: row.id,
    kind: row.kind,
    stableId: row.stableId,
    name: row.name,
    description: row.description ?? null,
    grade: row.grade ?? null,
    sourceUrl: row.sourceUrl ?? null,
    archived: row.archived ?? false,
    config: (row.config ?? {}) as Record<string, unknown>,
    gradeDescriptions: normalizeGradeDescriptions(row.gradeDescriptions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function rowCanonical(row: CatalogRowLike): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    stableId: row.stableId,
    name: row.name,
    description: row.description ?? null,
    grade: row.grade ?? null,
    sourceUrl: row.sourceUrl ?? null,
    archived: row.archived ?? false,
    config: (row.config ?? {}) as Record<string, unknown>,
    gradeDescriptions: (row.gradeDescriptions ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ------------------------------------------------------------------ //
// Digests
// ------------------------------------------------------------------ //

/**
 * Canonical, order-independent representation of a managed batch. Sort by
 * (kind, stableId) so reordering the submitted array never changes the digest;
 * each entry is serialized with only its present keys so an omitted optional
 * field is distinct from an explicit `null`.
 */
export function computeManagedPayloadDigest(
  entries: readonly ManagedCatalogEntry[]
): string {
  const canonicalBatch = [...entries]
    .sort((a, b) => compareByKey(a, b))
    .map((entry) => {
      const obj: Record<string, unknown> = {
        kind: entry.kind,
        stableId: entry.stableId,
        name: entry.name,
      }
      if (entry.description !== undefined) obj.description = entry.description
      if (entry.grade !== undefined) obj.grade = entry.grade
      if (entry.sourceUrl !== undefined) obj.sourceUrl = entry.sourceUrl
      if (entry.config !== undefined) obj.config = entry.config
      if (entry.gradeDescriptions !== undefined) {
        obj.gradeDescriptions = entry.gradeDescriptions
      }
      return obj
    })
  return createHash("sha256").update(canonical(canonicalBatch)).digest("hex")
}

/**
 * Conservative SHA256 over EVERY catalog row (id, kind, stableId, archived,
 * every field, config, gradeDescriptions, createdAt and updatedAt) serialized as
 * deep-sorted canonical JSON. Any unrelated catalog edit changes this digest, so
 * a preview ticket is invalidated by any change to any row.
 */
export function computeManagedStateDigest(
  rows: readonly CatalogRowLike[]
): string {
  const canonicalRows = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(rowCanonical)
  return createHash("sha256").update(canonical(canonicalRows)).digest("hex")
}

// ------------------------------------------------------------------ //
// Key / comparison helpers
// ------------------------------------------------------------------ //

function keyOf(kind: string, stableId: string): string {
  return `${kind}:${stableId}`
}

function compareByKey(a: ManagedCatalogEntry, b: ManagedCatalogEntry): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
  return a.stableId.localeCompare(b.stableId)
}

// ------------------------------------------------------------------ //
// Validation (pure, before any DB access)
// ------------------------------------------------------------------ //

function maxDepth(value: unknown, depth = 0): number {
  if (value == null || typeof value !== "object") return depth
  let max = depth
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, maxDepth(child, depth + 1))
  }
  return max
}

function assertEntryCaps(entry: ManagedCatalogEntry): void {
  if (entry.stableId.length > MAX_MANAGED_STABLE_ID) {
    throw badRequest(
      "validation",
      `stableId must be at most ${MAX_MANAGED_STABLE_ID} characters (got ${entry.stableId.length})`
    )
  }
  if (entry.name.length > MAX_MANAGED_NAME) {
    throw badRequest(
      "validation",
      `name must be at most ${MAX_MANAGED_NAME} characters (got ${entry.name.length})`
    )
  }
  if (
    entry.description != null &&
    entry.description.length > MAX_MANAGED_DESCRIPTION
  ) {
    throw badRequest(
      "validation",
      `description must be at most ${MAX_MANAGED_DESCRIPTION} characters`
    )
  }
  if (
    entry.sourceUrl != null &&
    entry.sourceUrl.length > MAX_MANAGED_SOURCE_URL
  ) {
    throw badRequest(
      "validation",
      `sourceUrl must be at most ${MAX_MANAGED_SOURCE_URL} characters`
    )
  }
  if (entry.config != null) {
    const json = JSON.stringify(entry.config)
    if (Buffer.byteLength(json, "utf8") > MAX_MANAGED_CONFIG_JSON_BYTES) {
      throw badRequest(
        "validation",
        `config JSON exceeds the ${MAX_MANAGED_CONFIG_JSON_BYTES / 1024}KiB limit`
      )
    }
    if (maxDepth(entry.config) > MAX_MANAGED_CONFIG_NESTING) {
      throw badRequest(
        "validation",
        `config nests deeper than ${MAX_MANAGED_CONFIG_NESTING} levels`
      )
    }
  }
}

/**
 * Validate a managed batch purely: every entry must satisfy the strict schema
 * (rejecting an `archived` flag and any unknown key), the field/nesting caps must
 * hold, a duplicate (kind, stableId) pair must be rejected, at most 50 entries
 * are allowed, and a `races` config must explicitly declare BOTH `raceType` and
 * `naturalGrade` so the service update-merge can never silently retain omitted
 * identity (create is already covered by the modern-shape guard). Returns the
 * schema-normalized entries. Throws 400 BEFORE any database write.
 */
function validateBatch(input: readonly unknown[]): ManagedCatalogEntry[] {
  if (input.length > MAX_MANAGED_ENTRIES) {
    throw badRequest(
      "managed_too_many_entries",
      `Managed catalog batch has ${input.length} entries; the maximum is ${MAX_MANAGED_ENTRIES}`
    )
  }
  const seen = new Set<string>()
  const entries: ManagedCatalogEntry[] = []
  for (const raw of input) {
    const parsed = managedCatalogEntrySchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")
      throw badRequest(
        "validation",
        `Managed catalog entry is invalid${detail ? `: ${detail}` : ""}`
      )
    }
    const entry = parsed.data
    assertEntryCaps(entry)
    const key = keyOf(entry.kind, entry.stableId)
    if (seen.has(key)) {
      throw badRequest(
        "duplicate_managed_entry",
        `Managed catalog batch has a duplicate (kind, stableId) pair: "${entry.stableId}" (${entry.kind})`
      )
    }
    seen.add(key)
    if (entry.kind === "races" && entry.config != null) {
      if (entry.config.raceType == null || entry.config.naturalGrade == null) {
        throw badRequest(
          "invalid_config",
          `Race config must explicitly declare both "raceType" and "naturalGrade" (a config-changing update may not silently retain omitted identity)`
        )
      }
    }
    entries.push(entry)
  }
  return entries
}

// ------------------------------------------------------------------ //
// Dependency ordering
// ------------------------------------------------------------------ //

function refsOf(entry: ManagedCatalogEntry): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const config = entry.config ?? {}
  if (entry.kind === "equipment") {
    const god = config.requiredGodStableId
    if (typeof god === "string" && god.length > 0) out.push(["gods", god])
    const granted = config.grantedSkillStableIds
    if (Array.isArray(granted)) {
      for (const stableId of granted) {
        if (typeof stableId === "string" && stableId.length > 0) {
          out.push(["skills", stableId])
        }
      }
    }
  }
  if (
    entry.kind === "races" ||
    entry.kind === "classes" ||
    entry.kind === "professions"
  ) {
    for (const stableId of allGradeGrantedSkillStableIds(config)) {
      if (typeof stableId === "string" && stableId.length > 0) {
        out.push(["skills", stableId])
      }
    }
  }
  if (entry.kind === "titles") {
    const granted = config.grantedSkillStableIds
    if (Array.isArray(granted)) {
      for (const stableId of granted) {
        if (typeof stableId === "string" && stableId.length > 0) {
          out.push(["skills", stableId])
        }
      }
    }
  }
  if (entry.kind === "skills") {
    const classStableId = skillClassStableIdOf(config)
    if (classStableId) out.push(["classes", classStableId])
  }
  return out
}

/**
 * Sort the batch so an entry is written only after every entry it depends on has
 * been written, where a dependency is another batch entry whose key is absent
 * from the database (a NEW key). Refusals never create an edge against a key that
 * already exists in the database - that row is already satisfiable. Order is
 * deterministic (kind, then stableId) so a given batch always produces the same
 * write order. A dependency cycle (e.g. a new skill whose `classStableId` points
 * at a new class whose `gradeGrantedSkillStableIds` points back at that skill) is
 * rejected with a 400 `catalog_dependency_cycle` listing the affected keys.
 */
function topoSortEntries(
  entries: readonly ManagedCatalogEntry[],
  existingKeys: ReadonlySet<string>
): ManagedCatalogEntry[] {
  const n = entries.length
  const indexByKey = new Map<string, number>()
  entries.forEach((entry, index) => {
    indexByKey.set(keyOf(entry.kind, entry.stableId), index)
  })
  const newBatchKeys = new Set<string>()
  for (const entry of entries) {
    const key = keyOf(entry.kind, entry.stableId)
    if (!existingKeys.has(key)) newBatchKeys.add(key)
  }

  const adjacency: number[][] = Array.from({ length: n }, () => [])
  const inDegree = new Array<number>(n).fill(0)
  for (let index = 0; index < n; index++) {
    for (const [refKind, refStableId] of refsOf(entries[index])) {
      const refKey = keyOf(refKind, refStableId)
      const depIndex = indexByKey.get(refKey)
      if (depIndex === undefined) continue // not in batch (helper rejects later)
      if (!newBatchKeys.has(refKey)) continue // already in DB, no ordering needed
      adjacency[depIndex].push(index)
      inDegree[index] += 1
    }
  }

  const ready: number[] = []
  for (let index = 0; index < n; index++) {
    if (inDegree[index] === 0) ready.push(index)
  }
  const order: number[] = []
  while (ready.length > 0) {
    // Deterministic: among the currently available nodes, take the smallest
    // (kind, stableId) so the write order is reproducible.
    ready.sort((a, b) => compareByKey(entries[a], entries[b]))
    const current = ready.shift()!
    order.push(current)
    for (const dependent of adjacency[current]) {
      inDegree[dependent] -= 1
      if (inDegree[dependent] === 0) ready.push(dependent)
    }
  }

  if (order.length !== n) {
    const inCycle: number[] = []
    for (let index = 0; index < n; index++) {
      if (inDegree[index] > 0) inCycle.push(index)
    }
    const cycleKeys = inCycle
      .map((index) => keyOf(entries[index].kind, entries[index].stableId))
      .sort()
    throw badRequest(
      "catalog_dependency_cycle",
      `Managed catalog batch has a dependency cycle among: ${cycleKeys.join(", ")}`
    )
  }

  return order.map((index) => entries[index])
}

// ------------------------------------------------------------------ //
// Batch preparation
// ------------------------------------------------------------------ //

function prepareBatch(
  rows: readonly CatalogRowLike[],
  entries: readonly ManagedCatalogEntry[]
): { byKey: Map<string, CatalogRowLike>; sorted: ManagedCatalogEntry[] } {
  const byKey = new Map<string, CatalogRowLike>()
  const existingKeys = new Set<string>()
  for (const row of rows) {
    const key = keyOf(row.kind, row.stableId)
    byKey.set(key, row)
    existingKeys.add(key)
  }
  const sorted = topoSortEntries(entries, existingKeys)
  return { byKey, sorted }
}

// ------------------------------------------------------------------ //
// Change materialization
// ------------------------------------------------------------------ //

function createInput(entry: ManagedCatalogEntry): CreateCatalogItemInput {
  const input: CreateCatalogItemInput = {
    stableId: entry.stableId,
    name: entry.name,
  }
  if (entry.description !== undefined) input.description = entry.description
  if (entry.grade !== undefined) input.grade = entry.grade
  if (entry.sourceUrl !== undefined) input.sourceUrl = entry.sourceUrl
  if (entry.config !== undefined) input.config = entry.config
  if (entry.gradeDescriptions !== undefined) {
    input.gradeDescriptions = entry.gradeDescriptions
  }
  return input
}

function buildPatch(entry: ManagedCatalogEntry): UpdateCatalogItemPatch {
  const patch: UpdateCatalogItemPatch = {
    name: entry.name,
  }
  if (entry.description !== undefined) patch.description = entry.description
  if (entry.grade !== undefined) patch.grade = entry.grade
  if (entry.sourceUrl !== undefined) patch.sourceUrl = entry.sourceUrl
  if (entry.config !== undefined) patch.config = entry.config
  if (entry.gradeDescriptions !== undefined) {
    patch.gradeDescriptions = entry.gradeDescriptions
  }
  return patch
}

function providedFieldNames(entry: ManagedCatalogEntry): string[] {
  const names = ["name"]
  if (entry.description !== undefined) names.push("description")
  if (entry.grade !== undefined) names.push("grade")
  if (entry.sourceUrl !== undefined) names.push("sourceUrl")
  if (entry.config !== undefined) names.push("config")
  if (entry.gradeDescriptions !== undefined) names.push("gradeDescriptions")
  return names
}

/** The values an update would produce, merging the entry over the existing row. */
function proposedAfter(
  before: CatalogItem,
  entry: ManagedCatalogEntry
): Pick<
  CatalogItem,
  | "name"
  | "description"
  | "grade"
  | "sourceUrl"
  | "archived"
  | "config"
  | "gradeDescriptions"
> {
  return {
    name: entry.name,
    description:
      entry.description !== undefined ? entry.description : before.description,
    grade: entry.grade !== undefined ? entry.grade : before.grade,
    sourceUrl:
      entry.sourceUrl !== undefined ? entry.sourceUrl : before.sourceUrl,
    archived: before.archived,
    config: entry.config !== undefined ? entry.config : before.config,
    gradeDescriptions:
      entry.gradeDescriptions !== undefined
        ? entry.gradeDescriptions
        : before.gradeDescriptions,
  }
}

function isNoChange(before: CatalogItem, entry: ManagedCatalogEntry): boolean {
  const proposed = proposedAfter(before, entry)
  return (
    canonical(before.name) === canonical(proposed.name) &&
    canonical(before.description ?? null) ===
      canonical(proposed.description ?? null) &&
    canonical(before.grade ?? null) === canonical(proposed.grade ?? null) &&
    canonical(before.sourceUrl ?? null) ===
      canonical(proposed.sourceUrl ?? null) &&
    canonical(before.archived) === canonical(proposed.archived) &&
    canonical(before.config) === canonical(proposed.config) &&
    canonical(before.gradeDescriptions) ===
      canonical(proposed.gradeDescriptions)
  )
}

function diffSubstantive(before: CatalogItem, after: CatalogItem): string[] {
  const candidates: Array<[string, unknown, unknown]> = [
    ["name", before.name, after.name],
    ["description", before.description ?? null, after.description ?? null],
    ["grade", before.grade ?? null, after.grade ?? null],
    ["sourceUrl", before.sourceUrl ?? null, after.sourceUrl ?? null],
    ["archived", before.archived, after.archived],
    ["config", before.config, after.config],
    ["gradeDescriptions", before.gradeDescriptions, after.gradeDescriptions],
  ]
  return candidates
    .filter(([field, beforeValue, afterValue]) => {
      void field
      return canonical(beforeValue) !== canonical(afterValue)
    })
    .map(([field]) => field)
}

/**
 * Run the exact same create/update writes the apply would commit, against the
 * caller-owned transaction, and report each entry's resulting status. An entry
 * whose key already exists but is ARCHIVED is rejected (managed publish is
 * create-active only): a 409 before any write for that entry (and, because the
 * transaction rolls back on a throw, before any partial commit).
 */
async function materializeChanges(
  tx: DbClient,
  byKey: Map<string, CatalogRowLike>,
  sorted: readonly ManagedCatalogEntry[]
): Promise<ManagedCatalogChange[]> {
  const changes: ManagedCatalogChange[] = []
  for (const entry of sorted) {
    const key = keyOf(entry.kind, entry.stableId)
    const existingRow = byKey.get(key)
    if (existingRow === undefined) {
      const after = await createCatalogItemInTransaction(
        tx,
        entry.kind,
        createInput(entry)
      )
      changes.push({
        kind: entry.kind,
        stableId: entry.stableId,
        status: "create",
        after,
        changedFields: providedFieldNames(entry),
      })
      continue
    }

    if (existingRow.archived) {
      throw conflict(
        "catalog_archived_conflict",
        `Catalog entry "${entry.stableId}" (${entry.kind}) is archived; a managed publish requires an active entry and cannot unarchive it`
      )
    }

    const before = toCatalogItem(existingRow)
    if (isNoChange(before, entry)) {
      changes.push({
        kind: entry.kind,
        stableId: entry.stableId,
        status: "unchanged",
        before,
        after: before,
        changedFields: [],
      })
      continue
    }

    const after = await updateCatalogItemInTransaction(
      tx,
      entry.kind,
      existingRow.id,
      buildPatch(entry)
    )
    changes.push({
      kind: entry.kind,
      stableId: entry.stableId,
      status: "update",
      before,
      after,
      changedFields: diffSubstantive(before, after),
    })
  }
  return changes
}

/** Reorder a materialized result back to the order the caller submitted. */
function toInputOrder(
  changes: readonly ManagedCatalogChange[],
  entries: readonly ManagedCatalogEntry[]
): ManagedCatalogChange[] {
  const byKey = new Map(
    changes.map((change) => [keyOf(change.kind, change.stableId), change])
  )
  const out: ManagedCatalogChange[] = []
  for (const entry of entries) {
    const change = byKey.get(keyOf(entry.kind, entry.stableId))
    if (change !== undefined) out.push(change)
  }
  return out
}

// ------------------------------------------------------------------ //
// Error mapping
// ------------------------------------------------------------------ //

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

function isSerializationFailure(err: unknown): boolean {
  if (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
  ) {
    return true
  }
  const meta = (err as { meta?: { code?: string; message?: string } }).meta
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2010" &&
    (meta?.code === "40001" ||
      meta?.message?.includes("could not serialize access") === true)
  )
}

// ------------------------------------------------------------------ //
// Preview / apply
// ------------------------------------------------------------------ //

/** Private sentinel thrown to force a genuine ROLLBACK of the preview transaction. */
const PREVIEW_ROLLBACK_SENTINEL = Symbol("mcp-catalog-preview-rollback")

/**
 * Preview a managed batch against the live catalog WITHOUT mutating it. Enters
 * one SERIALIZABLE transaction, computes the state digest BEFORE any write,
 * materializes the exact create/update writes, then throws a private sentinel so
 * every write is rolled back (a real ROLLBACK, not a "we decided not to write"),
 * and finally mints an HMAC preview ticket over the payload/state digests.
 * P2002 / P2034 / SQLSTATE 40001 serialization failures are surfaced as 409
 * `catalog_conflict` (no preview ticket is minted on a conflict); any validation
 * or reference failure is NOT the sentinel and propagates, as does any other
 * unexpected error.
 */
export async function previewManagedCatalog(
  entries: readonly ManagedCatalogEntry[]
): Promise<ManagedCatalogPreviewResult> {
  const normalized = validateBatch(entries)
  const payloadDigest = computeManagedPayloadDigest(normalized)

  let stateDigest = ""
  let changes: ManagedCatalogChange[] = []

  try {
    await prisma.$transaction(
      async (tx) => {
        const rows = await tx.catalogDefinition.findMany({})
        stateDigest = computeManagedStateDigest(rows)
        const { byKey, sorted } = prepareBatch(rows, normalized)
        changes = await materializeChanges(tx, byKey, sorted)
        throw PREVIEW_ROLLBACK_SENTINEL
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  } catch (err) {
    if (err !== PREVIEW_ROLLBACK_SENTINEL) {
      if (isUniqueViolation(err) || isSerializationFailure(err)) {
        throw conflict(
          "catalog_conflict",
          "A concurrent catalog change conflicts with this batch; retry the request"
        )
      }
      throw err
    }
  }

  return {
    changes: toInputOrder(changes, normalized),
    payloadDigest,
    stateDigest,
    previewTicket: issueMcpPreviewTicket(payloadDigest, stateDigest),
  }
}

/**
 * Apply a managed batch atomically. Enters one SERIALIZABLE transaction,
 * recomputes the state digest BEFORE any write, verifies the ticket (payload +
 * state digest binding and expiry) BEFORE any mutation, then runs the same sorted
 * batch create/update writes and commits all or none. P2002 / P2034 /
 * SQLSTATE 40001 serialization failures (including a raw-query serialization
 * failure) are mapped to 409 `catalog_conflict`; there is never a partial write
 * and the apply never commits a row for an unchanged entry.
 */
export async function applyManagedCatalog(
  entries: readonly ManagedCatalogEntry[],
  previewTicket: string
): Promise<ManagedCatalogApplyResult> {
  const normalized = validateBatch(entries)
  const payloadDigest = computeManagedPayloadDigest(normalized)

  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = await tx.catalogDefinition.findMany({})
        const stateDigest = computeManagedStateDigest(rows)
        verifyMcpPreviewTicket(previewTicket, payloadDigest, stateDigest)
        const { byKey, sorted } = prepareBatch(rows, normalized)
        const changes = await materializeChanges(tx, byKey, sorted)
        return {
          changes: toInputOrder(changes, normalized),
          payloadDigest,
          stateDigest,
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  } catch (err) {
    if (isUniqueViolation(err) || isSerializationFailure(err)) {
      throw conflict(
        "catalog_conflict",
        "A concurrent catalog change conflicts with this batch; retry the request"
      )
    }
    throw err
  }
}
