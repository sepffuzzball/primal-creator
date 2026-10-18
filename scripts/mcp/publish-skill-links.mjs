/**
 * Guarded post-deployment publisher for the committed skill upgrade-link plan.
 *
 * This script replays the DIRECT rarity-adjacent upgrade edges recorded in
 * `docs/catalog/skill-upgrade-link-plan.json` against the SAME authenticated MCP
 * catalog HTTP preview/apply endpoints used by the local MCP server
 * (`scripts/mcp/catalog-server.ts`). It is deliberately read-only by default: it
 * fetches the list + full records, validates the plan, previews the batch and
 * prints a summary, but NEVER applies. Applying requires an explicit opt-in:
 *
 *   pnpm mcp:publish-skill-links -- --execute --confirm 'PUBLISH 32 SKILL LINKS'
 *
 * Guardrails:
 *  - The origin must be an HTTPS origin (no path/query/hash/userinfo) taken from
 *    `PRIMAL_CATALOG_URL` or the documented default; the bearer comes from
 *    `PRIMAL_CATALOG_TOKEN`. Neither is ever echoed; errors are sanitized.
 *  - Validation: every source/target name, rarity and id must resolve against the
 *    live catalog; every edge must be rarity-adjacent (ladder index diff 1) and
 *    same-track; sources/targets must be active; every listed skill grade must be
 *    null and its gradeDescriptions empty (the skill-grade-removal migration is
 *    deployed); an existing explicit `upgradeToStableIds` that differs from the
 *    plan fails rather than being overwritten.
 *  - A source's config is a FULL replacement: carry every existing config field and
 *    change ONLY `upgradeToStableIds` to the planned targets.
 *  - The preview POST body is `{ entries }` (<= 50); a 409 is surfaced for a manual
 *    re-preview (no automatic retry).
 *
 * `node scripts/mcp/publish-skill-links.mjs --help` prints usage.
 * Importing this module (or running the test suite) performs no network request
 * and reads no file at import time.
 *
 * @module publish-skill-links
 */

import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

/** Documented default HTTPS origin (pinned in `opencode.json`). */
export const DEFAULT_CATALOG_URL = "https://primalcreator.fuzzball.enterprises"

/** Only these catalog kind strings are ever addressed by this script. */
export const SKILLS_KIND = "skills"

export const CATALOG_LIST_PATH = "/api/mcp/catalog"
export const CATALOG_ENTRY_PATH = "/api/mcp/catalog/entry"
export const CATALOG_PREVIEW_PATH = "/api/mcp/catalog/preview"
export const CATALOG_APPLY_PATH = "/api/mcp/catalog/apply"

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

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Server error codes that are safe to surface. Any other code (or a message
 * string from an untrusted server/Prisma error) is dropped so a secret can never
 * leak through an error payload. Only cross-checked against the fixed codes the
 * catalog publisher routes actually emit.
 */
export const SAFE_ERROR_CODES = new Set([
  "publisher_unavailable",
  "preview_stale",
  "catalog_not_found",
  "catalog_conflict",
  "conflict",
  "invalid_kind",
  "invalid_stable_id",
  "validation",
  "payload_too_large",
  "not_found",
  "unauthorized",
  "forbidden",
])

/**
 * Non-identifying label printed instead of the configured HTTPS origin, so the
 * deployment URL (which may identify an environment) never appears in output.
 */
export const TARGET_LABEL = "managed catalog"

/** The comparable rarity ladder, ascending by commonness. `Unique` is absent. */
export const RARITY_LADDER = [
  "Inferior",
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Ancient",
  "Legendary",
  "Mythical",
  "Sacred",
  "Divine",
]

/** The exact `--confirm` phrase required to apply. */
export const CONFIRM_PHRASE = "PUBLISH 32 SKILL LINKS"

const PLAN_PATH_DEFAULT = "../../docs/catalog/skill-upgrade-link-plan.json"

// ------------------------------------------------------------------ //
// Error type
// ------------------------------------------------------------------ //

/**
 * An error carrying an HTTP status and an optional server error code.
 * @param {string} message
 * @param {number} status
 * @param {string|null} [code]
 */
export class CatalogError extends Error {
  constructor(message, status, code = null) {
    super(message)
    this.name = "CatalogError"
    this.status = status
    this.code = code
  }
}

// ------------------------------------------------------------------ //
// Origin / token validation
// ------------------------------------------------------------------ //

/**
 * Validate a catalog origin: it must parse and be an HTTPS origin only - no path,
 * no query, no fragment, no userinfo. Returns the normalized origin on success.
 * @param {string} raw
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
export function validateOrigin(raw) {
  if (raw == null || raw === "") {
    return { ok: false, error: "PRIMAL_CATALOG_URL is not set" }
  }
  let url
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
    return { ok: false, error: "PRIMAL_CATALOG_URL may not carry userinfo" }
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

/**
 * Validate a base64url bearer token of 43..256 chars.
 * @param {string} token
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateToken(token) {
  if (token == null || token === "") {
    return { ok: false, error: "PRIMAL_CATALOG_TOKEN is not set" }
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

/**
 * Resolve the configuration from the environment. `PRIMAL_CATALOG_URL` falls back
 * to the documented default; the token is required. The token value is never
 * echoed in an error message.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, url: string, token: string } | { ok: false, error: string }}
 */
export function resolveConfigFromEnv(env = {}) {
  const rawUrl = env.PRIMAL_CATALOG_URL
  const origin = rawUrl == null || rawUrl === "" ? DEFAULT_CATALOG_URL : rawUrl
  const token = env.PRIMAL_CATALOG_TOKEN
  if (token == null || token === "") {
    return { ok: false, error: "PRIMAL_CATALOG_TOKEN is not set" }
  }
  const urlRes = validateOrigin(origin)
  if (!urlRes.ok) return { ok: false, error: urlRes.error }
  const tokenRes = validateToken(token)
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error }
  return { ok: true, url: urlRes.origin, token }
}

// ------------------------------------------------------------------ //
// Plan loading
// ------------------------------------------------------------------ //

