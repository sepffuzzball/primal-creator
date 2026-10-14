/**
 * Admin-only, repeatable, atomic bulk catalog upload (JSON or CSV) with a
 * preview/apply two-step. Unlike the fixed wiki-reviewed manifest, this acceptS
 * arbitrary admin-provided rows, so it must never trust anything an admin typed:
 * every row is fully validated BEFORE any write, and no row is overwritten.
 *
 * The two-step flow is explicit (never implicit):
 *   - `previewBulkImport` computes, against the live database and WITHOUT
 *     mutating anything, which uploaded entries would be created and which would
 *     be skipped because a row with the same (kind, stableId) already exists.
 *   - `applyBulkImport` validates every entry, then inserts ALL missing rows in
 *     ONE Prisma SERIALIZABLE transaction, re-checking existence inside the
 *     transaction. An identical repeat call skips every existing row, and a
 *     concurrent conflicting import surfaces as a 409 with no partial write.
 *
 * The optional `previewDigest` is a content-integrity hash (SHA256 of
 * `format + '\0' + content`), not proof that a preview step ran. It is not a
 * server-issued token: an admin or programmatic caller may call apply directly
 * with no digest at all, because preview and admin confirmation are UI policy,
 * not a server-enforced prerequisite. When a caller DOES supply a digest, the
 * apply route recomputes the hash from the uploaded text and rejects a mismatch
 * BEFORE any write, so an apply never operates on bytes that differ from what
 * the caller described.
 *
 * Policy (distinct from the wiki-reviewed import):
 *   - Existing catalog rows are NEVER overwritten. An entry whose (kind, stableId)
 *     already exists is skipped, leaving its config / slug untouched.
 *     A skipped entry carries `existing` (read from the actual live row, never the
 *     upload) so the admin sees exactly what was preserved.
 *   - `sourceUrl` is optional but, when supplied, must be an https URL that names
 *     a host (an `http:` or hostless value is rejected).
 *   - No automatic granting to characters: the importer only creates catalog rows;
 *     it never touches character associations.
 *
 * Patron-god rules (blessings only, only for entries that would be CREATED; a
 * skip-existing blessing needs no revalidation):
 *   - A would-create blessing's `config.patronGodStableId` must resolve to a valid
 *     UNARCHIVED existing god OR to a god that would be created by the SAME upload
 *     (regardless of row order).
 *   - If a god stableId exists archived and the batch does not recreate it, the
 *     referencing blessing is rejected.
 *
 * Validation uses `catalogCreateSchema` + `parseCatalogConfig` +
 * `assertModernConfig` (the same modern-shape guards the service layer applies on
 * a create), plus the explicit length bounds and the https sourceUrl rule above.
 * It does NOT reuse the wiki-reviewed fixed-inferred validator, and it never
 * copies an untrusted `config` into the DB unvalidated.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import {
  ApiError,
  badRequest,
  conflict,
  payloadTooLarge,
} from "@/lib/server/errors"
import {
  catalogCreateSchema,
  catalogKindSchema,
  gradeDescriptionsSchema,
  gradeSchema,
  parseCatalogConfig,
} from "@/lib/server/schemas"
import { assertModernConfig, type CatalogKind } from "@/lib/db/catalog-import"
import type { Grade } from "@/lib/rules"

// ------------------------------------------------------------------ //
// Limits
// ------------------------------------------------------------------ //

/** At most this many entries per upload. */
export const MAX_BULK_ENTRIES = 250

/** The decoded `content` (UTF-8) may not exceed this many bytes. */
export const MAX_BULK_CONTENT_BYTES = 1024 * 1024

/**
 * The raw request body (before JSON parsing) may not exceed this many bytes. The
 * stream is hard-capped at this even when Content-Length is absent or bogus.
 */
export const MAX_BULK_REQUEST_BYTES = 4 * 1024 * 1024

const MAX_STABLE_ID = 128
const MAX_NAME = 256
const MAX_DESCRIPTION = 8000
const MAX_SOURCE_URL = 2048

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //

