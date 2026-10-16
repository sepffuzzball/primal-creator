/**
 * Tests for scripts/mcp/catalog-server.ts - the local stdio MCP server that
 * publishes to the deployed app's managed catalog.
 *
 * These tests never open a network socket and never touch a database: every
 * `fetch` is a mock, and the functions under test are the exported helpers, not
 * the MCP stdio transport. The `serveStdio` entry point is guarded behind an
 * `isRunningAsMain()` check, so importing this module in a test does not hang.
 */

import { describe, it, expect, vi } from "vitest"
import {
  CATALOG_APPLY_PATH,
  CATALOG_ENTRY_PATH,
  CATALOG_PREVIEW_PATH,
  CATALOG_LIST_PATH,
  MAX_ENTRIES,
  MAX_STABLE_ID_LENGTH,
  CatalogApiError,
  catalogEntrySchema,
  catalogEntryListSchema,
  catalogPreview,
  catalogApply,
  catalogGet,
  catalogList,
  catalogPublish,
  createClient,
  createServer,
  parseJsonSafely,
  publishConflictMessage,
  readBodyCapped,
  renderCatalogEntry,
  renderPreviewResult,
  resolveConfig,
  validateBearerToken,
  validateCatalogUrl,
  type CatalogEntry,
  type CatalogEntryResult,
  type CatalogPreviewResult,
} from "./catalog-server"

const ORIGIN = "https://catalog.example.com"
const TOKEN = "A".repeat(43)

function validUrl(): string {
  return ORIGIN
}

function validEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    kind: "skills",
    stableId: "one-step-mile",
    name: "One Step Mile",
    ...overrides,
  } as CatalogEntry
}

// ------------------------------------------------------------------ //
// Config / URL / token validation
// ------------------------------------------------------------------ //

describe("validateCatalogUrl", () => {
  it("accepts an HTTPS origin", () => {
    const res = validateCatalogUrl("https://catalog.example.com")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.origin).toBe("https://catalog.example.com")
  })

  it("accepts an HTTPS origin with a port", () => {
    const res = validateCatalogUrl("https://catalog.example.com:8443")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.origin).toBe("https://catalog.example.com:8443")
  })

  it("rejects a non-https URL", () => {
    const res = validateCatalogUrl("http://catalog.example.com")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/https/)
  })

  it("rejects a URL with a path", () => {
    const res = validateCatalogUrl(`${ORIGIN}/api`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/origin/)
  })

  it("rejects a URL with a query string", () => {
    const res = validateCatalogUrl(`${ORIGIN}?x=1`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/origin/)
  })

  it("rejects a URL with a fragment", () => {
    const res = validateCatalogUrl(`${ORIGIN}#frag`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/origin/)
  })

  it("rejects a URL with userinfo", () => {
    const res = validateCatalogUrl("https://user:pass@catalog.example.com")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/userinfo/)
  })

  it("rejects an invalid URL", () => {
    const res = validateCatalogUrl("not a url")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not a valid URL/)
  })
})

describe("validateBearerToken", () => {
  it("accepts a 43-char base64url token", () => {
    expect(validateBearerToken("A".repeat(43)).ok).toBe(true)
  })

  it("rejects a token shorter than 43 chars", () => {
    const res = validateBearerToken("A".repeat(42))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/too short/)
  })

  it("rejects a token longer than 256 chars", () => {
    const res = validateBearerToken("A".repeat(257))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/too long/)
  })

  it("rejects a non-base64url token (includes + and =)", () => {
    const res = validateBearerToken(`${"A".repeat(21)}+${"B".repeat(21)}=`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/base64url/)
  })
})