/** Resolve the committed plan file path relative to this module. @returns {string} */
export function defaultPlanPath() {
  return fileURLToPath(new URL(PLAN_PATH_DEFAULT, import.meta.url))
}

/**
 * Read and parse the committed plan JSON. A missing/unparseable plan is a hard
 * failure (the plan is part of the committed source tree).
 * @param {string} [planPath]
 * @returns {{ kind: string, snapshotCount: number, archivedCount: number, edgeCount: number, upgradeLinks: Array }}
 */
export function loadPlan(planPath = defaultPlanPath()) {
  let text
  try {
    text = readFileSync(planPath, "utf8")
  } catch (err) {
    throw new CatalogError(
      `Could not read the skill upgrade plan at ${planPath}: ${err.message}`,
      0
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CatalogError(
      `Skill upgrade plan at ${planPath} is not valid JSON`,
      0
    )
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CatalogError("Skill upgrade plan is not an object", 0)
  }
  if (!Array.isArray(parsed.upgradeLinks)) {
    throw new CatalogError("Skill upgrade plan is missing `upgradeLinks`", 0)
  }
  return {
    kind: typeof parsed.kind === "string" ? parsed.kind : "skills",
    snapshotCount:
      typeof parsed.snapshotCount === "number" ? parsed.snapshotCount : 0,
    archivedCount:
      typeof parsed.archivedCount === "number" ? parsed.archivedCount : 0,
    edgeCount: typeof parsed.edgeCount === "number" ? parsed.edgeCount : 0,
    upgradeLinks: parsed.upgradeLinks,
  }
}

/** Collect every unique source/target stableId referenced by the plan. @returns {string[]} */
export function collectPlanIds(plan) {
  const ids = new Set()
  for (const link of plan.upgradeLinks) {
    ids.add(link.source.stableId)
    for (const target of link.targets) ids.add(target.stableId)
  }
  return [...ids]
}

// ------------------------------------------------------------------ //
// Rarity / adjacency helpers
// ------------------------------------------------------------------ //

/**
 * The 0-based order of a rarity within the comparable ladder, or undefined.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function rarityOrderIndex(value) {
  if (typeof value !== "string") return undefined
  const index = RARITY_LADDER.indexOf(value)
  return index >= 0 ? index : undefined
}

// ------------------------------------------------------------------ //
// HTTP client
// ------------------------------------------------------------------ //

/** @param {unknown} err @returns {string} */
function requestFailureMessage(err) {
  if (err && typeof err === "object") {
    const name = err.name
    if (name === "TimeoutError" || name === "AbortError") {
      return "Request to the catalog timed out"
    }
  }
  return "Request to the catalog failed"
}

/** @param {unknown} data @returns {{ code: string|null, message: string|null }} */
function extractError(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = data.error
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const code = typeof err.code === "string" ? err.code : null
      const message = typeof err.message === "string" ? err.message : null
      return { code, message }
    }
  }
  return { code: null, message: null }
}

/** @param {string} text @returns {{ ok: true, value: unknown } | { ok: false, error: string }} */
function parseJsonSafely(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: "Response was not valid JSON" }
  }
}

/**
 * Read a response body bounded to `maxBytes`; an oversized body fails closed.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyCapped(res, maxBytes) {
  const declared = res.headers.get("content-length")
  if (declared != null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new CatalogError(
        `Catalog response exceeds the ${maxBytes} byte cap`,
        res.status
      )
    }
  }
  if (res.body == null) return ""
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new CatalogError(
        `Catalog response exceeds the ${maxBytes} byte cap`,
        res.status
      )
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * @param {{ baseUrl: string, token: string, fetchImpl: typeof fetch, timeoutMs: number }} client
 * @param {string} path
 * @param {{ method: "GET" | "POST", body?: unknown, timeoutMs?: number }} opts
 * @returns {Promise<unknown>}
 */
