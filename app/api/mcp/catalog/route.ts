import { badRequest, respond } from "@/lib/server/errors"
import { requireMcpCatalogBearer } from "@/lib/server/mcp-catalog-auth"
import { catalogKindSchema } from "@/lib/server/schemas"
import { listMcpCatalogSummaries } from "@/lib/db/service"

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

/**
 * GET /api/mcp/catalog?kind=<canonical catalogKindSchema>&includeArchived=0|1
 *
 * Publisher-only catalog listing. Auth requires `Authorization: Bearer <token>`
 * whose sha256 equals `MCP_CATALOG_TOKEN_SHA256`; there is NO cookie/Origin
 * fallback, so a session cookie alone is rejected here. `kind` must be a
 * canonical `catalogKindSchema` value - the legacy `consumables` alias is NOT
 * accepted. Active entries are returned by default; `includeArchived=1`
 * additionally returns archived entries for discovery. The `items` are
 * lightweight summaries (kind/stableId/name/grade/sourceUrl/archived) - never the
 * heavy `config` / `description` / `gradeDescriptions` payload - so a large
 * catalog can be browsed without downloading every definition. Full content for a
 * single entry is read via `/api/mcp/catalog/entry`.
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
      const includeArchived = url.searchParams.get("includeArchived") === "1"
      const items = await listMcpCatalogSummaries(kind, includeArchived)
      return Response.json({ kind, items })
    })
  )
}
