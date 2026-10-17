/**
 * Local stdio MCP server for the deployed app's managed catalog.
 *
 * This process is launched by an OpenCode local MCP client. It reads ONLY
 * environment variables (no database credentials) and talks to the fixed
 * `/api/mcp/catalog` publisher routes on a deployed HTTPS origin. There is no
 * arbitrary HTTP fetch and no direct database access: the target origin and the
 * bearer token are the only inputs, and they come from the environment, not
 * from a tool argument.
 *
 * Security posture:
 *  - `PRIMAL_CATALOG_URL` must be an HTTPS origin (no path, query, hash or
 *    userinfo) and `PRIMAL_CATALOG_TOKEN` must be a base64url secret of 43..256
 *    chars. A misconfigured server FAILS CLOSED: every tool returns an error
 *    result, and the diagnostics go to STDERR only (stdout is the MCP protocol
 *    channel, so nothing is ever logged there).
 *  - The raw token never appears in a chat/log message or a tool result: it is
 *    only used in the `Authorization: Bearer <token>` header.
 *
 * The endpoints are fixed:
 *  - GET  /api/mcp/catalog          list catalog entry summaries (kind REQUIRED, includeArchived)
 *  - GET  /api/mcp/catalog/entry    read one FULL entry (kind REQUIRED, stableId REQUIRED)
 *  - POST /api/mcp/catalog/preview  `{ entries }` -> changes + previewTicket
 *  - POST /api/mcp/catalog/apply    `{ entries, previewTicket }` -> changes
 *
 * Runtime contract:
 *  - `redirect: "error"` (never follow a cross-origin redirect)
 *  - requests time out in 15-30s, responses are bounded in size, and JSON is
 *    parsed with safe error messages that never echo a secret.
 *
 * No `@/` alias imports here: this file runs under `tsx` on its own and must
 * not depend on a path alias or any Next.js runtime. Everything it needs is a
 * node built-in, `@modelcontextprotocol/server`, and `zod/v4`.
 */

import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"
import { pathToFileURL } from "node:url"

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

/** The canonical catalog kinds (mirrors `catalogKindSchema`; no `consumables` alias). */
export const CATALOG_KINDS = [
  "races",
  "classes",
  "professions",
  "titles",
  "equipment",
  "skills",
  "bloodlines",
  "items",
  "gods",
  "transcendent_skills",
  "currencies",
] as const

export type CatalogKind = (typeof CATALOG_KINDS)[number]

/** Narrow a runtime value to a `CatalogKind`, or return false. */
export function isCatalogKind(value: unknown): value is CatalogKind {
  return (
    typeof value === "string" &&
    (CATALOG_KINDS as readonly string[]).includes(value)
  )
}

/** Maximum number of entries a managed batch may carry (server-enforced). */
export const MAX_ENTRIES = 50

/** Minimum base64url token length (256-bit secret). */
export const MIN_TOKEN_LENGTH = 43
/** Maximum base64url token length accepted by the server. */
export const MAX_TOKEN_LENGTH = 256

/** Default per-request timeout (within the 15-30s window). */
export const DEFAULT_TIMEOUT_MS = 20_000
/** Apply is the write path; give it the longer end of the window. */
export const APPLY_TIMEOUT_MS = 30_000

/** Bound on the size of a single API response body. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

// Fixed API paths.
export const CATALOG_LIST_PATH = "/api/mcp/catalog"
export const CATALOG_ENTRY_PATH = "/api/mcp/catalog/entry"
export const CATALOG_PREVIEW_PATH = "/api/mcp/catalog/preview"
export const CATALOG_APPLY_PATH = "/api/mcp/catalog/apply"

/** Upper bound on the `stableId` tool input (mirrors the server's 128-char cap). */
export const MAX_STABLE_ID_LENGTH = 128

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

// ------------------------------------------------------------------ //
// Entry schema (tool input + server validation)
// ------------------------------------------------------------------ //

/**
 * A single managed catalog entry. STRICT: only these keys are accepted, so a
 * typo (or an unsupported `archived` flag) is rejected client-side before the
 * server is even called. This mirrors the server's `managedCatalogEntrySchema`.
 */