async function requestJson(client, path, opts) {
  const url = `${client.baseUrl}${path}`
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${client.token}`,
  }
  let body
  if (opts.method === "POST") {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(opts.body)
  }
  let res
  try {
    res = await client.fetchImpl(url, {
      method: opts.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(
        opts.timeoutMs ?? client.timeoutMs ?? DEFAULT_TIMEOUT_MS
      ),
    })
  } catch (err) {
    throw new CatalogError(requestFailureMessage(err), 0)
  }
  const text = await readBodyCapped(res, MAX_RESPONSE_BYTES)
  const parsed = parseJsonSafely(text)
  if (!parsed.ok) {
    throw new CatalogError("Catalog returned a non-JSON response", res.status)
  }
  if (res.status >= 200 && res.status < 300) return parsed.value
  // A non-2xx status is reported with a FIXED safe message (never the untrusted
  // server/Prisma `.message`, which can echo a token) plus the validated numeric
  // HTTP status, and only a whitelisted error code is carried on the error.
  const info = extractError(parsed.value)
  const code =
    info.code != null && SAFE_ERROR_CODES.has(info.code) ? info.code : null
  throw new CatalogError(
    `Catalog returned HTTP ${res.status}`,
    res.status,
    code
  )
}

// ------------------------------------------------------------------ //
// Endpoint reads
// ------------------------------------------------------------------ //

/** @param {unknown} data @returns {Array} */
function normalizeListItems(data) {
  const obj =
    data && typeof data === "object" && !Array.isArray(data) ? data : {}
  const raw = Array.isArray(data) ? data : (obj.entries ?? obj.items)
  if (!Array.isArray(raw)) {
    throw new CatalogError(
      "Catalog list response is not an array of entries",
      0
    )
  }
  return raw.map((item) => {
    if (item == null || typeof item !== "object") {
      throw new CatalogError("Catalog list entry has an unexpected shape", 0)
    }
    return {
      kind: typeof item.kind === "string" ? item.kind : null,
      stableId: typeof item.stableId === "string" ? item.stableId : null,
      name: typeof item.name === "string" ? item.name : null,
      grade:
        item.grade == null
          ? null
          : typeof item.grade === "string"
            ? item.grade
            : null,
      sourceUrl:
        item.sourceUrl == null
          ? null
          : typeof item.sourceUrl === "string"
            ? item.sourceUrl
            : null,
      archived: item.archived === true,
    }
  })
}

/** @param {unknown} data @returns {Record<string, unknown>} */
function normalizeEntry(data) {
  const obj =
    data && typeof data === "object" && !Array.isArray(data) ? data : {}
  if (!("item" in obj)) {
    throw new CatalogError("Catalog entry response is missing `item`", 0)
  }
  const item = obj.item
  if (item == null || typeof item !== "object" || Array.isArray(item)) {
    throw new CatalogError("Catalog entry has an unexpected shape", 0)
  }
  // Fail-closed: never invent a default `config`/`gradeDescriptions`. The entry
  // response must carry both, as non-null plain objects (not arrays), plus a null
  // `grade` (the skill-grade-removal migration gate) and the full expected shape.
  const descriptionOk =
    item.description == null || typeof item.description === "string"
  const sourceUrlOk =
    item.sourceUrl == null || typeof item.sourceUrl === "string"
  const gradeOk = hasOwn(item, "grade") && item.grade == null
  const kindOk = item.kind === SKILLS_KIND
  const stableIdOk = typeof item.stableId === "string" && item.stableId !== ""
  const nameOk = typeof item.name === "string" && item.name !== ""
  const archivedOk = typeof item.archived === "boolean"
  const configOk =
    hasOwn(item, "config") &&
    item.config != null &&
    typeof item.config === "object" &&
    !Array.isArray(item.config)
  const gradeDescriptionsOk =
    hasOwn(item, "gradeDescriptions") &&
    item.gradeDescriptions != null &&
    typeof item.gradeDescriptions === "object" &&
    !Array.isArray(item.gradeDescriptions)
  if (!(
    descriptionOk &&
    sourceUrlOk &&
    gradeOk &&
    kindOk &&
    stableIdOk &&
    nameOk &&
    archivedOk &&
    configOk &&
    gradeDescriptionsOk
  )) {
    throw new CatalogError(
      "Catalog entry response is incomplete or malformed",
      0
    )
  }
  return {
    kind: item.kind,
    stableId: item.stableId,
    name: item.name,
    description: item.description,
    grade: item.grade,
    sourceUrl: item.sourceUrl,
    archived: item.archived,
    config: item.config,
    gradeDescriptions: item.gradeDescriptions,
  }
}

/**
 * GET the skills list (includeArchived=1) - lightweight summaries.
 * @param {object} client
 * @returns {Promise<Array>}
 */
export async function fetchSkillsList(client) {
  const data = await requestJson(
    client,
    `${CATALOG_LIST_PATH}?kind=${SKILLS_KIND}&includeArchived=1`,
    { method: "GET" }
  )
  return normalizeListItems(data)
}

/**
 * GET one full skills entry by stableId.
 * @param {object} client
 * @param {string} stableId
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchSkillEntry(client, stableId) {
  const data = await requestJson(
    client,
    `${CATALOG_ENTRY_PATH}?kind=${SKILLS_KIND}&stableId=${encodeURIComponent(stableId)}`,
    { method: "GET" }
  )
  const entry = normalizeEntry(data)
  // Preflight guard: the GET must return the EXACT record we asked for. A server
  // that resolves to a different stableId (fuzzy match, wrong record) is a
  // malformed read and must not be accepted as the source/target.
  if (entry.stableId !== stableId) {
    throw new CatalogError("Catalog entry identity mismatch", 0)
  }
  return entry
}

// ------------------------------------------------------------------ //
// Validation
// ------------------------------------------------------------------ //

/** @param {Record<string, unknown>} obj @param {string} key @returns {boolean} */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** @param {string[]} a @param {string[]} b @returns {boolean} */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** @param {Record<string, unknown>} records @param {string} stableId @param {string} role @returns {object} */
function requireRecord(records, stableId, role) {
  const rec = records[stableId]
  if (!rec) {
    throw new CatalogError(
      `${role} skill "${stableId}" was not found in the catalog`,
      0
    )
  }
  return rec
}

/** @param {string} stableId @returns {string} */
function gradeGateMessage(stableId) {
  return `skill "${stableId}" still carries a grade/gradeDescriptions after the skill-grade-removal migration (expected null grade and empty gradeDescriptions); is the migration deployed?`
}

/**
 * @param {{ stableId: string, name: string, rarity: string }} item
 * @param {Record<string, unknown>} records
 * @param {Set<string>} activeIds
 * @param {string} role
 */
function validatePlanItem(item, records, activeIds, role) {
  const rec = requireRecord(records, item.stableId, role)
  if (rec.kind !== SKILLS_KIND) {
    throw new CatalogError(
      `${role} skill "${item.stableId}" is kind "${String(rec.kind)}", not skills`,
      0
    )
  }
  if (rec.name !== item.name) {
    throw new CatalogError(
      `${role} skill "${item.stableId}" name mismatch: plan "${item.name}" vs catalog "${String(rec.name)}"`,
      0
    )
  }
  const recordRarity = rec.config.rarity
  if (recordRarity !== item.rarity) {
    throw new CatalogError(
      `${role} skill "${item.stableId}" rarity mismatch: plan "${item.rarity}" vs catalog "${String(recordRarity)}"`,
      0
    )
  }
  if (rec.archived) {
    throw new CatalogError(
      `${role} skill "${item.stableId}" is archived; cannot publish`,
      0
    )
  }
  if (activeIds && !activeIds.has(item.stableId)) {
    throw new CatalogError(
      `${role} skill "${item.stableId}" is not in the active catalog list`,
      0
    )
  }
  if (rec.grade != null) {
    throw new CatalogError(gradeGateMessage(item.stableId), 0)
  }
  const gradeDescriptions = rec.gradeDescriptions
  if (gradeDescriptions && Object.keys(gradeDescriptions).length > 0) {
    throw new CatalogError(gradeGateMessage(item.stableId), 0)
  }
}

/**
 * Preflight structural validation of the plan itself, BEFORE any catalog read.
 * Rejects a malformed plan (missing/duplicate/nonempty IDs, a link with zero
 * targets, an inconsistent `edgeCount`) with a safe error so a bad plan can never
 * reach the preview step. Also verifies that the source and target ID sets are
 * unique and nonempty.
 * @param {object} plan
 */
export function validatePlanShape(plan) {
  if (!Array.isArray(plan.upgradeLinks)) {
    throw new CatalogError("Skill upgrade plan is missing `upgradeLinks`", 0)
  }
  const edgeCount = plan.edgeCount
  if (
    typeof edgeCount !== "number" ||
    !Number.isInteger(edgeCount) ||
    edgeCount < 1
  ) {
    throw new CatalogError(
      "Skill upgrade plan must declare a positive integer `edgeCount`",
      0
    )
  }
  if (plan.upgradeLinks.length !== edgeCount) {
    throw new CatalogError(
      `Skill upgrade plan declares ${edgeCount} edges but contains ${plan.upgradeLinks.length} upgrade link(s); the source/edge count is inconsistent`,
      0
    )
  }
  const sourceIds = new Set()
  const targetIds = new Set()
  for (let i = 0; i < plan.upgradeLinks.length; i++) {
    const link = plan.upgradeLinks[i]
    if (link == null || typeof link !== "object" || Array.isArray(link)) {
      throw new CatalogError(`Skill upgrade link ${i} is not an object`, 0)
    }
    const src = link.source
    if (src == null || typeof src !== "object") {
      throw new CatalogError(`Skill upgrade link ${i} is missing a source`, 0)
    }
    if (typeof src.stableId !== "string" || src.stableId === "") {
      throw new CatalogError(
        `Skill upgrade link ${i} has a source with an empty/missing stableId`,
        0
      )
    }
    if (sourceIds.has(src.stableId)) {
      throw new CatalogError(
        `Skill upgrade plan lists source skill "${src.stableId}" more than once`,
        0
      )
    }
    sourceIds.add(src.stableId)
    if (!Array.isArray(link.targets) || link.targets.length === 0) {
      throw new CatalogError(
        `Skill upgrade link ${i} (source "${src.stableId}") has no targets`,
        0
      )
    }
    for (const target of link.targets) {
      if (target == null || typeof target !== "object") {
        throw new CatalogError(
          `Skill upgrade link ${i} has a malformed target for source "${src.stableId}"`,
          0
        )
      }
      if (typeof target.stableId !== "string" || target.stableId === "") {
        throw new CatalogError(
          `Skill upgrade link ${i} has a target with an empty/missing stableId`,
          0
        )
      }
      if (targetIds.has(target.stableId)) {
        throw new CatalogError(
          `Skill upgrade plan lists target skill "${target.stableId}" more than once`,
          0
        )
      }
      targetIds.add(target.stableId)
    }
  }
}

/**
 * Validate the whole plan against the fetched records plus the active list set.
 * Throws a `CatalogError` on the first violation.
 * @param {object} plan
 * @param {Record<string, unknown>} records
 * @param {Set<string>} activeIds
 */
export function validatePlan(plan, records, activeIds) {
  if (!Array.isArray(plan.upgradeLinks)) {
    throw new CatalogError("Skill upgrade plan is missing `upgradeLinks`", 0)
  }
  for (const link of plan.upgradeLinks) {
    const src = link.source
    const targetStableIds = link.targets.map((t) => t.stableId)
    validatePlanItem(src, records, activeIds, "source")
    for (const target of link.targets) {
      validatePlanItem(target, records, activeIds, "target")
    }

    const srcRec = requireRecord(records, src.stableId, "source")
    const srcIndex = rarityOrderIndex(srcRec.config.rarity)
    if (srcIndex == null) {
      throw new CatalogError(
        `source skill "${src.stableId}" rarity "${String(srcRec.config.rarity)}" is not on the comparable rarity ladder`,
        0
      )
    }
    const srcTrack = srcRec.config.track
    // Every target must be rarity-adjacent AND on the same track as the source.
    for (const target of link.targets) {
      const dstRec = requireRecord(records, target.stableId, "target")
      const dstIndex = rarityOrderIndex(dstRec.config.rarity)
      if (dstIndex == null) {
        throw new CatalogError(
          `target skill "${target.stableId}" rarity "${String(dstRec.config.rarity)}" is not on the comparable rarity ladder`,
          0
        )
      }
      if (dstIndex - srcIndex !== 1) {
        throw new CatalogError(
          `edge ${src.stableId} (${srcRec.config.rarity}) -> ${target.stableId} (${dstRec.config.rarity}) is not rarity-adjacent`,
          0
        )
      }
      if (dstRec.config.track !== srcTrack) {
        throw new CatalogError(
          `edge ${src.stableId} -> ${target.stableId} crosses track (${String(srcTrack)} vs ${String(dstRec.config.track)})`,
          0
        )
      }
    }
    // Guard: never overwrite a different explicit list already on the source.
    if (hasOwn(srcRec.config, "upgradeToStableIds")) {
      const existing = srcRec.config.upgradeToStableIds
      const ok =
        Array.isArray(existing) &&
        existing.every((id) => typeof id === "string") &&
        arraysEqual(existing, targetStableIds)
      if (!ok) {
        throw new CatalogError(
          "Existing explicit skill upgrade paths differ from the approved plan",
          0
        )
      }
    }
  }
}

// ------------------------------------------------------------------ //
// Entry building (full config replacement, only upgradeToStableIds changes)
// ------------------------------------------------------------------ //

/**
 * Build the managed-batch entries from the validated plan and records. Each
 * source's config is a FULL replacement: every existing config field is carried
 * over and ONLY `upgradeToStableIds` is set to the planned targets. The entry
 * carries no `archived` key (the managed entry schema is strict).
 * @param {object} plan
 * @param {Record<string, unknown>} records
 * @returns {Array}
 */
export function buildEntries(plan, records) {
  const entries = []
  for (const link of plan.upgradeLinks) {
    const src = link.source
    const rec = requireRecord(records, src.stableId, "source")
    const targetIds = link.targets.map((t) => t.stableId)
    const config = { ...rec.config, upgradeToStableIds: targetIds }
    entries.push({
      kind: SKILLS_KIND,
      stableId: src.stableId,
      name: rec.name ?? src.stableId,
      description: rec.description,
      grade: null,
      sourceUrl: rec.sourceUrl,
      config,
      gradeDescriptions: {},
    })
  }
  return entries
}

// ------------------------------------------------------------------ //
// Preview / apply
// ------------------------------------------------------------------ //

/** @param {unknown} data @returns {{ changes: Array, previewTicket: string, payloadDigest: string, stateDigest: string }} */
function normalizePreview(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new CatalogError("Catalog preview response is malformed", 0)
  }
  const previewTicket =
    typeof data.previewTicket === "string" ? data.previewTicket : ""
  if (!previewTicket) {
    throw new CatalogError(
      "Catalog preview response is missing a previewTicket",
      0
    )
  }
  if (!Array.isArray(data.changes)) {
    throw new CatalogError(
      "Catalog preview response is missing a `changes` array",
      0
    )
  }
  return {
    changes: data.changes,
    previewTicket,
    payloadDigest:
      typeof data.payloadDigest === "string" ? data.payloadDigest : "",
    stateDigest: typeof data.stateDigest === "string" ? data.stateDigest : "",
  }
}

/** @param {unknown} data @returns {{ changes: Array, payloadDigest: string, stateDigest: string }} */
function normalizeApply(data) {
  if (data == null || typeof data !== "object") {
    throw new CatalogError("Catalog apply response is malformed", 0)
  }
  return {
    changes: Array.isArray(data.changes) ? data.changes : [],
    payloadDigest:
      typeof data.payloadDigest === "string" ? data.payloadDigest : "",
    stateDigest: typeof data.stateDigest === "string" ? data.stateDigest : "",
  }
}

/**
 * POST `{ entries }` to the preview route. Never applies.
 * @param {object} client
 * @param {Array} entries
 * @returns {Promise<{ changes: Array, previewTicket: string, payloadDigest: string, stateDigest: string }>}
 */
export async function previewEntries(client, entries) {
  const data = await requestJson(client, CATALOG_PREVIEW_PATH, {
    method: "POST",
    body: { entries },
  })
  return normalizePreview(data)
}

/**
 * POST `{ entries, previewTicket }` to the apply route.
 * @param {object} client
 * @param {Array} entries
 * @param {string} previewTicket
 * @returns {Promise<{ changes: Array, payloadDigest: string, stateDigest: string }>}
 */
export async function applyEntries(client, entries, previewTicket) {
  const data = await requestJson(client, CATALOG_APPLY_PATH, {
    method: "POST",
    body: { entries, previewTicket },
    timeoutMs: APPLY_TIMEOUT_MS,
  })
  return normalizeApply(data)
}

// ------------------------------------------------------------------ //
// Preview validation (blocker: never apply on a malformed preview)
// ------------------------------------------------------------------ //

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!hasOwn(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/**
 * Match an optional/nullable result field against the intended value. A null/
 * undefined actual is accepted only when the intended value is also nullish;
 * otherwise the values must be deep-equal.
 * @param {unknown} actual
 * @param {unknown} intended
 * @returns {boolean}
 */
function matchNullable(actual, intended) {
  if (intended == null) return actual == null
  return deepEqual(actual, intended)
}

/**
 * Verify a preview `before` snapshot still matches the full source record we
 * read from the catalog earlier. A mismatch means the source changed between the
 * full catalog read and the preview projection, so applying would be unsafe.
 * @param {unknown} before
 * @param {object} prior The pre-apply snapshot for this source.
 */
function assertBeforeMatches(before, prior) {
  if (
    !before ||
    typeof before !== "object" ||
    Array.isArray(before) ||
    !prior ||
    !deepEqual(before.config, prior.config) ||
    before.name !== prior.name ||
    !matchNullable(before.description, prior.description) ||
    !matchNullable(before.sourceUrl, prior.sourceUrl) ||
    !matchNullable(before.grade, prior.grade) ||
    before.archived !== prior.archived ||
    !deepEqual(before.gradeDescriptions, prior.gradeDescriptions)
  ) {
    throw new CatalogError(
      "Preview source changed since the full catalog read",
      0
    )
  }
}

/**
 * Verify a preview `after` snapshot matches the intended full source config and
 * metadata (the entry we are about to send). A mismatch means the server's
 * projection of the change is wrong and applying would be unsafe.
 * @param {unknown} after
 * @param {object} expected The built entry for this source.
 * @param {string} stableId
 */
function assertAfterMatches(after, expected, stableId) {
  if (after == null || typeof after !== "object" || Array.isArray(after)) {
    throw new CatalogError(
      `preview response for skill "${stableId}" is missing its "after" snapshot`,
      0
    )
  }
  if (!deepEqual(after.config, expected.config)) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has an "after.config" that does not match the intended config`,
      0
    )
  }
  if (after.name !== expected.name) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has an "after.name" that does not match the intended name`,
      0
    )
  }
  if (!matchNullable(after.description, expected.description)) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has an "after.description" that does not match the intended description`,
      0
    )
  }
  if (!matchNullable(after.sourceUrl, expected.sourceUrl)) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has an "after.sourceUrl" that does not match the intended sourceUrl`,
      0
    )
  }
  if (!matchNullable(after.grade, expected.grade)) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has an "after.grade" that does not match the intended grade`,
      0
    )
  }
  if (after.archived !== undefined && after.archived !== false) {
    throw new CatalogError(
      `preview response for skill "${stableId}" reports an archived after state`,
      0
    )
  }
  const intendedGradeDescriptions = expected.gradeDescriptions ?? {}
  const afterGradeDescriptions = after.gradeDescriptions
  const gradeDescriptionsOk =
    afterGradeDescriptions == null &&
    Object.keys(intendedGradeDescriptions).length === 0
      ? true
      : deepEqual(afterGradeDescriptions, intendedGradeDescriptions)
  if (!gradeDescriptionsOk) {
    throw new CatalogError(
      `preview response for skill "${stableId}" has "after.gradeDescriptions" that does not match the intended gradeDescriptions`,
      0
    )
  }
}

