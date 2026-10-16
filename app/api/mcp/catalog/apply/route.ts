import { z } from "zod"
import { badRequest, payloadTooLarge, respond } from "@/lib/server/errors"
import { requireMcpCatalogBearer } from "@/lib/server/mcp-catalog-auth"
import {
  applyManagedCatalog,
  managedCatalogEntrySchema,
} from "@/lib/db/mcp-catalog-publish"

export const runtime = "nodejs"

/**
 * Apply `Cache-Control: no-store` to a response (including an error response)
 * so neither the browser nor a shared proxy caches publisher catalog data.
 */
function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/** Hard cap on the raw UTF8 request body (1 MiB), enforced while reading the stream. */
const MAX_REQUEST_BYTES = 1024 * 1024

/** Upper bound on a `previewTicket` string supplied to apply (route-level input cap). */
const MAX_REQUEST_TICKET_LENGTH = 2048

/**
 * POST body shape, authoritative in this module: exactly `{ entries,
 * previewTicket }` where each entry is a `managedCatalogEntrySchema` and
 * `previewTicket` is a nonempty string at most 2048 chars. `.strict()` rejects an
 * unknown key.
 */
const applyBodySchema = z
  .object({
    entries: z.array(managedCatalogEntrySchema),
    previewTicket: z.string().min(1).max(MAX_REQUEST_TICKET_LENGTH),
  })
  .strict()

/**
 * Read the request body as UTF8 with a hard 1 MiB cap enforced WHILE draining the
 * stream (never by buffering the whole request first). A trusted oversized
 * `Content-Length` is rejected up front so an obviously large body is not read
 * at all; a missing/bogus Content-Length falls back to the streamed cap.
 */
async function readBody(req: Request): Promise<string> {
  const declared = req.headers.get("content-length")
  if (declared != null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
      throw payloadTooLarge(
        "payload_too_large",
        "Request body exceeds the 1MiB limit"
      )
    }
  }

  const reader = req.body?.getReader()
  if (!reader) return ""

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw payloadTooLarge(
        "payload_too_large",
        "Request body exceeds the 1MiB limit"
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
  return new TextDecoder().decode(merged)
}

/**
 * POST /api/mcp/catalog/apply
 *
 * Publisher-only atomic apply of a managed catalog batch. Requires a valid
 * publisher bearer (no cookie fallback). Body `{ entries: ManagedCatalogEntry[],
 * previewTicket: string }`. Calls `applyManagedCatalog`, which enters one
 * SERIALIZABLE transaction, verifies the content-bound ticket BEFORE any write,
 * then commits all writes or none. Never writes a row for an unchanged entry and
 * never partially commits; a concurrent change surfaces as 409 `catalog_conflict`.
 */
export async function POST(req: Request): Promise<Response> {
  return withNoStore(
    await respond(async () => {
      await requireMcpCatalogBearer(req)

      const raw = await readBody(req)
      let body: unknown
      try {
        body = raw.length ? JSON.parse(raw) : undefined
      } catch {
        throw badRequest("validation", "Request body is not valid JSON")
      }
      const parsed = applyBodySchema.safeParse(body)
      if (!parsed.success) {
        throw badRequest("validation", "Invalid managed catalog apply payload")
      }

      const result = await applyManagedCatalog(
        parsed.data.entries,
        parsed.data.previewTicket
      )
      return Response.json(result)
    })
  )
}
