import { requireUser } from "@/lib/auth/guard"
import { respond } from "@/lib/server/errors"
import { refreshPendingSkillOffers } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const { character } = await refreshPendingSkillOffers(id, user)
    return Response.json({ character })
  })
}