/**
 * Validate the preview response BEFORE any apply. The `changes` array must be a
 * proper array whose set of stableIds EXACTLY equals the planned source keys
 * (32), every change must report `kind` `skills`, statuses must only be
 * `update`/`unchanged` (never `create`), `changedFields` may only contain
 * `config`, and every `after` snapshot must match the intended full source
 * config/metadata. Any deviation aborts the publish so a bad preview can never
 * trigger an apply.
 * @param {object} preview
 * @param {object} plan
 * @param {Array} entries
 * @param {Record<string, object>} sourceSnapshot
 */
export function validatePreviewResponse(
  preview,
  plan,
  entries,
  sourceSnapshot
) {
  if (!Array.isArray(preview?.changes)) {
    throw new CatalogError(
      "Catalog preview response `changes` is not an array",
      0
    )
  }
  const expectedIds = plan.upgradeLinks.map((link) => link.source.stableId)
  const expectedSet = new Set(expectedIds)
  const entryByStableId = new Map(
    entries.map((entry) => [entry.stableId, entry])
  )
  const seen = new Set()
  for (const change of preview.changes) {
    if (change == null || typeof change !== "object" || Array.isArray(change)) {
      throw new CatalogError(
        "Catalog preview response has a malformed change",
        0
      )
    }
    const stableId = change.stableId
    if (typeof stableId !== "string" || stableId === "") {
      throw new CatalogError(
        "Catalog preview response has a change with no stableId",
        0
      )
    }
    if (seen.has(stableId)) {
      throw new CatalogError(
        `Catalog preview response lists source skill "${stableId}" more than once`,
        0
      )
    }
    seen.add(stableId)
    // Require the remote `kind` to be EXACTLY skills before any apply. This is the
    // only place an unvalidated remote string could otherwise reach the summary
    // printer, so a crafted/misreported kind (or one embedding a token) aborts.
    if (change.kind !== SKILLS_KIND) {
      throw new CatalogError(
        `Catalog preview response reports kind "${String(change.kind)}" for skill "${stableId}" (expected ${SKILLS_KIND})`,
        0
      )
    }
    if (!expectedSet.has(stableId)) {
      throw new CatalogError(
        `Catalog preview response reports an unexpected change for skill "${stableId}"`,
        0
      )
    }
    const status = change.status
    if (status !== "update" && status !== "unchanged") {
      throw new CatalogError(
        `Catalog preview response reports status "${String(status)}" for skill "${stableId}" (expected update/unchanged, never create)`,
        0
      )
    }
    if (!Array.isArray(change.changedFields)) {
      throw new CatalogError(
        `Catalog preview response has non-array changedFields for skill "${stableId}"`,
        0
      )
    }
    for (const field of change.changedFields) {
      if (field !== "config") {
        throw new CatalogError(
          `Catalog preview response reports unexpected changed field "${String(field)}" for skill "${stableId}"`,
          0
        )
      }
    }
    const expected = entryByStableId.get(stableId)
    if (!expected) {
      throw new CatalogError(
        `Catalog preview response has no intended entry for skill "${stableId}"`,
        0
      )
    }
    assertAfterMatches(change.after, expected, stableId)
    assertBeforeMatches(change.before, sourceSnapshot[stableId])
  }
  if (seen.size !== expectedIds.length) {
    const missing = expectedIds.filter((id) => !seen.has(id))
    throw new CatalogError(
      `Catalog preview response is missing ${missing.length} planned source change(s) (${missing.join(", ")})`,
      0
    )
  }
}

