import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { consumeSchema } from "@/lib/server/schemas"
import { consumeCharacter } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = consumeSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid consume payload")
    }
    const { character, status, event } = await consumeCharacter(
      id,
      parsed.data,
      user
    )
    return Response.json({ character, status, event })
  })
}
