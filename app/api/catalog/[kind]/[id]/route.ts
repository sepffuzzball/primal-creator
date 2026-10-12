import { requireAdmin, requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { catalogKindSchema, catalogUpdateSchema } from "@/lib/server/schemas"
import { isCatalogPublic } from "@/lib/server/env"
import { getCatalogItem, updateCatalogItem } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ kind: string; id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const { kind, id } = await ctx.params
    const parsed = catalogKindSchema.safeParse(kind)
    if (!parsed.success)
      throw badRequest("invalid_kind", `Unknown catalog kind "${kind}"`)
    if (!isCatalogPublic()) await requireUser(req)
    const item = await getCatalogItem(kind, id)
    return Response.json({ item })
  })
}

export async function PATCH(req: Request, ctx: Ctx) {
  return respond(async () => {
    await requireAdmin(req)
    const { kind, id } = await ctx.params
    const parsedKind = catalogKindSchema.safeParse(kind)
    if (!parsedKind.success)
      throw badRequest("invalid_kind", `Unknown catalog kind "${kind}"`)
    const body = await req.json().catch(() => null)
    const parsed = catalogUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid catalog update payload")
    }
    const item = await updateCatalogItem(kind, id, parsed.data)
    return Response.json({ item })
  })
}