// ------------------------------------------------------------------ //
// Post-apply verification
// ------------------------------------------------------------------ //

/**
 * Capture the pre-apply full config + metadata snapshot for every source so the
 * post-apply comparison can prove that ONLY upgradeToStableIds was altered (no
 * lost effects, no metadata drift).
 * @param {Record<string, unknown>} records Pre-apply full records.
 * @param {object} plan
 * @returns {Record<string, object>}
 */
export function captureSourceSnapshot(records, plan) {
  const snapshot = {}
  for (const link of plan.upgradeLinks) {
    const src = link.source.stableId
    const rec = records[src]
    if (!rec) {
      throw new CatalogError(
        `source skill "${src}" is missing its pre-apply record`,
        0
      )
    }
    snapshot[src] = {
      name: rec.name,
      description: rec.description,
      sourceUrl: rec.sourceUrl,
      archived: rec.archived,
      grade: rec.grade,
      gradeDescriptions: structuredClone(rec.gradeDescriptions ?? {}),
      config: structuredClone(rec.config ?? {}),
    }
  }
  return snapshot
}

/**
 * Compare a post-apply source against its pre-apply snapshot, allowing ONLY the
 * planned `upgradeToStableIds` to differ. Any lost/changed config field or
 * metadata field aborts.
 * @param {Record<string, unknown>} rec Post-apply fetched record.
 * @param {object} snapshot Pre-apply snapshot.
 * @param {string[]} targetIds Planned target stableIds.
 * @param {string} stableId
 */