export const catalogEntrySchema = z
  .object({
    kind: z.enum(CATALOG_KINDS),
    stableId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    grade: z
      .enum(["G", "F", "E", "D", "C", "B", "A", "S"])
      .nullable()
      .optional(),
    sourceUrl: z
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
      .nullable()
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    gradeDescriptions: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export type CatalogEntry = z.infer<typeof catalogEntrySchema>

export const catalogEntryListSchema = z
  .array(catalogEntrySchema)
  .max(MAX_ENTRIES)

// ------------------------------------------------------------------ //
// Configuration resolution (fail closed)
// ------------------------------------------------------------------ //

export type UrlValidation =
  { ok: true; origin: string } | { ok: false; error: string }

/**
 * Validate `PRIMAL_CATALOG_URL`: it must parse and be an HTTPS origin only - no
 * path, no query string, no fragment, and no userinfo. The returned origin is
 * what every request is built against; a value that is not exactly an origin is
 * rejected because the publisher routes are fixed relative to it.
 */
export function validateCatalogUrl(raw: string): UrlValidation {
  if (raw == null || raw === "") {
    return { ok: false, error: "PRIMAL_CATALOG_URL must be set" }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "PRIMAL_CATALOG_URL is not a valid URL" }
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "PRIMAL_CATALOG_URL must be an HTTPS origin (got a non-https URL)",
    }
  }
  if (url.host === "") {
    return { ok: false, error: "PRIMAL_CATALOG_URL has no host" }
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      error: "PRIMAL_CATALOG_URL may not carry userinfo",
    }
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return {
      ok: false,
      error: "PRIMAL_CATALOG_URL must be an origin only (no path)",
    }
  }
  if (url.search !== "") {
    return {
      ok: false,
      error: "PRIMAL_CATALOG_URL must be an origin only (no query string)",
    }
  }
  if (url.hash !== "") {
    return {
      ok: false,
      error: "PRIMAL_CATALOG_URL must be an origin only (no fragment)",
    }
  }
  return { ok: true, origin: url.origin }
}

export type TokenValidation = { ok: true } | { ok: false; error: string }

/**
 * Validate `PRIMAL_CATALOG_TOKEN`: a base64url secret between 43 and 256 chars.
 * The server hashes this exact raw value (sha256) and compares it in constant
 * time against `MCP_CATALOG_TOKEN_SHA256`, so the raw value must be the same
 * byte-for-byte value the hash was derived from.
 */
export function validateBearerToken(token: string): TokenValidation {
  if (token == null || token === "") {
    return { ok: false, error: "PRIMAL_CATALOG_TOKEN must be set" }
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      error: `PRIMAL_CATALOG_TOKEN is too short (${token.length} chars; need at least ${MIN_TOKEN_LENGTH})`,
    }
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      error: `PRIMAL_CATALOG_TOKEN is too long (${token.length} chars; at most ${MAX_TOKEN_LENGTH})`,
    }
  }
  if (!BASE64URL_PATTERN.test(token)) {
    return {
      ok: false,
      error:
        "PRIMAL_CATALOG_TOKEN must be a base64url string (A-Z a-z 0-9 _ -)",
    }
  }
  return { ok: true }
}

export type ConfigResult =
  { ok: true; url: string; token: string } | { ok: false; error: string }

/**
 * Resolve and validate the MCP configuration from the environment. The token is
 * never echoed in an error message - only the variable names and a length
 * figure ever appear, so a secret can never leak into a chat, log or tool
 * result.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env
): ConfigResult {
  const rawUrl = env.PRIMAL_CATALOG_URL
  const token = env.PRIMAL_CATALOG_TOKEN

  if (rawUrl == null || rawUrl === "") {
    return { ok: false, error: "PRIMAL_CATALOG_URL is not set" }
  }
  if (token == null || token === "") {
    return { ok: false, error: "PRIMAL_CATALOG_TOKEN is not set" }
  }

  const urlRes = validateCatalogUrl(rawUrl)
  if (!urlRes.ok) return { ok: false, error: urlRes.error }

  const tokenRes = validateBearerToken(token)
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error }

  return { ok: true, url: urlRes.origin, token }
}

// ------------------------------------------------------------------ //
// API client
// ------------------------------------------------------------------ //

/** An API error carrying an HTTP status and an optional server error code. */
export class CatalogApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = "CatalogApiError"
    this.status = status
    this.code = code
  }
}

