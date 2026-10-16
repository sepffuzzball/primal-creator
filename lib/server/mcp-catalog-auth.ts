/**
 * Publisher auth for the MCP catalog endpoints.
 *
 * Two independent concerns, both deliberately fail-closed:
 *
 * 1. `requireMcpCatalogBearer` guards the NEW MCP catalog publisher routes. Only a
 *    request carrying `Authorization: Bearer <token>` whose sha256 matches the
 *    configured `MCP_CATALOG_TOKEN_SHA256` (exactly 64 lowercase hex) is admitted.
 *    There is NO cookie/Origin fallback: a session-cookie request without a
 *    bearer is rejected, and an unset/malformed env var fails the request closed
 *    with 503 rather than ever admitting a request it cannot vouch for.
 * 2. `issueMcpPreviewTicket` / `verifyMcpPreviewTicket` mint and check short-lived,
 *    content-bound preview tickets used to hand a publisher a signed view of a
 *    specific payload version. The ticket is an HMAC-SHA256 over a versioned
 *    canonical payload, signed with `AUTH_SECRET` (NOT the MCP bearer), bound to
 *    the exact payload/state digests, and expires in 5 minutes. It can never be
 *    forged with knowledge of the MCP bearer alone.
 *
 * No raw token, hash, or secret is ever logged or returned - all error messages
 * are generic.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { ApiError, conflict, unauthorized } from "@/lib/server/errors"

/** Lifetime of a preview ticket: 5 minutes from issuance. */
export const PREVIEW_TICKET_TTL_MS = 5 * 60 * 1000

/** Upper bound on a ticket string; rejects pathological unbounded input. */
export const MAX_TICKET_LENGTH = 1024

/** The canonical payload version embedded in every ticket. */
const TICKET_VERSION = 1

/** Base64url secrets must be at least 256 bits (43 chars) and at most 256 chars. */
const MIN_BEARER_LENGTH = 43
const MAX_BEARER_LENGTH = 256

/** `MCP_CATALOG_TOKEN_SHA256` must be exactly 64 lowercase hex characters. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

/** Base64url alphabet only (no `+`, `/`, or `=` padding). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Reserved HTTP auth scheme, case-insensitive. */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i

/** 503 - the server cannot authenticate publishers because it is misconfigured. */
function publisherUnavailable(message: string): ApiError {
  return new ApiError(503, "publisher_unavailable", message)
}

/** 409 - a preview ticket is no longer acceptable (expired, altered, or bound differently). */
function previewStale(message: string): ApiError {
  return conflict("preview_stale", message)
}

/**
 * Resolve the bearer token from the request's `Authorization` header, or `null`
 * when the header is absent, not a Bearer scheme, or carries no token. The raw
 * token is returned as-is so the caller can apply length / charset / hash checks.
 */
function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = BEARER_PATTERN.exec(header.trim())
  if (!match) return null
  return match[1] || null
}

/**
 * Read and validate `MCP_CATALOG_TOKEN_SHA256`. Throws 503 `publisher_unavailable`
 * when it is unset or not exactly 64 lowercase hex. A misconfigured server fails
 * closed: no request escalates to a real auth decision until the env is sane.
 */
function requireMcpTokenHash(): string {
  const value = process.env.MCP_CATALOG_TOKEN_SHA256
  if (!value || !SHA256_HEX_PATTERN.test(value)) {
    throw publisherUnavailable("Publisher auth token is not configured")
  }
  return value
}

/**
 * Assert that a request carries a valid publisher bearer token.
 *
 * Authorization must be `Bearer <base64url secret>` where the secret is 43..256
 * chars. The sha256 of the raw token is compared (constant-time) against
 * `MCP_CATALOG_TOKEN_SHA256`. Missing/invalid bearer -> 401 `unauthorized`;
 * unset/malformed env -> 503 `publisher_unavailable`. No cookie/Origin fallback
 * exists: a session cookie alone is rejected here.
 */
export function requireMcpCatalogBearer(request: Request): void {
  const expectedHash = requireMcpTokenHash()

  const token = parseBearerToken(request)
  if (token == null) {
    throw unauthorized("unauthorized", "Not authenticated")
  }
  if (token.length < MIN_BEARER_LENGTH || token.length > MAX_BEARER_LENGTH) {
    throw unauthorized("unauthorized", "Not authenticated")
  }
  if (!BASE64URL_PATTERN.test(token)) {
    throw unauthorized("unauthorized", "Not authenticated")
  }

  const computed = createHash("sha256").update(token, "utf8").digest()
  const expected = Buffer.from(expectedHash, "hex")
  if (!timingSafeEqual(computed, expected)) {
    throw unauthorized("unauthorized", "Not authenticated")
  }
}

interface PreviewTicketPayload {
  v: number
  payloadDigest: string
  stateDigest: string
  expiresAt: number
}