function assertAppliedMatchesSnapshot(rec, snapshot, targetIds, stableId) {
  if (rec.name !== snapshot.name) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" name changed`,
      0
    )
  }
  if (rec.description !== snapshot.description) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" description changed`,
      0
    )
  }
  if (rec.sourceUrl !== snapshot.sourceUrl) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" sourceUrl changed`,
      0
    )
  }
  if (rec.archived !== snapshot.archived) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" archived state changed`,
      0
    )
  }
  if (rec.grade !== snapshot.grade) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" grade changed`,
      0
    )
  }
  if (!deepEqual(rec.gradeDescriptions ?? {}, snapshot.gradeDescriptions)) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" gradeDescriptions changed`,
      0
    )
  }
  const pre = snapshot.config ?? {}
  const post = rec.config ?? {}
  for (const key of Object.keys(pre)) {
    if (key === "upgradeToStableIds") continue
    if (!hasOwn(post, key)) {
      throw new CatalogError(
        `after apply, source skill "${stableId}" lost config field "${key}"`,
        0
      )
    }
    if (!deepEqual(post[key], pre[key])) {
      throw new CatalogError(
        `after apply, source skill "${stableId}" config field "${key}" changed`,
        0
      )
    }
  }
  for (const key of Object.keys(post)) {
    if (key === "upgradeToStableIds") continue
    if (!hasOwn(pre, key)) {
      throw new CatalogError(
        `after apply, source skill "${stableId}" gained unexpected config field "${key}"`,
        0
      )
    }
  }
  const discovered = post.upgradeToStableIds
  const ok =
    Array.isArray(discovered) &&
    discovered.every((id) => typeof id === "string") &&
    arraysEqual(discovered, targetIds)
  if (!ok) {
    throw new CatalogError(
      `after apply, source skill "${stableId}" upgradeToStableIds is ${JSON.stringify(discovered)}, expected ${JSON.stringify(targetIds)}`,
      0
    )
  }
}