describe("resolveConfig", () => {
  it("resolves a valid configuration", () => {
    const res = resolveConfig({
      PRIMAL_CATALOG_URL: validUrl(),
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.url).toBe(ORIGIN)
      expect(res.token).toBe(TOKEN)
    }
  })

  it("fails closed when the URL is missing", () => {
    const res = resolveConfig({ PRIMAL_CATALOG_TOKEN: TOKEN })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("PRIMAL_CATALOG_URL")
  })

  it("fails closed when the token is missing", () => {
    const res = resolveConfig({ PRIMAL_CATALOG_URL: validUrl() })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("PRIMAL_CATALOG_TOKEN")
  })

  it("fails closed on a non-https URL", () => {
    const res = resolveConfig({
      PRIMAL_CATALOG_URL: "http://catalog.example.com",
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(false)
  })

  it("never echoes the token value in an error", () => {
    const res = resolveConfig({
      PRIMAL_CATALOG_URL: "http://catalog.example.com",
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toContain(TOKEN)
  })

  it("does not log or return the token", () => {
    const res = resolveConfig({
      PRIMAL_CATALOG_URL: validUrl(),
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(true)
  })
})

// ------------------------------------------------------------------ //
// Entry schema (tool input validation)
// ------------------------------------------------------------------ //

describe("catalogEntrySchema", () => {
  it("accepts a valid entry", () => {
    const parsed = catalogEntrySchema.safeParse(validEntry())
    expect(parsed.success).toBe(true)
  })

  it("rejects an unknown field (strict schema, e.g. archived)", () => {
    const parsed = catalogEntrySchema.safeParse(
      validEntry({ archived: true } as Partial<CatalogEntry>)
    )
    expect(parsed.success).toBe(false)
  })

  it("rejects an invalid kind", () => {
    const parsed = catalogEntrySchema.safeParse(
      validEntry({ kind: "consumables" } as unknown as Partial<CatalogEntry>)
    )
    expect(parsed.success).toBe(false)
  })

  it("rejects an http sourceUrl", () => {
    const parsed = catalogEntrySchema.safeParse(
      validEntry({ sourceUrl: "http://example.com" })
    )
    expect(parsed.success).toBe(false)
  })

  it("accepts a null sourceUrl", () => {
    const parsed = catalogEntrySchema.safeParse(validEntry({ sourceUrl: null }))
    expect(parsed.success).toBe(true)
  })

  it("rejects an invalid grade", () => {
    const parsed = catalogEntrySchema.safeParse(
      validEntry({ grade: "Z" } as unknown as Partial<CatalogEntry>)
    )
    expect(parsed.success).toBe(false)
  })

  it("enforces the 50-entry batch cap", () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) =>
      validEntry({ stableId: `skill-${i}` })
    )
    expect(catalogEntryListSchema.safeParse(many).success).toBe(false)
    expect(
      catalogEntryListSchema.safeParse(many.slice(0, MAX_ENTRIES)).success
    ).toBe(true)
  })
})

// ------------------------------------------------------------------ //
// Parsing helpers
// ------------------------------------------------------------------ //

describe("parseJsonSafely", () => {
  it("parses valid JSON", () => {
    const res = parseJsonSafely('{"a":1}')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ a: 1 })
  })

  it("reports invalid JSON without throwing", () => {
    const res = parseJsonSafely("not json")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not valid JSON/)
  })
})

// ------------------------------------------------------------------ //
// Bounded body read
// ------------------------------------------------------------------ //

describe("readBodyCapped", () => {
  it("reads a body under the cap", async () => {
    const res = new Response("hello", { status: 200 })
    const text = await readBodyCapped(res, 1024)
    expect(text).toBe("hello")
  })

  it("rejects a declared Content-Length over the cap", async () => {
    const res = new Response("x".repeat(2048), { status: 200 })
    await expect(readBodyCapped(res, 1024)).rejects.toThrow(/byte cap/)
  })

  it("rejects a stream that grows past the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048))
        controller.close()
      },
    })
    const res = new Response(stream, { status: 200 })
    await expect(readBodyCapped(res, 1024)).rejects.toThrow(/byte cap/)
  })
})

// ------------------------------------------------------------------ //
// API client
// ------------------------------------------------------------------ //