export type BulkFormat = "json" | "csv"

/**
 * A fully validated, canonical bulk entry. `grade` is normalized
 * (`Grade | null`), `config` is the parsed per-kind config, and `row` is the
 * 1-based physical row/line (JSON array index + 1, or the CSV physical starting
 * line) used to report errors back to the admin.
 */
export interface BulkCatalogEntry {
  row: number
  kind: CatalogKind
  stableId: string
  name: string
  description: string | null
  grade: Grade | null
  sourceUrl: string | null
  config: Record<string, unknown>
  gradeDescriptions: Partial<Record<Grade, string>>
}

/** Metadata read from the ACTUAL existing catalog row that occupies a key. */
export interface BulkImportExistingRow {
  id: string
  name: string
  sourceUrl: string | null
  archived: boolean
}

/** One row of the preview/apply result. */
export interface BulkImportEntryPreview {
  row: number
  kind: CatalogKind
  stableId: string
  /**
   * The PROPOSED upload values. `name` / `sourceUrl` always describe what the
   * upload WOULD create; they are never overwritten by an existing row (see
   * `existing` for what was actually preserved).
   */
  name: string
  sourceUrl: string | null
  status: "create" | "skip_existing"
  /**
   * Present ONLY when `status` is `"skip_existing"`: metadata read directly from
   * the actual existing catalog row (never copied from the upload).
   */
  existing?: BulkImportExistingRow
}

/** The read-only preview result. */
export interface BulkImportResult {
  source: "bulk"
  previewDigest: string
  entries: BulkImportEntryPreview[]
  createCount: number
  skipCount: number
}

/** The apply result; additionally identifies the created catalog row ids. */
export interface BulkApplyResult extends BulkImportResult {
  createdIds: string[]
}

/** A validated upload request body (already JSON-decoded and size-checked). */
export interface BulkUploadPayload {
  format: BulkFormat
  content: string
  previewDigest?: string
}

// Raw entry before per-field validation; used only internally.
interface RawBulkEntry {
  row: number
  kind: unknown
  stableId: unknown
  name: unknown
  description: unknown
  grade: unknown
  sourceUrl: unknown
  config: unknown
  gradeDescriptions: unknown
}

// ------------------------------------------------------------------ //
// Request body schema
// ------------------------------------------------------------------ //

export const bulkUploadRequestSchema = z.object({
  format: z.enum(["json", "csv"]),
  content: z.string(),
  previewDigest: z.string().optional(),
})

// ------------------------------------------------------------------ //
// Digest
// ------------------------------------------------------------------ //

/**
 * SHA256 of `format + '\0' + content`, hex encoded. This is a content-integrity
 * hash of the exact bytes a caller uploaded - intentionally tied to the raw text
 * (not the parsed rows), so any byte-level change yields a different hash. It is
 * NOT proof that a preview step ran: apply verifies it only when a caller
 * supplies one.
 */
export function computeBulkRequestDigest(
  format: BulkFormat,
  content: string
): string {
  return createHash("sha256").update(`${format}\0${content}`).digest("hex")
}

// ------------------------------------------------------------------ //
// Request body reader (HTTP concern, shared by preview and apply routes)
// ------------------------------------------------------------------ //

/**
 * Read and validate the bulk upload request body with a hard byte cap, throwing a
 * 413 before the JSON is ever parsed. A trusted `Content-Length` header is
 * checked up front so an obviously oversized body is rejected without reading a
 * single byte; a missing or bogus (non-numeric) value falls back to the streamed
 * hard limit. After decoding the outer JSON envelope the decoded `content` is
 * separately capped at 1 MiB (400 `content_too_large`).
 */
