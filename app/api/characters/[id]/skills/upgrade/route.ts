import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { skillUpgradeSchema } from "@/lib/server/schemas"
import { upgradeSkill } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = skillUpgradeSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid skill upgrade payload")
    }
    const { character } = await upgradeSkill(id, parsed.data, user)
    return Response.json({ character })
  })
}