interface CapturedRequest {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function captureEnv() {
  const calls: CapturedRequest[] = []
  const fetchImpl = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString()
      const headers = new Headers(init?.headers)
      let body: string | null = null
      if (typeof init?.body === "string") body = init.body
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        headers,
        body,
      })
      if (u.endsWith(CATALOG_PREVIEW_PATH)) {
        return jsonResponse(200, {
          changes: [],
          payloadDigest: "p".repeat(64),
          stateDigest: "s".repeat(64),
          previewTicket: "preview-ticket",
        })
      }
      if (u.endsWith(CATALOG_APPLY_PATH)) {
        return jsonResponse(200, {
          changes: [],
          payloadDigest: "p".repeat(64),
          stateDigest: "s".repeat(64),
        })
      }
      if (u.includes(CATALOG_ENTRY_PATH)) {
        return jsonResponse(200, { item: entryItem() })
      }
      return jsonResponse(200, [])
    }
  )
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("catalogList", () => {
  it("always includes the required kind param in the GET URL", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogList(client, { kind: "skills" })
    const req = calls[0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe(`${ORIGIN}${CATALOG_LIST_PATH}?kind=skills`)
  })

  it("rejects a missing kind locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [])
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogList(client, {} as { kind: "skills" }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/requires a valid kind/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects an invalid kind locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [])
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogList(client, {
      kind: "consumables",
    } as unknown as { kind: "skills" }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/requires a valid kind/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("appends includeArchived only when supplied", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogList(client, { kind: "skills", includeArchived: true })
    const req = calls[0]
    expect(req.url).toBe(
      `${ORIGIN}${CATALOG_LIST_PATH}?kind=skills&includeArchived=1`
    )
  })

  it("sends an Authorization bearer and an Accept header", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogList(client, { kind: "skills" })
    const headers = calls[0].headers
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("accept")).toBe("application/json")
  })

  it("uses redirect: error and a timeout signal", async () => {
    let redirect: RequestRedirect | undefined
    let signal: AbortSignal | null = null
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        redirect = init?.redirect
        signal = init?.signal ?? null
        return jsonResponse(200, [])
      }
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogList(client, { kind: "skills" })
    expect(redirect).toBe("error")
    expect(signal).not.toBeNull()
  })

  it("parses an { items } response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { items: [listItem()] })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const result = await catalogList(client, { kind: "skills" })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].stableId).toBe("one-step-mile")
  })

  it("parses an { entries } response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { entries: [listItem()] })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const result = await catalogList(client, { kind: "skills" })
    expect(result.items).toHaveLength(1)
  })

  it("surfaces a server error without echoing the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { code: "invalid_kind", message: "bad" } })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogList(client, { kind: "skills" }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(400)
    expect((err as CatalogApiError).code).toBe("invalid_kind")
    expect((err as CatalogApiError).message).not.toContain(TOKEN)
  })

  it("rejects a non-JSON response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200 })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await expect(catalogList(client, { kind: "skills" })).rejects.toThrow(
      /non-JSON/
    )
  })

  it("rejects an oversized response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x".repeat(9 * 1024 * 1024), { status: 200 })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await expect(catalogList(client, { kind: "skills" })).rejects.toThrow(
      /byte cap/
    )
  })
})

describe("catalogGet", () => {
  it("always includes the required kind and stableId params in the GET URL", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogGet(client, { kind: "skills", stableId: "one-step-mile" })
    const req = calls[0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe(
      `${ORIGIN}${CATALOG_ENTRY_PATH}?kind=skills&stableId=one-step-mile`
    )
  })

  it("rejects a missing kind locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { item: entryItem() })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogGet(client, {
      stableId: "one-step-mile",
    } as { kind: "skills"; stableId: string }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/requires a valid kind/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects an invalid kind locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { item: entryItem() })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogGet(client, {
      kind: "consumables",
      stableId: "one-step-mile",
    } as unknown as { kind: "skills"; stableId: string }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/requires a valid kind/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects an empty stableId locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { item: entryItem() })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogGet(client, {
      kind: "skills",
      stableId: "",
    }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/nonempty stableId/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects a stableId longer than 128 chars locally, before any network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { item: entryItem() })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogGet(client, {
      kind: "skills",
      stableId: "a".repeat(MAX_STABLE_ID_LENGTH + 1),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(0)
    expect((err as CatalogApiError).message).toMatch(/at most/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("sends an Authorization bearer and an Accept header", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogGet(client, { kind: "skills", stableId: "one-step-mile" })
    const headers = calls[0].headers
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("accept")).toBe("application/json")
  })

  it("parses the full { item } body and omits generated ids/timestamps", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { item: entryItem() })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const result = await catalogGet(client, {
      kind: "skills",
      stableId: "one-step-mile",
    })
    expect(result.kind).toBe("skills")
    expect(result.entry).toMatchObject({
      kind: "skills",
      stableId: "one-step-mile",
      name: "One Step Mile",
      description: "A full description",
      grade: "B",
      sourceUrl: "https://example.com",
      archived: false,
      config: { track: "race", rarity: "common" },
      gradeDescriptions: { B: "good" },
    })
    expect(result.entry).not.toHaveProperty("id")
    expect(result.entry).not.toHaveProperty("createdAt")
    expect(result.entry).not.toHaveProperty("updatedAt")
  })

  it("surfaces a 404 catalog_not_found without echoing the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: "catalog_not_found", message: "nf" } })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogGet(client, {
      kind: "skills",
      stableId: "missing",
    }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(404)
    expect((err as CatalogApiError).code).toBe("catalog_not_found")
    expect((err as CatalogApiError).message).not.toContain(TOKEN)
  })

  it("rejects a response missing `item`", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {})
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await expect(
      catalogGet(client, { kind: "skills", stableId: "one-step-mile" })
    ).rejects.toThrow(/missing `item`/)
  })
})