export async function readBulkUploadRequest(
  req: Request
): Promise<BulkUploadPayload> {
  const declared = req.headers.get("content-length")
  if (declared != null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_BULK_REQUEST_BYTES) {
      throw payloadTooLarge(
        "payload_too_large",
        `Bulk request body exceeds the ${MAX_BULK_REQUEST_BYTES / (1024 * 1024)}MiB limit`
      )
    }
  }

  const reader = req.body?.getReader()
  let raw = ""
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BULK_REQUEST_BYTES) {
        await reader.cancel()
        throw payloadTooLarge(
          "payload_too_large",
          `Bulk request body exceeds the ${MAX_BULK_REQUEST_BYTES / (1024 * 1024)}MiB limit`
        )
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    raw = new TextDecoder().decode(merged)
  }

  let body: unknown
  try {
    body = raw.length ? JSON.parse(raw) : undefined
  } catch {
    throw badRequest("validation", "Bulk request body is not valid JSON")
  }
  const parsed = bulkUploadRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest("validation", "Invalid bulk upload payload")
  }
  if (Buffer.byteLength(parsed.data.content, "utf8") > MAX_BULK_CONTENT_BYTES) {
    throw badRequest(
      "content_too_large",
      `Bulk content exceeds the ${MAX_BULK_CONTENT_BYTES / (1024 * 1024)}MiB limit`
    )
  }
  return parsed.data
}

// ------------------------------------------------------------------ //
// Parsing + validation
// ------------------------------------------------------------------ //

function keyOf(kind: string, stableId: string): string {
  return `${kind}:${stableId}`
}

function requireString(value: unknown, row: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: "${field}" is required and must be a nonempty string`
    )
  }
  return value.trim()
}

function optionalNullableString(
  value: unknown,
  row: number,
  field: string
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") {
    throw badRequest(
      "validation",
      `Bulk row ${row}: "${field}" must be a string or null`
    )
  }
  const s = value.trim()
  return s.length ? s : null
}

function optionalGrade(value: unknown, row: number): Grade | null {
  if (value === undefined || value === null) return null
  if (typeof value === "string" && value.trim() === "") return null
  const parsed = gradeSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw badRequest(
    "validation",
    `Bulk row ${row}: invalid grade "${typeof value === "string" ? value : JSON.stringify(value)}"`
  )
}

/**
 * Validate an optional `gradeDescriptions` map against `gradeDescriptionsSchema`.
 * An omitted / null value yields an empty map (no authored grade text). The
 * schema rejects an unknown grade key, a blank value, and an oversized value; a
 * valid value is trimmed and returned.
 */
function validateGradeDescriptions(
  value: unknown,
  row: number
): Partial<Record<Grade, string>> {
  if (value === undefined || value === null) return {}
  const parsed = gradeDescriptionsSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join("; ")
    throw badRequest(
      "validation",
      `Bulk row ${row}: gradeDescriptions is invalid${
        detail ? `: ${detail}` : ""
      }`
    )
  }
  return parsed.data
}

function assertHttpsSource(source: string, row: number): void {
  let url: URL | null = null
  try {
    url = new URL(source)
  } catch {
    url = null
  }
  if (!url || url.protocol !== "https:" || !url.host) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: sourceUrl must be an https URL with a host (got "${source}")`
    )
  }
}