/**
 * After an apply, re-GET each source and confirm the planned targets are set AND
 * that no other config field or metadata was altered relative to the pre-apply
 * snapshot (only `upgradeToStableIds` may change).
 * @param {object} client
 * @param {object} plan
 * @param {Record<string, object>} sourceSnapshot
 * @returns {Promise<string[]>}
 */
export async function verifyApplied(client, plan, sourceSnapshot) {
  const lines = []
  for (const link of plan.upgradeLinks) {
    const src = link.source
    const targetIds = link.targets.map((t) => t.stableId)
    const snapshot = sourceSnapshot[src.stableId]
    if (!snapshot) {
      throw new CatalogError(
        `source skill "${src.stableId}" is missing its pre-apply snapshot`,
        0
      )
    }
    const rec = await fetchSkillEntry(client, src.stableId)
    assertAppliedMatchesSnapshot(rec, snapshot, targetIds, src.stableId)
    lines.push(
      `verified skills/${src.stableId}: upgradeToStableIds=${JSON.stringify(targetIds)}`
    )
  }
  return lines
}

// ------------------------------------------------------------------ //
// Argument parsing
// ------------------------------------------------------------------ //

/**
 * Parse CLI args. Unknown flags fail closed.
 *
 * pnpm forwards the standalone `--` separator to the script, so the documented
 * `pnpm mcp:publish-skill-links -- --execute --confirm '...'` reaches this module
 * as a leading `--` in `args`. Exactly ONE such leading standalone `--` is
 * tolerated and ignored; any other `--` (a duplicate, mid-argument or trailing
 * separator) fails closed like any unknown flag.
 * @param {string[]} args
 * @returns {{ execute: boolean, confirm: string|null, help: boolean }}
 */
export function parseArgs(args) {
  let execute = false
  let confirm = null
  let help = false
  // Strip exactly one leading standalone `--` pnpm separator.
  const rest = args.length > 0 && args[0] === "--" ? args.slice(1) : args
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (arg === "--execute") {
      execute = true
      continue
    }
    if (arg === "--confirm") {
      const value = rest[i + 1]
      if (value == null) {
        throw new CatalogError("--confirm requires a value", 0)
      }
      confirm = value
      i++
      continue
    }
    if (arg.startsWith("--confirm=")) {
      confirm = arg.slice("--confirm=".length)
      continue
    }
    // Any remaining `--` is a stray/duplicate/mid-argument separator.
    throw new CatalogError(`Unknown argument: ${arg}`, 0)
  }
  return { execute, confirm, help }
}

// ------------------------------------------------------------------ //
// Orchestration
// ------------------------------------------------------------------ //

/**
 * Run the guarded publish flow. Returns a summary object on success; throws a
 * `CatalogError` on any validation/network/apply failure (fail closed).
 * @param {{ env?: Record<string, string|undefined>, argv?: string[], fetchImpl?: typeof fetch, planPath?: string }} [opts]
 * @returns {Promise<{ ok: boolean, mode: "dry-run" | "applied", targetUrl: string, activeCount: number, sourceCount: number, targetCount: number, entries: Array, preview: { changes: Array, previewTicket: string, payloadDigest: string, stateDigest: string }, applied: { changes: Array, payloadDigest: string, stateDigest: string } | null, verification: string[] | null }>}
 */
export async function run(opts = {}) {
  const {
    env = {},
    argv = [],
    fetchImpl = globalThis.fetch,
    planPath = defaultPlanPath(),
  } = opts

  const args = parseArgs(argv)
  if (args.execute && args.confirm !== CONFIRM_PHRASE) {
    throw new CatalogError(
      "Exact confirmation phrase required for --execute",
      0
    )
  }

  const config = resolveConfigFromEnv(env)
  if (!config.ok) throw new CatalogError(config.error, 0)
  const client = {
    baseUrl: config.url,
    token: config.token,
    fetchImpl,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }

  const plan = loadPlan(planPath)
  // Structural preflight of the plan itself (IDs unique/nonempty, edgeCount
  // consistent) BEFORE any catalog read, so a malformed plan never reaches the
  // list/entry/preview steps.
  validatePlanShape(plan)

  // 1. Authenticated GET skills list (includeArchived=1) to derive active count.
  const list = await fetchSkillsList(client)
  const activeCount = list.filter((item) => !item.archived).length
  const activeIds = new Set(
    list.filter((item) => !item.archived).map((item) => item.stableId)
  )

  // 2. Full GET for EACH source and EACH target (deduped).
  const ids = collectPlanIds(plan)
  const records = {}
  for (const id of ids) {
    records[id] = await fetchSkillEntry(client, id)
  }

  // 3. Validate names/rarities/ids, active state, adjacency, track, grade gate,
  //    and the existing-explicit-list guard.
  validatePlan(plan, records, activeIds)

  // 4. Build the replacement entries (full config preservation, only edge change).
  const entries = buildEntries(plan, records)

  // 4a. Capture the pre-apply full source snapshot BEFORE preview so both the
  //     preview `before` guard and the post-apply comparison use the same read.
  const sourceSnapshot = captureSourceSnapshot(records, plan)

  // 5. Preview. A 409 here means re-preview manually.
  let preview
  try {
    preview = await previewEntries(client, entries)
  } catch (err) {
    if (err instanceof CatalogError && err.status === 409) {
      throw new CatalogError(
        `Preview returned 409; re-preview manually. ${err.message}`,
        err.status,
        err.code
      )
    }
    throw err
  }

  // 5a. Validate the preview response BEFORE any apply: exact source keys, no
  //     create, config-only changedFields, and after/before snapshots matching
  //     the intended full source config/metadata. A malformed preview aborts.
  validatePreviewResponse(preview, plan, entries, sourceSnapshot)

  if (!args.execute) {
    return {
      ok: true,
      mode: "dry-run",
      targetUrl: client.baseUrl,
      activeCount,
      sourceCount: plan.upgradeLinks.length,
      targetCount: plan.upgradeLinks.reduce(
        (n, link) => n + link.targets.length,
        0
      ),
      entries,
      preview,
      applied: null,
      verification: null,
    }
  }

  // 6. Apply with the preview ticket (it is content-bound, valid ~5 min).
  //    The pre-apply snapshot was captured BEFORE the preview (step 4a) so the
  //    post-apply comparison can prove that only upgradeToStableIds was altered.
  let applied
  try {
    applied = await applyEntries(client, entries, preview.previewTicket)
  } catch (err) {
    if (err instanceof CatalogError && err.status === 409) {
      throw new CatalogError(
        `Apply returned 409; re-preview and retry manually. ${err.message}`,
        err.status,
        err.code
      )
    }
    throw err
  }

  // 7. Verify by re-GETting each source after apply: planned targets set AND full
  //    config/metadata preserved (only upgradeToStableIds altered).
  const verification = await verifyApplied(client, plan, sourceSnapshot)

  return {
    ok: true,
    mode: "applied",
    targetUrl: client.baseUrl,
    activeCount,
    sourceCount: plan.upgradeLinks.length,
    targetCount: plan.upgradeLinks.reduce(
      (n, link) => n + link.targets.length,
      0
    ),
    entries,
    preview,
    applied,
    verification,
  }
}

