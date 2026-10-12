import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { characterUpdateSchema } from "@/lib/server/schemas"
import {
  archiveCharacter,
  getCharacter,
  updateCharacter,
} from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const character = await getCharacter(id, user, { withStatus: true })
    return Response.json({ character })
  })
}

export async function PATCH(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = characterUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid character update payload")
    }
    const character = await updateCharacter(id, parsed.data, user)
    return Response.json({ character })
  })
}

export async function DELETE(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const character = await archiveCharacter(id, user)
    return Response.json({ character })
  })
}
