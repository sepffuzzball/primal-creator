import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { advanceSchema } from "@/lib/server/schemas"
import { advanceCharacter } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = advanceSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid advance payload")
    }
    const { character, journal } = await advanceCharacter(id, parsed.data, user)
    return Response.json({ character, journal })
  })
}