// ------------------------------------------------------------------ //
// Reporting
// ------------------------------------------------------------------ //

/** @param {{ stableId?: string }} change @returns {string} */
function changeStableId(change) {
  return typeof change.stableId === "string" ? change.stableId : "?"
}

/** @param {{ status?: string }} change @returns {string} */
function changeStatus(change) {
  return typeof change.status === "string" ? change.status : "?"
}

/** @param {{ changedFields?: unknown }} change @returns {string[]} */
function changedFields(change) {
  return Array.isArray(change.changedFields)
    ? change.changedFields.filter((f) => typeof f === "string")
    : []
}

/**
 * Print the run summary: no full config bodies, no secrets.
 * @param {{ targetUrl: string, activeCount: number, sourceCount: number, targetCount: number, entries: Array, preview: { changes?: Array }, mode: string, applied: { changes?: Array } | null, verification: string[] | null }} result
 */
export function printResult(result) {
  // Never print the configured HTTPS origin; use a non-identifying label.
  console.log(`Target: ${TARGET_LABEL}`)
  console.log(`Active skills in the catalog list: ${result.activeCount}`)
  console.log(
    `Plan: ${result.sourceCount} sources -> ${result.targetCount} targets`
  )

  const changes = result.preview?.changes ?? []
  console.log(`Preview (${result.entries.length} entries):`)
  if (changes.length === 0) {
    console.log("  (no changes)")
  } else {
    for (const change of changes) {
      const fields = changedFields(change)
      const detail = fields.length > 0 ? `  [${fields.join(", ")}]` : ""
      console.log(
        `- ${changeStatus(change)}  ${SKILLS_KIND}/${changeStableId(change)}${detail}`
      )
    }
  }

  if (result.mode === "dry-run") {
    console.log(
      "DRY RUN: no apply performed (plan was only validated and previewed)."
    )
    console.log(
      `To apply: pnpm mcp:publish-skill-links -- --execute --confirm '${CONFIRM_PHRASE}'`
    )
  } else {
    const n =
      result.applied && Array.isArray(result.applied.changes)
        ? result.applied.changes.length
        : 0
    console.log(`APPLIED: ${n} entries`)
    for (const line of result.verification ?? []) {
      console.log(`- ${line}`)
    }
  }
}

/** Print the usage banner. */
function printUsage() {
  console.log(
    `Publish the committed skill upgrade-link plan (${CONFIRM_PHRASE}).`
  )
  console.log("")
  console.log("Usage:")
  console.log(
    "  pnpm mcp:publish-skill-links --                         # read-only dry run (default)"
  )
  console.log(
    "  pnpm mcp:publish-skill-links -- --execute --confirm 'PUBLISH 32 SKILL LINKS'"
  )
  console.log("  pnpm mcp:publish-skill-links -- --help")
  console.log("")
  console.log("Environment:")
  console.log(
    "  PRIMAL_CATALOG_URL    HTTPS origin (optional; defaults to the documented deployment origin)"
  )
  console.log(
    "  PRIMAL_CATALOG_TOKEN  base64url bearer token, 43-256 chars (required)"
  )
}

/**
 * Render an error for the CLI WITHOUT echoing any `.message` - not even a
 * trusted CatalogError's. A server/Prisma/network message (which can embed a
 * bearer token, origin or stack) is never printed. Only the fixed safe string and
 * a vetted numeric HTTP status (100..599) and/or a whitelisted error code are
 * surfaced. This is the single place an untrusted value can reach the console.
 * @param {unknown} err @returns {string}
 */
export function safeErrorMessage(err) {
  let status = null
  let code = null
  if (err && typeof err === "object") {
    if (typeof err.status === "number") status = err.status
    if (typeof err.code === "string" && SAFE_ERROR_CODES.has(err.code)) {
      code = err.code
    }
  }
  if (
    status != null &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  ) {
    return code
      ? `Catalog operation failed (HTTP ${status}) [${code}]`
      : `Catalog operation failed (HTTP ${status})`
  }
  return "Catalog operation failed"
}

// ------------------------------------------------------------------ //
// Entry point (no side effects on import)
// ------------------------------------------------------------------ //

/** @returns {boolean} */
function isRunningAsMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

async function main() {
  const argv = process.argv.slice(2)
  try {
    const args = parseArgs(argv)
    if (args.help) {
      printUsage()
      return
    }
    const result = await run({ env: process.env, argv })
    printResult(result)
  } catch (err) {
    console.error(safeErrorMessage(err))
    process.exitCode = 1
  }
}

if (isRunningAsMain()) {
  void main()
}