describe("catalogPreview", () => {
  it("POSTs { entries } and returns the preview result", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const entries = [validEntry()]
    await catalogPreview(client, entries)
    const req = calls[0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe(`${ORIGIN}${CATALOG_PREVIEW_PATH}`)
    const body = JSON.parse(req.body ?? "{}")
    expect(body.entries).toEqual(entries)
  })

  it("parses the server preview payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        changes: [change()],
        payloadDigest: "p".repeat(64),
        stateDigest: "s".repeat(64),
        previewTicket: "abc.def",
      })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const result = await catalogPreview(client, [validEntry()])
    expect(result.previewTicket).toBe("abc.def")
    expect(result.changes).toHaveLength(1)
  })

  it("parses substantive before/after field values and omits generated ids/timestamps", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        changes: [richChange()],
        payloadDigest: "p".repeat(64),
        stateDigest: "s".repeat(64),
        previewTicket: "abc.def",
      })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const result = await catalogPreview(client, [validEntry()])
    const change = result.changes[0]
    expect(change.before).toMatchObject({
      name: "Old Name",
      description: "Old description",
      grade: "C",
      sourceUrl: "https://example.com/old",
      archived: false,
      config: { track: "race", rarity: "common" },
      gradeDescriptions: { G: "good" },
    })
    expect(change.after).toMatchObject({
      name: "New Name",
      description: "New description",
      grade: "A",
      sourceUrl: "https://example.com/new",
      archived: false,
      config: { track: "race", rarity: "rare" },
      gradeDescriptions: { G: "great", S: "superb" },
    })
    // Generated ids/timestamps are stripped and never promised as exact values.
    expect(change.after).not.toHaveProperty("id")
    expect(change.after).not.toHaveProperty("createdAt")
    expect(change.after).not.toHaveProperty("updatedAt")
  })
})

describe("catalogApply", () => {
  it("POSTs { entries, previewTicket }", async () => {
    const { calls, fetchImpl } = captureEnv()
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogApply(client, [validEntry()], "ticket-1")
    const req = calls[0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe(`${ORIGIN}${CATALOG_APPLY_PATH}`)
    const body = JSON.parse(req.body ?? "{}")
    expect(body.entries).toEqual([validEntry()])
    expect(body.previewTicket).toBe("ticket-1")
  })

  it("surfaces a 409 conflict for the caller to retry", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, {
        error: { code: "preview_stale", message: "Preview ticket is stale" },
      })
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogApply(client, [validEntry()], "ticket").catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(409)
    expect((err as CatalogApiError).code).toBe("preview_stale")
  })
})