function requireRecord(value: unknown, row: number): Record<string, unknown> {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: "config" is required and must be a JSON object`
    )
  }
  return value as Record<string, unknown>
}

function validateBulkEntry(raw: RawBulkEntry): BulkCatalogEntry {
  const row = raw.row
  const kind = requireString(raw.kind, row, "kind")
  if (!catalogKindSchema.safeParse(kind).success) {
    throw badRequest(
      "invalid_kind",
      `Bulk row ${row}: unknown catalog kind "${kind}"`
    )
  }
  const stableId = requireString(raw.stableId, row, "stableId")
  if (stableId.length > MAX_STABLE_ID) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: stableId must be at most ${MAX_STABLE_ID} characters`
    )
  }
  const name = requireString(raw.name, row, "name")
  if (name.length > MAX_NAME) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: name must be at most ${MAX_NAME} characters`
    )
  }
  const description = optionalNullableString(
    raw.description,
    row,
    "description"
  )
  if (description != null && description.length > MAX_DESCRIPTION) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: description must be at most ${MAX_DESCRIPTION} characters`
    )
  }
  const grade = optionalGrade(raw.grade, row)
  const sourceUrl = optionalNullableString(raw.sourceUrl, row, "sourceUrl")
  if (sourceUrl != null && sourceUrl.length > MAX_SOURCE_URL) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: sourceUrl must be at most ${MAX_SOURCE_URL} characters`
    )
  }
  if (sourceUrl != null) assertHttpsSource(sourceUrl, row)
  const config = requireRecord(raw.config, row)

  const parsedCreate = catalogCreateSchema.safeParse({
    stableId,
    name,
    description,
    grade: grade ?? null,
    sourceUrl: sourceUrl ?? null,
    config,
  })
  if (!parsedCreate.success) {
    throw badRequest(
      "validation",
      `Bulk row ${row}: entry does not satisfy the catalog schema`
    )
  }

  let parsedConfig: Record<string, unknown>
  try {
    parsedConfig = parseCatalogConfig(kind, config)
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid catalog config"
    throw badRequest(
      "invalid_config",
      `Bulk row ${row}: invalid config: ${message}`
    )
  }
  try {
    assertModernConfig(kind, parsedConfig)
  } catch (err) {
    if (err instanceof ApiError) {
      // Preserve the `invalid_config` code/status and add the row number so the
      // admin can locate the offending line.
      throw badRequest(err.code, `Bulk row ${row}: ${err.message}`)
    }
    const message =
      err instanceof Error ? err.message : "Invalid catalog config"
    throw badRequest("invalid_config", `Bulk row ${row}: ${message}`)
  }

  return {
    row,
    kind: kind as CatalogKind,
    stableId,
    name,
    description,
    grade,
    sourceUrl: sourceUrl ?? null,
    config: parsedConfig,
    gradeDescriptions: validateGradeDescriptions(raw.gradeDescriptions, row),
  }
}

function assertNoDuplicates(entries: readonly BulkCatalogEntry[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = keyOf(entry.kind, entry.stableId)
    if (seen.has(key)) {
      throw badRequest(
        "duplicate_bulk_entry",
        `Bulk import has a duplicate (kind, stableId) pair at row ${entry.row}: "${entry.stableId}" (${entry.kind})`
      )
    }
    seen.add(key)
  }
}

/**
 * Parse and fully validate the uploaded content into canonical `BulkCatalogEntry`
 * rows. This is a pure function (no DB access): it splits the text into rows,
 * validates every field, rejects a duplicate (kind, stableId), and enforces the
 * 250-entry cap - all BEFORE any write.
 */
export function parseBulkEntries(
  format: BulkFormat,
  content: string
): BulkCatalogEntry[] {
  const raw =
    format === "json" ? parseJsonContent(content) : parseCsvContent(content)
  const entries = raw.map(validateBulkEntry)
  if (entries.length > MAX_BULK_ENTRIES) {
    throw badRequest(
      "bulk_too_many_entries",
      `Bulk import has ${entries.length} entries; the maximum is ${MAX_BULK_ENTRIES}`
    )
  }
  assertNoDuplicates(entries)
  return entries
}

// ------------------------------------------------------------------ //
// JSON parsing
// ------------------------------------------------------------------ //

/**
 * The only own keys a JSON entry object may carry. Anything else is a
 * misspelled or unsupported field (e.g. `archived`), and rejecting it is what
 * prevents a typo from silently dropping data. Config's own unknown properties
 * are NOT restricted here: the per-kind config parser owns those.
 */
const ALLOWED_JSON_ENTRY_KEYS = new Set([
  "kind",
  "stableId",
  "name",
  "description",
  "grade",
  "provenance",
  "sourceUrl",
  "config",
  "gradeDescriptions",
])

function parseJsonContent(content: string): RawBulkEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw badRequest("validation", "Bulk JSON content is not valid JSON")
  }
  if (!Array.isArray(parsed)) {
    throw badRequest(
      "validation",
      "Bulk JSON content must be an array of entries"
    )
  }
  return parsed.map((value, index): RawBulkEntry => {
    const row = index + 1
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw badRequest(
        "validation",
        `Bulk row ${row}: each JSON entry must be a plain object`
      )
    }
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_JSON_ENTRY_KEYS.has(key)) {
        throw badRequest(
          "validation",
          `Bulk row ${row}: unknown field "${key}"`
        )
      }
    }
    return {
      row,
      kind: obj.kind,
      stableId: obj.stableId,
      name: obj.name,
      description: obj.description,
      grade: obj.grade,
      sourceUrl: obj.sourceUrl,
      config: obj.config,
      gradeDescriptions: obj.gradeDescriptions,
    }
  })
}

// ------------------------------------------------------------------ //
// CSV parsing (RFC 4180)
// ------------------------------------------------------------------ //

const REQUIRED_CSV_HEADERS = new Set(["kind", "stableId", "name", "config"])
const OPTIONAL_CSV_HEADERS = new Set([
  "description",
  "grade",
  "provenance",
  "sourceUrl",
  "gradeDescriptions",
])

interface CsvRecord {
  row: number
  fields: string[]
}

/**
 * Strict RFC 4180 tokenizer. Handles an optional UTF-8 BOM, CRLF/LF/CR line
 * endings, quoted fields with embedded commas and newlines, and doubled quotes
 * (`""`). Malformed quoted input is rejected with a row-numbered 400: an
 * unterminated quoted field, any non-delimiter character (including whitespace)
 * appearing immediately after a closing quote, and an unescaped quote inside an
 * unquoted field are all invalid. The `row` of each record is its 1-based
 * physical starting line, which is used to report errors back to the admin
 * against the file the admin actually sees.
 */
function parseCsvRecords(input: string): CsvRecord[] {
  const content = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const records: CsvRecord[] = []
  let fields: string[] = []
  let field = ""
  let inQuotes = false
  let afterQuote = false
  let line = 1
  let recordStartLine = 1
  const n = content.length
  let i = 0

  const csvFail = (message: string): never => {
    throw badRequest(
      "validation",
      `Bulk CSV row ${recordStartLine}: ${message}`
    )
  }

  const endField = () => {
    fields.push(field)
    field = ""
  }
  const endRecord = () => {
    endField()
    records.push({ row: recordStartLine, fields })
    fields = []
  }

  while (i < n) {
    const c = content[i]
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          afterQuote = true
          i += 1
        }
      } else if (c === "\n") {
        field += "\n"
        line += 1
        i += 1
      } else if (c === "\r") {
        if (content[i + 1] === "\n") {
          field += "\r\n"
          line += 1
          i += 2
        } else {
          field += "\r"
          line += 1
          i += 1
        }
      } else {
        field += c
        i += 1
      }
    } else if (afterQuote) {
      if (c === ",") {
        endField()
        afterQuote = false
        i += 1
      } else if (c === "\n") {
        endRecord()
        afterQuote = false
        line += 1
        recordStartLine = line
        i += 1
      } else if (c === "\r") {
        if (content[i + 1] === "\n") {
          endRecord()
          afterQuote = false
          line += 1
          recordStartLine = line
          i += 2
        } else {
          endRecord()
          afterQuote = false
          line += 1
          recordStartLine = line
          i += 1
        }
      } else {
        csvFail(`unexpected character "${c}" after a closing quote`)
      }
    } else {
      if (c === '"') {
        if (field.length === 0) {
          inQuotes = true
          i += 1
        } else {
          csvFail("unescaped quote in an unquoted field")
        }
      } else if (c === ",") {
        endField()
        i += 1
      } else if (c === "\n") {
        endRecord()
        line += 1
        recordStartLine = line
        i += 1
      } else if (c === "\r") {
        if (content[i + 1] === "\n") {
          endRecord()
          line += 1
          recordStartLine = line
          i += 2
        } else {
          endRecord()
          line += 1
          recordStartLine = line
          i += 1
        }
      } else {
        field += c
        i += 1
      }
    }
  }

  if (inQuotes) {
    csvFail("unterminated quoted field")
  }

  if (field.length > 0 || fields.length > 0 || afterQuote) {
    endRecord()
  }
  return records
}

function isBlankRecord(record: CsvRecord): boolean {
  return record.fields.length === 1 && record.fields[0] === ""
}

/**
 * Parse an optional CSV `gradeDescriptions` cell into a JSON object. An absent or
 * blank cell means no authored map (undefined). A non-blank cell must be valid
 * JSON that is a plain object; anything else is rejected with a row-numbered 400.
 * The numeric/string grade keys and value bounds are validated later by
 * `validateGradeDescriptions`, so only the JSON parse is enforced here.
 */
function optionalGradeDescriptionsCsv(
  value: string | undefined,
  row: number
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const s = value.trim()
  if (s.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    throw badRequest(
      "validation",
      `Bulk CSV row ${row}: gradeDescriptions must be valid JSON`
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest(
      "validation",
      `Bulk CSV row ${row}: gradeDescriptions must be a JSON object`
    )
  }
  return parsed as Record<string, unknown>
}

function parseCsvContent(content: string): RawBulkEntry[] {
  const records = parseCsvRecords(content).filter((r) => !isBlankRecord(r))
  if (records.length === 0) {
    throw badRequest("validation", "Bulk CSV content is empty")
  }
  const header = records[0]
  const indexByName = new Map<string, number>()
  header.fields.forEach((fieldName, idx) => {
    const name = fieldName.trim()
    if (indexByName.has(name)) {
      throw badRequest(
        "validation",
        `Bulk CSV has a duplicate header "${name}"`
      )
    }
    if (!REQUIRED_CSV_HEADERS.has(name) && !OPTIONAL_CSV_HEADERS.has(name)) {
      throw badRequest("validation", `Bulk CSV has an unknown header "${name}"`)
    }
    indexByName.set(name, idx)
  })
  for (const req of REQUIRED_CSV_HEADERS) {
    if (!indexByName.has(req)) {
      throw badRequest(
        "validation",
        `Bulk CSV is missing required header "${req}"`
      )
    }
  }
  const fieldCount = header.fields.length
  const rows: RawBulkEntry[] = []
  for (const record of records.slice(1)) {
    if (record.fields.length !== fieldCount) {
      throw badRequest(
        "validation",
        `Bulk CSV row ${record.row} has ${record.fields.length} fields; expected ${fieldCount}`
      )
    }
    const get = (name: string): string | undefined => {
      const idx = indexByName.get(name)
      return idx === undefined ? undefined : record.fields[idx]
    }
    const configRaw = get("config") ?? ""
    let config: unknown
    try {
      config = JSON.parse(configRaw)
    } catch {
      throw badRequest(
        "validation",
        `Bulk CSV row ${record.row}: config must be valid JSON`
      )
    }
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      throw badRequest(
        "validation",
        `Bulk CSV row ${record.row}: config must be a JSON object`
      )
    }
    rows.push({
      row: record.row,
      kind: get("kind"),
      stableId: get("stableId"),
      name: get("name"),
      description: get("description"),
      grade: get("grade"),
      sourceUrl: get("sourceUrl"),
      config,
      gradeDescriptions: optionalGradeDescriptionsCsv(
        get("gradeDescriptions"),
        record.row
      ),
    })
  }
  return rows
}

// ------------------------------------------------------------------ //
// Existing-row echo
// ------------------------------------------------------------------ //

interface ExistingCatalogRowSource {
  id: string
  name: string
  sourceUrl?: string | null
  archived?: boolean
}

function toExistingRow(row: ExistingCatalogRowSource): BulkImportExistingRow {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.sourceUrl ?? null,
    archived: row.archived ?? false,
  }
}

// ------------------------------------------------------------------ //
// Patron-god validation
// ------------------------------------------------------------------ //

/**
 * Assert that a would-create blessing's patron god is acceptable. A god already
 * created by the SAME upload is always acceptable (it will be unarchived when
 * created). Otherwise the god must exist in the live catalog, be unarchived, and
 * NOT be skipped by the batch (a batch-skipped archived god is rejected).
 */
function assertBulkPatronGod(
  byKey: Map<string, BulkImportExistingRow>,
  wouldCreateGodKeys: Set<string>,
  stableId: string,
  row: number
): void {
  if (wouldCreateGodKeys.has(keyOf("gods", stableId))) return
  const god = byKey.get(keyOf("gods", stableId))
  if (!god) {
    throw badRequest(
      "patron_god_not_found",
      `Bulk row ${row}: patron god "${stableId}" is not in the catalog`
    )
  }
  if (god.archived) {
    throw badRequest(
      "patron_god_archived",
      `Bulk row ${row}: patron god "${god.name}" is archived; unarchive it before granting its blessing`
    )
  }
}

/**
 * Resolve the `patronId` FK for a would-create blessing, after gods have been
 * inserted first. A batch-created patron god resolves through `createdByKey`;
 * an existing unarchived patron god resolves through `byKey`.
 */
async function blessingPatronData(
  tx: Prisma.TransactionClient,
  entry: BulkCatalogEntry,
  createdByKey: Map<string, string>,
  byKey: Map<string, BulkImportExistingRow>
): Promise<{ patronId?: string | null }> {
  if (entry.kind !== "blessings") return {}
  const config = entry.config as Record<string, unknown>
  const stableId = config.patronGodStableId
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { patronId: null }
  }
  const key = keyOf("gods", stableId)
  const createdId = createdByKey.get(key)
  if (createdId != null) return { patronId: createdId }
  const god = byKey.get(key)
  return { patronId: god ? god.id : null }
}

// ------------------------------------------------------------------ //
// Preview / apply
// ------------------------------------------------------------------ //

function computeStatuses(
  entries: readonly BulkCatalogEntry[],
  byKey: Map<string, BulkImportExistingRow>
): Array<"create" | "skip_existing"> {
  return entries.map((entry) =>
    byKey.has(keyOf(entry.kind, entry.stableId)) ? "skip_existing" : "create"
  )
}

function collectWouldCreateGodKeys(
  entries: readonly BulkCatalogEntry[],
  statuses: ReadonlyArray<"create" | "skip_existing">
): Set<string> {
  const keys = new Set<string>()
  entries.forEach((entry, i) => {
    if (entry.kind === "gods" && statuses[i] === "create") {
      keys.add(keyOf("gods", entry.stableId))
    }
  })
  return keys
}

function validateCreateBlessingPatrons(
  entries: readonly BulkCatalogEntry[],
  statuses: ReadonlyArray<"create" | "skip_existing">,
  byKey: Map<string, BulkImportExistingRow>,
  wouldCreateGodKeys: Set<string>
): void {
  entries.forEach((entry, i) => {
    if (entry.kind !== "blessings" || statuses[i] !== "create") return
    const config = entry.config as Record<string, unknown>
    const godStableId = config.patronGodStableId
    if (typeof godStableId !== "string" || godStableId.length === 0) return
    assertBulkPatronGod(byKey, wouldCreateGodKeys, godStableId, entry.row)
  })
}

/**
 * Compute the import against the live database without mutating anything. The
 * returned per-entry status is `create` (no row occupies that (kind, stableId)
 * yet) or `skip_existing` (a row already occupies the key, so it is never
 * overwritten). Would-create blessings' patron gods are validated here.
 */
export async function previewBulkImport(
  entries: readonly BulkCatalogEntry[],
  previewDigest: string
): Promise<BulkImportResult> {
  const rows = await prisma.catalogDefinition.findMany({})
  const byKey = new Map<string, BulkImportExistingRow>(
    rows.map((row) => [keyOf(row.kind, row.stableId), toExistingRow(row)])
  )
  const statuses = computeStatuses(entries, byKey)
  const wouldCreateGodKeys = collectWouldCreateGodKeys(entries, statuses)
  validateCreateBlessingPatrons(entries, statuses, byKey, wouldCreateGodKeys)

  let createCount = 0
  let skipCount = 0
  const resultEntries: BulkImportEntryPreview[] = entries.map((entry) => {
    const existingRow = byKey.get(keyOf(entry.kind, entry.stableId))
    const exists = existingRow !== undefined
    if (exists) skipCount++
    else createCount++
    return {
      row: entry.row,
      kind: entry.kind,
      stableId: entry.stableId,
      name: entry.name,
      sourceUrl: entry.sourceUrl,
      status: exists ? "skip_existing" : "create",
      ...(exists && existingRow
        ? { existing: toExistingRow(existingRow) }
        : {}),
    }
  })

  return {
    source: "bulk",
    previewDigest,
    entries: resultEntries,
    createCount,
    skipCount,
  }
}

/**
 * Apply the upload: validate every entry, then create every MISSING row in ONE
 * SERIALIZABLE transaction, re-checking existence inside the transaction. Gods
 * are created first, then all other kinds, so a blessing that names a god created
 * by the same upload can resolve its patron FK regardless of row order. Existing
 * rows are never touched. On a P2002 / P2034 conflict from a concurrent import
 * the whole transaction is rolled back and a 409 is returned; the next retry is
 * idempotent.
 */
export async function applyBulkImport(
  entries: readonly BulkCatalogEntry[],
  previewDigest: string
): Promise<BulkApplyResult> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = await tx.catalogDefinition.findMany({})
        const byKey = new Map<string, BulkImportExistingRow>(
          rows.map((row) => [keyOf(row.kind, row.stableId), toExistingRow(row)])
        )
        const statuses = computeStatuses(entries, byKey)
        const wouldCreateGodKeys = collectWouldCreateGodKeys(entries, statuses)
        // Revalidate patrons before any write so a failure rolls back nothing.
        validateCreateBlessingPatrons(
          entries,
          statuses,
          byKey,
          wouldCreateGodKeys
        )

        const creationOrder = entries
          .map((entry, index) => ({ entry, index }))
          .filter((item) => statuses[item.index] === "create")
        // Gods first (so a blessing patron FK can resolve against a batch-created
        // god), then every other kind.
        creationOrder.sort((a, b) => {
          const ag = a.entry.kind === "gods" ? 0 : 1
          const bg = b.entry.kind === "gods" ? 0 : 1
          return ag - bg
        })

        const createdByKey = new Map<string, string>()
        const createdIds: string[] = []
        for (const { entry } of creationOrder) {
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
              ...(await blessingPatronData(tx, entry, createdByKey, byKey)),
            },
          })
          createdByKey.set(keyOf(entry.kind, entry.stableId), row.id)
          createdIds.push(row.id)
        }

        let createCount = 0
        let skipCount = 0
        const resultEntries: BulkImportEntryPreview[] = []
        entries.forEach((entry, i) => {
          if (statuses[i] === "create") {
            createCount++
            resultEntries.push({
              row: entry.row,
              kind: entry.kind,
              stableId: entry.stableId,
              name: entry.name,
              sourceUrl: entry.sourceUrl,
              status: "create",
            })
          } else {
            skipCount++
            const existing = byKey.get(keyOf(entry.kind, entry.stableId))!
            resultEntries.push({
              row: entry.row,
              kind: entry.kind,
              stableId: entry.stableId,
              name: entry.name,
              sourceUrl: entry.sourceUrl,
              status: "skip_existing",
              existing: toExistingRow(existing),
            })
          }
        })

        return {
          source: "bulk" as const,
          previewDigest,
          entries: resultEntries,
          createCount,
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