export interface CatalogClient {
  readonly baseUrl: string
  readonly token: string
  readonly fetchImpl: typeof fetch
  readonly timeoutMs: number
}

export function createClient(
  config: { url: string; token: string },
  deps: { fetchImpl?: typeof fetch } = {}
): CatalogClient {
  return {
    baseUrl: config.url,
    token: config.token,
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
}

interface RequestOptions {
  method: "GET" | "POST"
  body?: unknown
  timeoutMs?: number
}

/**
 * Perform the HTTP request with a hard timeout, `redirect: "error"` (no
 * cross-origin redirects), and a bounded body read. Returns the status and the
 * raw text; never throws for a non-2xx status here - the caller decides.
 */
async function requestText(
  client: CatalogClient,
  path: string,
  opts: RequestOptions
): Promise<{ status: number; text: string }> {
  const url = `${client.baseUrl}${path}`
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${client.token}`,
  }
  let body: string | undefined
  if (opts.method === "POST") {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await client.fetchImpl(url, {
      method: opts.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? client.timeoutMs),
    })
  } catch (err) {
    throw new CatalogApiError(requestFailureMessage(err), 0)
  }

  const text = await readBodyCapped(res, MAX_RESPONSE_BYTES)
  return { status: res.status, text }
}

function requestFailureMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name
    if (name === "TimeoutError" || name === "AbortError") {
      return "Request to the catalog timed out"
    }
  }
  return "Request to the catalog failed"
}

/**
 * Read a response body, bounded to `maxBytes`. A declared `Content-Length`
 * larger than the cap is rejected immediately; a stream that grows past the cap
 * is cancelled and rejected so the process never buffers an unbounded body.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<string> {
  const declared = res.headers.get("content-length")
  if (declared != null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new CatalogApiError(
        `Catalog response exceeds the ${maxBytes} byte cap`,
        res.status
      )
    }
  }
  if (res.body == null) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new CatalogApiError(
        `Catalog response exceeds the ${maxBytes} byte cap`,
        res.status
      )
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function parseJsonSafely(
  text: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: "Response was not valid JSON" }
  }
}

function extractError(data: unknown): {
  code: string | null
  message: string | null
} {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as { error?: unknown }).error
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const e = err as { code?: unknown; message?: unknown }
      const code = typeof e.code === "string" ? e.code : null
      const message = typeof e.message === "string" ? e.message : null
      return { code, message }
    }
  }
  return { code: null, message: null }
}

/**
 * Send a request and return the parsed JSON body on 2xx. A non-2xx response is
 * turned into a `CatalogApiError` whose message is derived from the server's
 * `{ error: { code, message } }` payload (never from a secret) with a safe
 * fallback.
 */
async function sendJson(
  client: CatalogClient,
  path: string,
  opts: RequestOptions
): Promise<unknown> {
  const { status, text } = await requestText(client, path, opts)
  const parsed = parseJsonSafely(text)
  if (!parsed.ok) {
    throw new CatalogApiError("Catalog returned a non-JSON response", status)
  }
  if (status >= 200 && status < 300) return parsed.value
  const info = extractError(parsed.value)
  const message = info.message ?? `Catalog returned HTTP ${status}`
  throw new CatalogApiError(message, status, info.code)
}

// ------------------------------------------------------------------ //
// Result shapes
// ------------------------------------------------------------------ //

export interface CatalogListItem {
  kind: string
  stableId: string
  name: string
  grade: string | null
  sourceUrl: string | null
  archived: boolean
}

export interface CatalogListResult {
  kind: CatalogKind
  includeArchived: boolean
  items: CatalogListItem[]
}

/**
 * The substantive (non-generated) fields of a single FULL catalog entry, as read
 * by the fixed detail endpoint. Generated database identifiers and timestamps
 * (`id`, `createdAt`, `updatedAt`) are deliberately NOT part of this shape: they
 * are not authored content and are not promised as a stable read value.
 */
export interface CatalogEntryDetail {
  kind: string
  stableId: string
  name: string
  description: string | null
  grade: string | null
  sourceUrl: string | null
  archived: boolean
  config: Record<string, unknown>
  gradeDescriptions: Record<string, string>
}

export interface CatalogEntryResult {
  kind: CatalogKind
  entry: CatalogEntryDetail
}

/**
 * The substantive (non-generated) fields a change may report. Server-generated
 * identifiers (`id`, `createdAt`, `updatedAt`) are deliberately NOT part of this
 * shape: they are created by the database during preview/apply and are not
 * promised as an exact preview value.
 */
export interface CatalogChangeFields {
  name?: string
  description?: string | null
  grade?: string | null
  sourceUrl?: string | null
  archived?: boolean
  config?: Record<string, unknown>
  gradeDescriptions?: Record<string, string>
}

export interface CatalogChange {
  kind: string
  stableId: string
  status: "create" | "update" | "unchanged"
  changedFields: string[]
  before?: CatalogChangeFields
  after: CatalogChangeFields
}

export interface CatalogPreviewResult {
  changes: CatalogChange[]
  payloadDigest: string
  stateDigest: string
  previewTicket: string
}

export interface CatalogApplyResult {
  changes: CatalogChange[]
  payloadDigest: string
  stateDigest: string
}

const catalogChangeFieldsSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  grade: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  gradeDescriptions: z.record(z.string(), z.string()).optional(),
})

const changeSchema = z.object({
  kind: z.string(),
  stableId: z.string(),
  status: z.enum(["create", "update", "unchanged"]),
  changedFields: z.array(z.string()),
  before: catalogChangeFieldsSchema.optional(),
  after: catalogChangeFieldsSchema,
})

const previewResultSchema = z.object({
  changes: z.array(changeSchema),
  payloadDigest: z.string(),
  stateDigest: z.string(),
  previewTicket: z.string(),
})

const applyResultSchema = z.object({
  changes: z.array(changeSchema),
  payloadDigest: z.string(),
  stateDigest: z.string(),
})

const catalogListItemSchema = z.object({
  kind: z.string(),
  stableId: z.string(),
  name: z.string(),
  grade: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  archived: z.boolean().optional(),
})

/**
 * A single FULL catalog entry as returned by the detail endpoint. Non-strict on
 * purpose: the server also sends generated `id`, `createdAt` and `updatedAt`
 * which the entry detail deliberately drops (they are not authored content).
 */
const catalogItemSchema = z.object({
  kind: z.string(),
  stableId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  grade: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  gradeDescriptions: z.record(z.string(), z.string()).optional(),
})

// ------------------------------------------------------------------ //
// Endpoint functions
// ------------------------------------------------------------------ //

function normalizeCatalogList(data: unknown): CatalogListItem[] {
  const obj = data as { entries?: unknown; items?: unknown } | null
  const raw = Array.isArray(data) ? data : (obj?.entries ?? obj?.items)
  if (!Array.isArray(raw)) {
    throw new CatalogApiError(
      "Catalog list response is not an array of entries",
      0
    )
  }
  return raw.map((item) => {
    const parsed = catalogListItemSchema.safeParse(item)
    if (!parsed.success) {
      throw new CatalogApiError("Catalog list entry has an unexpected shape", 0)
    }
    const d = parsed.data
    return {
      kind: d.kind,
      stableId: d.stableId,
      name: d.name,
      grade: d.grade ?? null,
      sourceUrl: d.sourceUrl ?? null,
      archived: d.archived ?? false,
    }
  })
}

function normalizeCatalogEntry(data: unknown): CatalogEntryDetail {
  const obj = data as { item?: unknown } | null
  if (obj == null || typeof obj !== "object" || !("item" in obj)) {
    throw new CatalogApiError("Catalog entry response is missing `item`", 0)
  }
  const parsed = catalogItemSchema.safeParse(obj.item)
  if (!parsed.success) {
    throw new CatalogApiError("Catalog entry has an unexpected shape", 0)
  }
  const d = parsed.data
  return {
    kind: d.kind,
    stableId: d.stableId,
    name: d.name,
    description: d.description ?? null,
    grade: d.grade ?? null,
    sourceUrl: d.sourceUrl ?? null,
    archived: d.archived ?? false,
    config: d.config ?? {},
    gradeDescriptions: d.gradeDescriptions ?? {},
  }
}

/**
 * List catalog entries. `kind` is REQUIRED (the GET route rejects a request
 * without a canonical kind), so a missing kind is rejected locally BEFORE any
 * network call. `includeArchived` defaults to false.
 */
export async function catalogList(
  client: CatalogClient,
  opts: { kind: CatalogKind; includeArchived?: boolean }
): Promise<CatalogListResult> {
  if (!isCatalogKind(opts.kind)) {
    throw new CatalogApiError(
      `catalog_list requires a valid kind (got "${String(opts.kind)}")`,
      0
    )
  }
  const params: string[] = [`kind=${encodeURIComponent(opts.kind)}`]
  if (opts.includeArchived) params.push("includeArchived=1")
  const path = `${CATALOG_LIST_PATH}?${params.join("&")}`
  const data = await sendJson(client, path, { method: "GET" })
  return {
    kind: opts.kind,
    includeArchived: opts.includeArchived ?? false,
    items: normalizeCatalogList(data),
  }
}

/**
 * Read ONE full catalog entry by its `(kind, stableId)` key. Both `kind` and
 * `stableId` are REQUIRED (the GET route rejects a request without a canonical
 * kind or a nonempty stableId), so a missing/invalid value is rejected locally
 * BEFORE any network call. `stableId` must be 1..128 chars. The result carries
 * the full authored content (description, config, gradeDescriptions, grade,
 * sourceUrl, archived, name); generated ids/timestamps are omitted.
 */
export async function catalogGet(
  client: CatalogClient,
  opts: { kind: CatalogKind; stableId: string }
): Promise<CatalogEntryResult> {
  if (!isCatalogKind(opts.kind)) {
    throw new CatalogApiError(
      `catalog_get requires a valid kind (got "${String(opts.kind)}")`,
      0
    )
  }
  if (typeof opts.stableId !== "string" || opts.stableId.length === 0) {
    throw new CatalogApiError("catalog_get requires a nonempty stableId", 0)
  }
  if (opts.stableId.length > MAX_STABLE_ID_LENGTH) {
    throw new CatalogApiError(
      `catalog_get requires a stableId of at most ${MAX_STABLE_ID_LENGTH} characters`,
      0
    )
  }
  const params = [
    `kind=${encodeURIComponent(opts.kind)}`,
    `stableId=${encodeURIComponent(opts.stableId)}`,
  ]
  const path = `${CATALOG_ENTRY_PATH}?${params.join("&")}`
  const data = await sendJson(client, path, { method: "GET" })
  return {
    kind: opts.kind,
    entry: normalizeCatalogEntry(data),
  }
}

/** Preview a managed batch without applying it. */
export async function catalogPreview(
  client: CatalogClient,
  entries: readonly CatalogEntry[]
): Promise<CatalogPreviewResult> {
  const data = await sendJson(client, CATALOG_PREVIEW_PATH, {
    method: "POST",
    body: { entries },
  })
  const parsed = previewResultSchema.safeParse(data)
  if (!parsed.success) {
    throw new CatalogApiError("Catalog preview response is malformed", 0)
  }
  return parsed.data
}

/** Apply a managed batch against a prior preview ticket. */
export async function catalogApply(
  client: CatalogClient,
  entries: readonly CatalogEntry[],
  previewTicket: string
): Promise<CatalogApplyResult> {
  const data = await sendJson(client, CATALOG_APPLY_PATH, {
    method: "POST",
    body: { entries, previewTicket },
    timeoutMs: APPLY_TIMEOUT_MS,
  })
  const parsed = applyResultSchema.safeParse(data)
  if (!parsed.success) {
    throw new CatalogApiError("Catalog apply response is malformed", 0)
  }
  return parsed.data
}

/**
 * Publish a managed batch: preview (to obtain a content-bound ticket), then
 * apply automatically with no interactive confirmation. A 409 (concurrent
 * catalog change, expired/stale ticket, or an archived conflict) is surfaced to
 * the caller as a retry.
 */
export async function catalogPublish(
  client: CatalogClient,
  entries: readonly CatalogEntry[]
): Promise<{ preview: CatalogPreviewResult; apply: CatalogApplyResult }> {
  const preview = await catalogPreview(client, entries)
  const apply = await catalogApply(client, entries, preview.previewTicket)
  return { preview, apply }
}

// ------------------------------------------------------------------ //
// Rendering (text for the MCP tool result)
// ------------------------------------------------------------------ //

/** Bound on the rendered length of a single scalar field value. */
const MAX_RENDER_VALUE_CHARS = 160
/** Bound on the rendered length of a config / gradeDescriptions value. */
const MAX_RENDER_CONFIG_CHARS = 400

/**
 * Render a single value into a bounded, single-line string for the SUMMARY
 * / PREVIEW / PUBLISH paths. Whitespace (including newlines) is collapsed to a
 * single space so a long description cannot blow up the tool result; values
 * longer than `maxChars` are truncated and the suffix is EXPLICITLY marked
 * `[truncated]` (never a bare `...`) so an agent knows the value was cut. This is
 * intentionally lossy: it is not the source of truth for a field you are about
 * to replace. `undefined` means a field that is absent in the source (e.g. a
 * create has no `before`), rendered as "(absent)".
 */
function boundValue(value: unknown, maxChars: number): string {
  if (value === undefined) return "(absent)"
  if (value === null) return "null"
  let text = typeof value === "string" ? value : JSON.stringify(value)
  text = text.replace(/\s+/g, " ").trim()
  if (text.length > maxChars) return `${text.slice(0, maxChars)}[truncated]`
  return text.length === 0 ? '""' : text
}

function fieldValue(
  fields: CatalogChangeFields | undefined,
  field: string
): unknown {
  if (fields == null) return undefined
  return (fields as Record<string, unknown>)[field]
}

function maxCharsForField(field: string): number {
  return field === "config" || field === "gradeDescriptions"
    ? MAX_RENDER_CONFIG_CHARS
    : MAX_RENDER_VALUE_CHARS
}

function formatFieldChange(
  field: string,
  before: unknown,
  after: unknown
): string {
  return `    ${field}: ${boundValue(before, maxCharsForField(field))} -> ${boundValue(after, maxCharsForField(field))}`
}

function changeLabel(c: CatalogChange): string {
  return `${c.status}  ${c.kind}/${c.stableId}`
}

function formatChange(c: CatalogChange): string {
  const name = c.after?.name ? `  "${c.after.name}"` : ""
  const lines = [`- ${changeLabel(c)}${name}`]
  if (c.changedFields.length === 0) return lines[0]
  for (const field of c.changedFields) {
    lines.push(
      formatFieldChange(
        field,
        fieldValue(c.before, field),
        fieldValue(c.after, field)
      )
    )
  }
  return lines.join("\n")
}

function formatChanges(changes: readonly CatalogChange[]): string {
  if (changes.length === 0) return "  (no changes)"
  return changes.map(formatChange).join("\n")
}

/**
 * Render the COMPLETE content of a `catalog_get` read. This is the read path an
 * agent uses before replacing an existing entry's `config`/`gradeDescriptions`/
 * `description`, so it MUST carry the full authored content and nothing may be
 * lost: `config` and `gradeDescriptions` are JSON-stringified (escaping
 * preserved) and `description` is emitted verbatim (whitespace preserved), none
 * of them collapsed or truncated. The module caps config JSON at 64 KiB and
 * description at 8000 chars, far below the 8 MiB response bound, so no truncation
 * marker is ever used here - a value you read is the exact value you can replace.
 * `renderCatalogEntry` is exported for tests.
 */
export function renderCatalogEntry(result: CatalogEntryResult): string {
  const e = result.entry
  const lines = [
    `Entry: ${e.kind}/${e.stableId}`,
    `name: ${e.name}`,
    `grade: ${e.grade ?? "null"}`,
    `archived: ${e.archived ? "true" : "false"}`,
    `sourceUrl: ${e.sourceUrl ?? "null"}`,
    `description: ${e.description ?? "null"}`,
    `config: ${JSON.stringify(e.config)}`,
    `gradeDescriptions: ${JSON.stringify(e.gradeDescriptions)}`,
  ]
  return lines.join("\n")
}

function renderCatalogList(result: CatalogListResult): string {
  const header = `kind=${result.kind} includeArchived=${result.includeArchived ? "true" : "false"}`
  if (result.items.length === 0) {
    return `Catalog entries (${header}): none`
  }
  const lines = [`Catalog entries (${header}): ${result.items.length}`]
  for (const item of result.items) {
    const grade = item.grade ?? "null"
    const archived = item.archived ? "true" : "false"
    const source = item.sourceUrl ? `  source=${item.sourceUrl}` : ""
    lines.push(
      `- ${item.kind}/${item.stableId}  ${item.name}  grade=${grade}  archived=${archived}${source}`
    )
  }
  return lines.join("\n")
}

/**
 * Render a preview result for the agent. Field values are bounded (see
 * `boundValue`); a value that was cut carries an explicit `[truncated]` suffix so
 * the agent knows it is NOT the exact stored value and must not be used as-is for
 * a read-and-replace. Exported for tests.
 */
export function renderPreviewResult(result: CatalogPreviewResult): string {
  const lines = [
    `Entries: ${result.changes.length}`,
    "Each changed field shows before -> after (generated ids/timestamps omitted):",
  ]
  lines.push(formatChanges(result.changes))
  const ticket =
    result.previewTicket.length > 24
      ? `${result.previewTicket.slice(0, 24)}[truncated]`
      : result.previewTicket
  lines.push(`Preview ticket: ${ticket}`)
  lines.push(
    `payload=${result.payloadDigest.slice(0, 12)} state=${result.stateDigest.slice(0, 12)}`
  )
  return lines.join("\n")
}

function renderPublishResult(
  client: CatalogClient,
  result: { preview: CatalogPreviewResult; apply: CatalogApplyResult }
): string {
  const lines = [`Target: ${client.baseUrl}`]
  lines.push("Preview (field-level before -> after, ids/timestamps omitted):")
  lines.push(`Entries: ${result.preview.changes.length}`)
  lines.push(formatChanges(result.preview.changes))
  lines.push("Apply (resulting status and field changes):")
  lines.push(`Status: applied (${result.apply.changes.length} entries)`)
  lines.push(formatChanges(result.apply.changes))
  lines.push(
    `payload=${result.apply.payloadDigest.slice(0, 12)} state=${result.apply.stateDigest.slice(0, 12)}`
  )
  return lines.join("\n")
}

// ------------------------------------------------------------------ //
// MCP tool wiring
// ------------------------------------------------------------------ //

type TextContent = Array<{ type: "text"; text: string }>

function textResult(text: string): { content: TextContent } {
  return { content: [{ type: "text", text }] }
}

function errorResult(text: string): { content: TextContent; isError: true } {
  return { content: [{ type: "text", text }], isError: true }
}

function describeError(err: unknown): string {
  if (err instanceof CatalogApiError) return err.message
  if (err instanceof Error) return err.message
  return "Unknown error"
}

/**
 * Human-readable message for a 409 from the apply step. The catalog state
 * changed between the internal preview and the apply (or the preview ticket
 * expired/was not bound): the publisher must re-preview and retry. The raw
 * secret is never part of this message.
 */
export function publishConflictMessage(err: CatalogApiError): string {
  const code = err.code ? ` (${err.code})` : ""
  return `Publish not applied: the catalog changed since preview - HTTP 409${code}; re-preview and retry. ${err.message}`
}

export interface CatalogServerDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

/**
 * Build the MCP server. The config is resolved from the environment (or the
 * injected `deps.env` in tests); when it is invalid the tools still register but
 * every call returns an error result, so the server fails closed instead of
 * silently succeeding with nothing.
 */
export function createServer(deps: CatalogServerDeps = {}): McpServer {
  const server = new McpServer({ name: "primal-catalog", version: "0.1.0" })

  const config = resolveConfig(deps.env ?? process.env)
  const configError = config.ok ? null : config.error
  const client = config.ok
    ? createClient(
        { url: config.url, token: config.token },
        {
          fetchImpl: deps.fetchImpl,
        }
      )
    : null

  server.registerTool(
    "catalog_list",
    {
      description:
        "List catalog entries from the deployed app's managed catalog for a required kind. Optionally include archived entries (which requires the publisher token to have the includeArchived flag).",
      inputSchema: z.object({
        kind: z
          .enum(CATALOG_KINDS)
          .describe(
            "Catalog kind to list (required; the GET route requires a canonical kind)"
          ),
        includeArchived: z
          .boolean()
          .default(false)
          .describe("Include archived catalog entries"),
      }),
    },
    async ({ kind, includeArchived }) => {
      if (configError) return errorResult(configError)
      try {
        const result = await catalogList(client!, { kind, includeArchived })
        return textResult(renderCatalogList(result))
      } catch (err) {
        return errorResult(describeError(err))
      }
    }
  )

  server.registerTool(
    "catalog_get",
    {
      description:
        "Read ONE full catalog entry from the deployed app's managed catalog by its required (kind, stableId) key. Returns the complete authored content UNTRUNCATED: config and gradeDescriptions are JSON-stringified (escaping preserved) and description is returned in full (whitespace preserved); generated ids/timestamps are omitted. Read-only. Call this before updating an existing entry so you can read the exact current config and retain its other config fields when replacing config instead of fabricating them.",
      inputSchema: z.object({
        kind: z
          .enum(CATALOG_KINDS)
          .describe(
            "Catalog kind to read (required; the GET route requires a canonical kind)"
          ),
        stableId: z
          .string()
          .min(1)
          .max(MAX_STABLE_ID_LENGTH)
          .describe(
            "Stable identifier of the entry to read (1-128 chars; required)"
          ),
      }),
    },
    async ({ kind, stableId }) => {
      if (configError) return errorResult(configError)
      try {
        const result = await catalogGet(client!, { kind, stableId })
        return textResult(renderCatalogEntry(result))
      } catch (err) {
        return errorResult(describeError(err))
      }
    }
  )

  server.registerTool(
    "catalog_preview",
    {
      description:
        "Validate and preview a batch of managed catalog entries against the live catalog without applying them. Returns per-entry create/update/unchanged status, the changed fields with bounded before -> after values (generated ids/timestamps omitted), and a short-lived preview ticket.",
      inputSchema: z.object({
        entries: catalogEntryListSchema.describe(
          "Catalog entries to preview (at most 50)"
        ),
      }),
    },
    async ({ entries }) => {
      if (configError) return errorResult(configError)
      try {
        const result = await catalogPreview(client!, entries)
        return textResult(renderPreviewResult(result))
      } catch (err) {
        return errorResult(describeError(err))
      }
    }
  )

  server.registerTool(
    "catalog_publish",
    {
      description:
        "Validate, preview and apply a batch of managed catalog entries to the deployed app's catalog. Internally previews to obtain a content-bound ticket, then applies automatically with no interactive confirmation. Reports the field-level before -> after values, the per-entry create/update/unchanged status, the changed fields, and the target URL/status, so the automatic edits are observable. A 409 (concurrent change or stale preview) surfaces a retry.",
      inputSchema: z.object({
        entries: catalogEntryListSchema.describe(
          "Catalog entries to publish (at most 50)"
        ),
      }),
    },
    async ({ entries }) => {
      if (configError) return errorResult(configError)
      try {
        const result = await catalogPublish(client!, entries)
        return textResult(renderPublishResult(client!, result))
      } catch (err) {
        if (err instanceof CatalogApiError && err.status === 409) {
          return errorResult(publishConflictMessage(err))
        }
        return errorResult(describeError(err))
      }
    }
  )

  return server
}

// ------------------------------------------------------------------ //
// Entry point
// ------------------------------------------------------------------ //

function isRunningAsMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isRunningAsMain()) {
  const config = resolveConfig()
  if (!config.ok) {
    // Diagnostics go to STDERR only; stdout is the MCP protocol channel.
    console.error(`[primal-catalog] configuration problem: ${config.error}`)
  } else {
    console.error(`[primal-catalog] serving stdio against ${config.url}`)
  }
  void serveStdio(() => createServer())
}