/**
 * Resolve the HMAC signing key from `AUTH_SECRET`, requiring at least 32 chars.
 * Throws 503 `publisher_unavailable` when unset/malformed so preview-ticket mint
 * and verify fail closed rather than accept an unsigned or forged ticket.
 */
function authSecretBuffer(): Buffer {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw publisherUnavailable("Preview signing secret is not configured")
  }
  return Buffer.from(secret, "utf8")
}

/**
 * Build the versioned canonical payload string that is signed. Key order is
 * fixed (v, payloadDigest, stateDigest, expiresAt), so signing and verifying
 * always produce byte-identical strings.
 */
function canonicalPayload(payload: PreviewTicketPayload): string {
  return JSON.stringify({
    v: payload.v,
    payloadDigest: payload.payloadDigest,
    stateDigest: payload.stateDigest,
    expiresAt: payload.expiresAt,
  })
}

/** Encode a string or Buffer as unpadded base64url. */
function base64urlEncode(data: string | Buffer): string {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8").toString("base64url")
  }
  return data.toString("base64url")
}

/**
 * Decode an unpadded base64url part, or `null` when it is empty-invalid or uses
 * a character outside the base64url alphabet.
 */
function base64urlDecode(part: string): Buffer | null {
  if (part.length === 0) return null
  if (!BASE64URL_PATTERN.test(part)) return null
  return Buffer.from(part, "base64url")
}

/**
 * Mint a short-lived, content-bound preview ticket.
 *
 * The ticket is `base64url(canonicalPayload).base64url(HMAC-SHA256)` and is
 * bound to the given `payloadDigest` / `stateDigest`, expiring `nowMs + 5min`
 * (defaulting `nowMs` to the wall clock). The signature is keyed on `AUTH_SECRET`,
 * NOT the MCP bearer, so a publisher who knows only the bearer cannot forge a
 * ticket. Missing/malformed `AUTH_SECRET` -> 503 `publisher_unavailable`.
 */
export function issueMcpPreviewTicket(
  payloadDigest: string,
  stateDigest: string,
  nowMs?: number
): string {
  const secret = authSecretBuffer()
  const now = nowMs ?? Date.now()
  const expiresAt = now + PREVIEW_TICKET_TTL_MS
  const payload: PreviewTicketPayload = {
    v: TICKET_VERSION,
    payloadDigest,
    stateDigest,
    expiresAt,
  }
  const canonical = canonicalPayload(payload)
  const signature = createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest()
  return `${base64urlEncode(canonical)}.${base64urlEncode(signature)}`
}

/**
 * Assert that a preview ticket is authentic, live, and bound to the expected
 * payload/state digests. The HMAC signature is verified constant-time BEFORE any
 * content is accepted (length, structure, and JSON shape are extracted first so
 * the signature can be recomputed, but no expiry/content verdict is given until
 * the signature passes). Any failure - oversized ticket, malformed structure,
 * bad base64url, non-canonical JSON, wrong signature, expiry, or a
 * payload/state mismatch - throws 409 `preview_stale`. Missing/malformed
 * `AUTH_SECRET` -> 503 `publisher_unavailable`.
 */
export function verifyMcpPreviewTicket(
  ticket: string,
  payloadDigest: string,
  stateDigest: string,
  nowMs?: number
): void {
  const secret = authSecretBuffer()

  if (ticket.length > MAX_TICKET_LENGTH) {
    throw previewStale("Preview ticket is stale")
  }

  const dot = ticket.indexOf(".")
  if (dot === -1) {
    throw previewStale("Preview ticket is stale")
  }
  const payloadPart = ticket.slice(0, dot)
  const sigPart = ticket.slice(dot + 1)
  if (sigPart.includes(".")) {
    throw previewStale("Preview ticket is stale")
  }

  const payloadBuf = base64urlDecode(payloadPart)
  const sigBuf = base64urlDecode(sigPart)
  if (payloadBuf == null || sigBuf == null) {
    throw previewStale("Preview ticket is stale")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"))
  } catch {
    throw previewStale("Preview ticket is stale")
  }

  const payload = parsed as PreviewTicketPayload
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.v !== TICKET_VERSION ||
    typeof payload.payloadDigest !== "string" ||
    typeof payload.stateDigest !== "string" ||
    typeof payload.expiresAt !== "number" ||
    !Number.isFinite(payload.expiresAt)
  ) {
    throw previewStale("Preview ticket is stale")
  }

  // Verify the signature constant-time BEFORE accepting the contents.
  const canonical = canonicalPayload(payload)
  const expected = createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest()
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
    throw previewStale("Preview ticket is stale")
  }

  // Contents accepted only now: the ticket must still be live and bound to the
  // exact digests the caller is presenting.
  const now = nowMs ?? Date.now()
  if (now > payload.expiresAt) {
    throw previewStale("Preview ticket has expired")
  }
  if (payload.payloadDigest !== payloadDigest) {
    throw previewStale("Preview payload no longer matches")
  }
  if (payload.stateDigest !== stateDigest) {
    throw previewStale("Preview state no longer matches")
  }
}
