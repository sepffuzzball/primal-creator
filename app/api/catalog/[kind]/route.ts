import { requireAdmin, requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { catalogCreateSchema, catalogKindSchema } from "@/lib/server/schemas"
import { isCatalogPublic } from "@/lib/server/env"
import { createCatalogItem, listCatalog } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ kind: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const { kind } = await ctx.params
    const parsed = catalogKindSchema.safeParse(kind)
    if (!parsed.success)
      throw badRequest("invalid_kind", `Unknown catalog kind "${kind}"`)
    const includeArchived =
      new URL(req.url).searchParams.get("includeArchived") === "1"
    if (includeArchived) {
      await requireAdmin(req)
    } else if (!isCatalogPublic()) {
      await requireUser(req)
    }
    const items = await listCatalog(kind, { includeArchived })
    return Response.json({ kind, items })
  })
}

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    await requireAdmin(req)
    const { kind } = await ctx.params
    const parsedKind = catalogKindSchema.safeParse(kind)
    if (!parsedKind.success)
      throw badRequest("invalid_kind", `Unknown catalog kind "${kind}"`)
    const body = await req.json().catch(() => null)
    const parsed = catalogCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid catalog payload")
    }
    const item = await createCatalogItem(kind, parsed.data)
    return Response.json({ item }, { status: 201 })
  })
}
