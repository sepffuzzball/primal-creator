import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { evolveSchema } from "@/lib/server/schemas"
import { evolveCharacter } from "@/lib/db/service"
import type { EvolveCharacterInput } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = evolveSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid evolution payload")
    }
    const { character, journal } = await evolveCharacter(
      id,
      parsed.data as EvolveCharacterInput,
      user
    )
    return Response.json({ character, journal })
  })
}
