/**
 * Tests for lib/server/mcp-catalog-auth.ts
 *
 * Covers the fail-closed publisher bearer gate and the short-lived,
 * content-bound preview tickets: valid round-trips, wrong/expired/altered/missing
 * failures, config fail-closed behavior, cookie-only rejection, that no raw
 * token/hash/secret leaks into error messages, HMAC binding of payload+state,
 * and that the test environment is restored after every test.
 */

import { createHash, createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  issueMcpPreviewTicket,
  requireMcpCatalogBearer,
  verifyMcpPreviewTicket,
  PREVIEW_TICKET_TTL_MS,
  MAX_TICKET_LENGTH,
} from "@/lib/server/mcp-catalog-auth"

const AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars-long!!"

// A base64url token that legally contains `-` and `_` (43 chars = 256 bits),
// proving the charset gate accepts the full unpadded base64url alphabet.
const BEARER_TOKEN = "A".repeat(19) + "-" + "B".repeat(19) + "_" + "C".repeat(3)
const TOKEN_HASH = createHash("sha256")
  .update(BEARER_TOKEN, "utf8")
  .digest("hex")

const PAYLOAD_DIGEST = "a".repeat(64)
const STATE_DIGEST = "b".repeat(64)

// ------------------------------------------------------------------ //
// Environment capture / restore helpers
// ------------------------------------------------------------------ //

type EnvSnapshot = { auth: string | undefined; hash: string | undefined }

function snapshotEnv(): EnvSnapshot {
  return {
    auth: process.env.AUTH_SECRET,
    hash: process.env.MCP_CATALOG_TOKEN_SHA256,
  }
}

function applySnapshot(snap: EnvSnapshot): void {
  if (snap.auth === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = snap.auth
  if (snap.hash === undefined) delete process.env.MCP_CATALOG_TOKEN_SHA256
  else process.env.MCP_CATALOG_TOKEN_SHA256 = snap.hash
}

const originalSnapshot = snapshotEnv()

beforeEach(() => {
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.MCP_CATALOG_TOKEN_SHA256 = TOKEN_HASH
})

afterEach(() => {
  applySnapshot(originalSnapshot)
})

// ------------------------------------------------------------------ //
// Request / error helpers
// ------------------------------------------------------------------ //

function bearerRequest(
  token: string | null,
  cookie?: string,
  origin?: string
): Request {
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (cookie) headers.cookie = cookie
  if (origin) headers.origin = origin
  return new Request("http://localhost/api/mcp/catalog", { headers })
}

function rawAuthRequest(header: string): Request {
  return new Request("http://localhost/api/mcp/catalog", {
    headers: { authorization: header },
  })
}

function expectError(fn: () => void, status: number, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toMatchObject({ status, code })
}

function captureError(fn: () => void): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected a thrown error but none was thrown")
}

// ------------------------------------------------------------------ //
// requireMcpCatalogBearer
// ------------------------------------------------------------------ //