describe("catalogPublish", () => {
  it("previews to get a ticket, then applies with that ticket", async () => {
    const calls: CapturedRequest[] = []
    const previewTicket = "ticket-from-preview"
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof url === "string" ? url : url.toString()
        calls.push({
          url: u,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? init.body : null,
        })
        if (u.endsWith(CATALOG_PREVIEW_PATH)) {
          return jsonResponse(200, {
            changes: [change()],
            payloadDigest: "p".repeat(64),
            stateDigest: "s".repeat(64),
            previewTicket,
          })
        }
        if (u.endsWith(CATALOG_APPLY_PATH)) {
          return jsonResponse(200, {
            changes: [change()],
            payloadDigest: "p".repeat(64),
            stateDigest: "s".repeat(64),
          })
        }
        return jsonResponse(200, {})
      }
    ) as unknown as typeof fetch

    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    await catalogPublish(client, [validEntry()])

    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe(`${ORIGIN}${CATALOG_PREVIEW_PATH}`)
    expect(calls[1].url).toBe(`${ORIGIN}${CATALOG_APPLY_PATH}`)
    const applyBody = JSON.parse(calls[1].body ?? "{}")
    expect(applyBody.previewTicket).toBe(previewTicket)
  })

  it("re-propagates a 409 from the apply step", async () => {
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL): Promise<Response> => {
        const u = typeof url === "string" ? url : url.toString()
        if (u.endsWith(CATALOG_PREVIEW_PATH)) {
          return jsonResponse(200, {
            changes: [change()],
            payloadDigest: "p".repeat(64),
            stateDigest: "s".repeat(64),
            previewTicket: "t",
          })
        }
        return jsonResponse(409, {
          error: { code: "catalog_conflict", message: "conflicts; retry" },
        })
      }
    ) as unknown as typeof fetch
    const client = createClient({ url: ORIGIN, token: TOKEN }, { fetchImpl })
    const err = await catalogPublish(client, [validEntry()]).catch((e) => e)
    expect(err).toBeInstanceOf(CatalogApiError)
    expect((err as CatalogApiError).status).toBe(409)
  })
})

describe("publishConflictMessage", () => {
  it("tells the caller to re-preview and retry and never leaks the token", () => {
    const err = new CatalogApiError(
      "Preview ticket is stale",
      409,
      "preview_stale"
    )
    const message = publishConflictMessage(err)
    expect(message).toMatch(/re-preview and retry/)
    expect(message).toMatch(/409/)
    expect(message).not.toContain(TOKEN)
  })
})

// ------------------------------------------------------------------ //
// Rendering (catalog_get full read vs bounded preview/publish)
// ------------------------------------------------------------------ //

describe("renderCatalogEntry", () => {
  it("renders a long config JSON-stringified and untruncated in catalog_get", () => {
    const huge = "x".repeat(5000)
    const result: CatalogEntryResult = {
      kind: "skills",
      entry: {
        kind: "skills",
        stableId: "one-step-mile",
        name: "One Step Mile",
        description: "A full description",
        grade: "B",
        sourceUrl: "https://example.com",
        archived: false,
        config: { note: huge },
        gradeDescriptions: { B: "good" },
      },
    }
    const text = renderCatalogEntry(result)
    // The full 5000-char value survives; escaping is preserved as JSON.
    expect(text).toContain(`"note":"${huge}"`)
    expect(text).toContain(JSON.stringify(result.entry.gradeDescriptions))
    expect(text).not.toContain("[truncated]")
    expect(text).not.toContain("...")
  })

  it("renders a long description verbatim, preserving whitespace and untruncated", () => {
    const longDescription = "line\n".repeat(400) // > 800 chars, contains newlines
    const result: CatalogEntryResult = {
      kind: "skills",
      entry: {
        kind: "skills",
        stableId: "one-step-mile",
        name: "One Step Mile",
        description: longDescription,
        grade: "B",
        sourceUrl: "https://example.com",
        archived: false,
        config: {},
        gradeDescriptions: {},
      },
    }
    const text = renderCatalogEntry(result)
    expect(text).toContain(longDescription)
    expect(text).not.toContain("[truncated]")
  })
})

