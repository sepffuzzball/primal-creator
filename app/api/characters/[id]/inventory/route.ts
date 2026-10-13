import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { inventoryPostSchema } from "@/lib/server/schemas"
import {
  adjustCharacterInventory,
  getCharacterInventory,
} from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const { inventory, version } = await getCharacterInventory(id, user)
    return Response.json({ inventory, version })
  })
}

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = inventoryPostSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid inventory payload")
    }
    const { character, inventory, version } = await adjustCharacterInventory(
      id,
      parsed.data,
      user
    )
    return Response.json({ character, inventory, version })
  })
}