describe("requireMcpCatalogBearer", () => {
  it("admits a request with a valid bearer token", () => {
    expect(() =>
      requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN))
    ).not.toThrow()
  })

  it("rejects a missing Authorization header with 401", () => {
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(null)),
      401,
      "unauthorized"
    )
  })

  it("rejects a non-bearer auth scheme with 401", () => {
    expectError(
      () => requireMcpCatalogBearer(rawAuthRequest("Basic Zm9vOmJhcg==")),
      401,
      "unauthorized"
    )
  })

  it("rejects a 'Bearer' header with no token with 401", () => {
    expectError(
      () => requireMcpCatalogBearer(rawAuthRequest("Bearer")),
      401,
      "unauthorized"
    )
    expectError(
      () => requireMcpCatalogBearer(rawAuthRequest("Bearer  ")),
      401,
      "unauthorized"
    )
  })

  it("admits a case-insensitive bearer scheme", () => {
    expect(() =>
      requireMcpCatalogBearer(rawAuthRequest(`bearer ${BEARER_TOKEN}`))
    ).not.toThrow()
  })

  it("rejects a wrong bearer token with 401", () => {
    expectError(
      () => requireMcpCatalogBearer(bearerRequest("B".repeat(43))),
      401,
      "unauthorized"
    )
  })

  it("rejects a bearer shorter than 43 chars even when its hash matches", () => {
    const short = "A".repeat(42)
    process.env.MCP_CATALOG_TOKEN_SHA256 = createHash("sha256")
      .update(short, "utf8")
      .digest("hex")
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(short)),
      401,
      "unauthorized"
    )
  })

  it("rejects a bearer longer than 256 chars even when its hash matches", () => {
    const long = "A".repeat(257)
    process.env.MCP_CATALOG_TOKEN_SHA256 = createHash("sha256")
      .update(long, "utf8")
      .digest("hex")
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(long)),
      401,
      "unauthorized"
    )
  })

  it.each([
    ["a standard-base64 + character", "A".repeat(42) + "+"],
    ["base64 padding =", "A".repeat(43) + "="],
  ])(
    "rejects a bearer with a non-base64url character (%s) even when its hash matches",
    (_label, token) => {
      process.env.MCP_CATALOG_TOKEN_SHA256 = createHash("sha256")
        .update(token, "utf8")
        .digest("hex")
      expectError(
        () => requireMcpCatalogBearer(bearerRequest(token)),
        401,
        "unauthorized"
      )
    }
  )
})

describe("requireMcpCatalogBearer config fail-closed", () => {
  it("returns 503 publisher_unavailable when MCP_CATALOG_TOKEN_SHA256 is unset (even with a valid bearer)", () => {
    delete process.env.MCP_CATALOG_TOKEN_SHA256
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN)),
      503,
      "publisher_unavailable"
    )
  })

  it("returns 503 publisher_unavailable when MCP_CATALOG_TOKEN_SHA256 is too short", () => {
    process.env.MCP_CATALOG_TOKEN_SHA256 = "abc"
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN)),
      503,
      "publisher_unavailable"
    )
  })

  it("returns 503 publisher_unavailable for an uppercase hash (not lowercase hex)", () => {
    process.env.MCP_CATALOG_TOKEN_SHA256 = TOKEN_HASH.toUpperCase()
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN)),
      503,
      "publisher_unavailable"
    )
  })

  it("returns 503 publisher_unavailable for a non-hex character in the hash", () => {
    process.env.MCP_CATALOG_TOKEN_SHA256 = "g".repeat(64)
    expectError(
      () => requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN)),
      503,
      "publisher_unavailable"
    )
  })
})

describe("requireMcpCatalogBearer cookie-only", () => {
  it("rejects a request that only carries a session cookie (no bearer) with 401, ignoring Origin", () => {
    expectError(
      () =>
        requireMcpCatalogBearer(
          bearerRequest(null, "primal_session=whatever", "http://localhost")
        ),
      401,
      "unauthorized"
    )
  })
})

describe("requireMcpCatalogBearer no token in errors", () => {
  it("does not leak the bearer token or its hash in a 401 message", () => {
    const err = captureError(() =>
      requireMcpCatalogBearer(bearerRequest("B".repeat(43)))
    ) as { message: string }
    expect(err.message).not.toContain(BEARER_TOKEN)
    expect(err.message).not.toContain(TOKEN_HASH)
  })

  it("does not leak the configured hash in a 503 message", () => {
    delete process.env.MCP_CATALOG_TOKEN_SHA256
    const err = captureError(() =>
      requireMcpCatalogBearer(bearerRequest(BEARER_TOKEN))
    ) as { message: string }
    expect(err.message).not.toContain(TOKEN_HASH)
    expect(err.message).not.toContain(BEARER_TOKEN)
  })
})

// ------------------------------------------------------------------ //
// Preview tickets
// ------------------------------------------------------------------ //

