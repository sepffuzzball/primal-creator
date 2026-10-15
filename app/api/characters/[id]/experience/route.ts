import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { experienceSchema } from "@/lib/server/schemas"
import { experienceCharacter } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = experienceSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid experience payload")
    }
    const { character, journal } = await experienceCharacter(
      id,
      parsed.data,
      user
    )
    return Response.json({ character, journal })
  })
}