describe("renderPreviewResult", () => {
  it("marks a bounded field that was cut with [truncated], never a bare ellipsis", () => {
    const huge = "v".repeat(5000)
    const result: CatalogPreviewResult = {
      changes: [
        {
          kind: "skills",
          stableId: "one-step-mile",
          status: "update",
          changedFields: ["config"],
          before: { config: { track: "race" } },
          after: { config: { big: huge } },
        },
      ],
      payloadDigest: "p".repeat(64),
      stateDigest: "s".repeat(64),
      previewTicket: "abc.def",
    }
    const text = renderPreviewResult(result)
    expect(text).toContain("[truncated]")
    expect(text).not.toContain("...")
  })

  it("does not mark a bounded value that already fits as truncated", () => {
    const result: CatalogPreviewResult = {
      changes: [
        {
          kind: "skills",
          stableId: "one-step-mile",
          status: "create",
          changedFields: ["name"],
          after: { name: "One Step Mile" },
        },
      ],
      payloadDigest: "p".repeat(64),
      stateDigest: "s".repeat(64),
      previewTicket: "abc.def",
    }
    const text = renderPreviewResult(result)
    expect(text).not.toContain("[truncated]")
    expect(text).not.toContain("...")
  })
})

// ------------------------------------------------------------------ //
// Server construction
// ------------------------------------------------------------------ //

describe("createServer", () => {
  it("builds an MCP server even with an invalid config (fail closed)", () => {
    const server = createServer({ env: {} })
    expect(server).toBeTruthy()
  })

  it("builds an MCP server with a valid injected config", () => {
    const server = createServer({
      env: { PRIMAL_CATALOG_URL: validUrl(), PRIMAL_CATALOG_TOKEN: TOKEN },
    })
    expect(server).toBeTruthy()
  })

  it("requires a canonical kind on catalog_list input (no all-kinds default)", () => {
    const server = createServer({
      env: { PRIMAL_CATALOG_URL: validUrl(), PRIMAL_CATALOG_TOKEN: TOKEN },
    })
    const schema = server.toolInputSchemaJson("catalog_list")
    expect(schema).toBeDefined()
    const required = (schema as { required?: string[] }).required ?? []
    expect(required).toContain("kind")
  })

  it("requires kind and stableId on catalog_get input", () => {
    const server = createServer({
      env: { PRIMAL_CATALOG_URL: validUrl(), PRIMAL_CATALOG_TOKEN: TOKEN },
    })
    const schema = server.toolInputSchemaJson("catalog_get")
    expect(schema).toBeDefined()
    const required = (schema as { required?: string[] }).required ?? []
    expect(required).toContain("kind")
    expect(required).toContain("stableId")
  })
})

// local fixtures
function listItem(): Record<string, unknown> {
  return {
    id: "row-1",
    kind: "skills",
    stableId: "one-step-mile",
    name: "One Step Mile",
    description: null,
    grade: null,
    sourceUrl: "https://example.com",
    archived: false,
    config: {},
    gradeDescriptions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function entryItem(): Record<string, unknown> {
  return {
    id: "row-1",
    kind: "skills",
    stableId: "one-step-mile",
    name: "One Step Mile",
    description: "A full description",
    grade: "B",
    sourceUrl: "https://example.com",
    archived: false,
    config: { track: "race", rarity: "common" },
    gradeDescriptions: { B: "good" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function change(): Record<string, unknown> {
  return {
    kind: "skills",
    stableId: "one-step-mile",
    status: "create",
    changedFields: ["name"],
    after: { name: "One Step Mile" },
  }
}

function richChange(): Record<string, unknown> {
  return {
    kind: "skills",
    stableId: "one-step-mile",
    status: "update",
    changedFields: [
      "name",
      "description",
      "grade",
      "sourceUrl",
      "config",
      "gradeDescriptions",
    ],
    before: {
      id: "row-1",
      kind: "skills",
      stableId: "one-step-mile",
      name: "Old Name",
      description: "Old description",
      grade: "C",
      sourceUrl: "https://example.com/old",
      archived: false,
      config: { track: "race", rarity: "common" },
      gradeDescriptions: { G: "good" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    after: {
      id: "row-1",
      kind: "skills",
      stableId: "one-step-mile",
      name: "New Name",
      description: "New description",
      grade: "A",
      sourceUrl: "https://example.com/new",
      archived: false,
      config: { track: "race", rarity: "rare" },
      gradeDescriptions: { G: "great", S: "superb" },
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  }
}
