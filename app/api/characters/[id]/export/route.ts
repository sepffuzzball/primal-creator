import { requireUser } from "@/lib/auth/guard"
import { respond } from "@/lib/server/errors"
import { exportCharacter } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const portable = await exportCharacter(id, user)
    return Response.json(portable)
  })
}
