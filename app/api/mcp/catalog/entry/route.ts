import { badRequest, respond } from "@/lib/server/errors"
import { requireMcpCatalogBearer } from "@/lib/server/mcp-catalog-auth"
import { catalogKindSchema } from "@/lib/server/schemas"
import { getMcpCatalogEntry } from "@/lib/db/service"

export const runtime = "nodejs"

/** Upper bound on the `stableId` query value; rejects pathological unbounded input. */
const MAX_STABLE_ID_LENGTH = 128

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

/**
 * GET /api/mcp/catalog/entry?kind=<canonical catalogKindSchema>&stableId=<nonempty <=128>
 *
 * Publisher-only read of ONE full catalog definition. Auth requires
 * `Authorization: Bearer <token>` whose sha256 equals `MCP_CATALOG_TOKEN_SHA256`;
 * there is NO cookie/Origin fallback, so a session cookie alone is rejected here.
 * `kind` must be a canonical `catalogKindSchema` value (the legacy `consumables`
 * alias is NOT accepted) and `stableId` must be a nonempty string at most 128
 * chars. A matching row returns `{ item }` with the full catalog content - the
 * shared `catalogItem` shape including `config`, `description` and
 * `gradeDescriptions`, plus `archived`. A missing (kind, stableId) pair returns
 * 404 `catalog_not_found`. This is read-only and never rewrites catalog rows.
 */
export async function GET(req: Request): Promise<Response> {
  return withNoStore(
    await respond(async () => {
      await requireMcpCatalogBearer(req)
      const url = new URL(req.url)
      const rawKind = url.searchParams.get("kind")
      const parsedKind = catalogKindSchema.safeParse(rawKind)
      if (!parsedKind.success) {
        throw badRequest("invalid_kind", `Unknown catalog kind "${rawKind}"`)
      }
      const kind = parsedKind.data
      const stableId = url.searchParams.get("stableId")
      if (stableId == null || stableId.length === 0) {
        throw badRequest("invalid_stable_id", "stableId is required")
      }
      if (stableId.length > MAX_STABLE_ID_LENGTH) {
        throw badRequest(
          "invalid_stable_id",
          `stableId must be at most ${MAX_STABLE_ID_LENGTH} characters`
        )
      }
      const item = await getMcpCatalogEntry(kind, stableId)
      return Response.json({ item })
    })
  )
}