describe("issueMcpPreviewTicket / verifyMcpPreviewTicket", () => {
  it("round-trips a valid ticket bound to the given digests", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expect(ticket).toContain(".")
    const [payloadPart, sigPart] = ticket.split(".")
    expect(payloadPart.length).toBeGreaterThan(0)
    expect(sigPart.length).toBeGreaterThan(0)
    expect(() =>
      verifyMcpPreviewTicket(ticket, PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    ).not.toThrow()
  })

  it("rejects a ticket at/after its expiry with 409 preview_stale", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expectError(
      () =>
        verifyMcpPreviewTicket(
          ticket,
          PAYLOAD_DIGEST,
          STATE_DIGEST,
          1000 + PREVIEW_TICKET_TTL_MS + 1
        ),
      409,
      "preview_stale"
    )
  })

  it("accepts a ticket right up to (but not past) its expiry", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expect(() =>
      verifyMcpPreviewTicket(
        ticket,
        PAYLOAD_DIGEST,
        STATE_DIGEST,
        1000 + PREVIEW_TICKET_TTL_MS
      )
    ).not.toThrow()
  })

  it("rejects a ticket with a tampered signature with 409 preview_stale", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    const [payloadPart, sigPart] = ticket.split(".")
    const altered = payloadPart + "." + mutateBase64url(sigPart)
    expectError(
      () => verifyMcpPreviewTicket(altered, PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket whose payload digest was altered inside the payload (signature mismatch)", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    const [payloadPart, sigPart] = ticket.split(".")
    const decoded = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    ) as { payloadDigest: string }
    decoded.payloadDigest = "x".repeat(64)
    const newPayloadPart = Buffer.from(JSON.stringify(decoded)).toString(
      "base64url"
    )
    const altered = `${newPayloadPart}.${sigPart}`
    expectError(
      () => verifyMcpPreviewTicket(altered, PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket whose payload digest does not match the expected value with 409", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expectError(
      () => verifyMcpPreviewTicket(ticket, "x".repeat(64), STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket whose state digest does not match the expected value with 409", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expectError(
      () =>
        verifyMcpPreviewTicket(ticket, PAYLOAD_DIGEST, "y".repeat(64), 1000),
      409,
      "preview_stale"
    )
  })

  it("cannot be forged using only the MCP bearer as the HMAC key", () => {
    const now = 1000
    const expiresAt = now + PREVIEW_TICKET_TTL_MS
    const canonical = JSON.stringify({
      v: 1,
      payloadDigest: PAYLOAD_DIGEST,
      stateDigest: STATE_DIGEST,
      expiresAt,
    })
    // Signed with the bearer (which a publisher knows), NOT with AUTH_SECRET.
    const signature = createHmac("sha256", BEARER_TOKEN)
      .update(canonical, "utf8")
      .digest()
    const forged = `${Buffer.from(canonical, "utf8").toString("base64url")}.${signature.toString("base64url")}`
    expectError(
      () => verifyMcpPreviewTicket(forged, PAYLOAD_DIGEST, STATE_DIGEST, now),
      409,
      "preview_stale"
    )
  })

  it("rejects a malformed ticket with no separator with 409", () => {
    expectError(
      () =>
        verifyMcpPreviewTicket(
          "justonepart",
          PAYLOAD_DIGEST,
          STATE_DIGEST,
          1000
        ),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket with more than one separator with 409", () => {
    expectError(
      () => verifyMcpPreviewTicket("a.b.c", PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket whose signature part is not base64url with 409", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    const [payloadPart] = ticket.split(".")
    expectError(
      () =>
        verifyMcpPreviewTicket(
          `${payloadPart}.!!!`,
          PAYLOAD_DIGEST,
          STATE_DIGEST,
          1000
        ),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket whose decoded payload is not valid JSON with 409", () => {
    const payloadPart = Buffer.from("not-json").toString("base64url")
    const sigPart = "B".repeat(43)
    expectError(
      () =>
        verifyMcpPreviewTicket(
          `${payloadPart}.${sigPart}`,
          PAYLOAD_DIGEST,
          STATE_DIGEST,
          1000
        ),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket carrying an unexpected version with 409", () => {
    const payloadPart = Buffer.from(
      JSON.stringify({
        v: 2,
        payloadDigest: PAYLOAD_DIGEST,
        stateDigest: STATE_DIGEST,
        expiresAt: 1000 + PREVIEW_TICKET_TTL_MS,
      })
    ).toString("base64url")
    const sigPart = "B".repeat(43)
    expectError(
      () =>
        verifyMcpPreviewTicket(
          `${payloadPart}.${sigPart}`,
          PAYLOAD_DIGEST,
          STATE_DIGEST,
          1000
        ),
      409,
      "preview_stale"
    )
  })

  it("rejects an oversized ticket with 409 preview_stale", () => {
    const oversized = `${"A".repeat(MAX_TICKET_LENGTH)}.${"B".repeat(43)}`
    expectError(
      () =>
        verifyMcpPreviewTicket(oversized, PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })
})

describe("preview ticket config fail-closed", () => {
  it("returns 503 publisher_unavailable on issue when AUTH_SECRET is unset", () => {
    delete process.env.AUTH_SECRET
    expectError(
      () => issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      503,
      "publisher_unavailable"
    )
  })

  it("returns 503 publisher_unavailable on verify when AUTH_SECRET is unset", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    delete process.env.AUTH_SECRET
    expectError(
      () => verifyMcpPreviewTicket(ticket, PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      503,
      "publisher_unavailable"
    )
  })

  it("returns 503 publisher_unavailable when AUTH_SECRET is shorter than 32 chars", () => {
    process.env.AUTH_SECRET = "too-short"
    expectError(
      () => issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000),
      503,
      "publisher_unavailable"
    )
  })
})

describe("preview ticket config fail-closed no secret in errors", () => {
  it("does not leak AUTH_SECRET in a 503 message", () => {
    delete process.env.AUTH_SECRET
    const err = captureError(() =>
      issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    ) as { message: string }
    expect(err.message).not.toContain(AUTH_SECRET)
  })
})

describe("HMAC binding of payload and state", () => {
  it("rejects a ticket re-bound to a different payload digest", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expectError(
      () => verifyMcpPreviewTicket(ticket, "z".repeat(64), STATE_DIGEST, 1000),
      409,
      "preview_stale"
    )
  })

  it("rejects a ticket re-bound to a different state digest", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expectError(
      () =>
        verifyMcpPreviewTicket(ticket, PAYLOAD_DIGEST, "z".repeat(64), 1000),
      409,
      "preview_stale"
    )
  })

  it("accepts only the exact digest pair it was issued for", () => {
    const ticket = issueMcpPreviewTicket(PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    expect(() =>
      verifyMcpPreviewTicket(ticket, PAYLOAD_DIGEST, STATE_DIGEST, 1000)
    ).not.toThrow()
  })
})

// ------------------------------------------------------------------ //
// Test environment restoration
// ------------------------------------------------------------------ //

describe("test environment restoration", () => {
  it("restores a previously-unset key by deleting it (never leaves a stale default)", () => {
    const snap: EnvSnapshot = { auth: undefined, hash: "a".repeat(64) }
    process.env.AUTH_SECRET = "stale"
    process.env.MCP_CATALOG_TOKEN_SHA256 = "stale"
    applySnapshot(snap)
    expect(process.env.AUTH_SECRET).toBeUndefined()
    expect(process.env.MCP_CATALOG_TOKEN_SHA256).toBe("a".repeat(64))
  })

  it("restores set keys to their captured values and deletes unset ones", () => {
    const snap: EnvSnapshot = { auth: "original-secret-value", hash: undefined }
    process.env.AUTH_SECRET = "changed"
    process.env.MCP_CATALOG_TOKEN_SHA256 = "changed"
    applySnapshot(snap)
    expect(process.env.AUTH_SECRET).toBe("original-secret-value")
    expect(process.env.MCP_CATALOG_TOKEN_SHA256).toBeUndefined()
  })
})

/** Replace the final base64url character with a different one, yielding a valid (but wrong) signature. */
function mutateBase64url(value: string): string {
  const last = value[value.length - 1]
  const replacement = last === "A" ? "B" : "A"
  return value.slice(0, -1) + replacement
}
