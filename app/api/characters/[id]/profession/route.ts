import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { professionSetSchema } from "@/lib/server/schemas"
import { setCharacterProfession } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = professionSetSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid profession payload")
    }
    const { character } = await setCharacterProfession(id, parsed.data, user)
    return Response.json({ character })
  })
}
