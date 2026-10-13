import { requireUser } from "@/lib/auth/guard"
import { respond } from "@/lib/server/errors"
import { getEvolutionOptions } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

// Optional `?track=race|class|profession` query param. Defaults to race for
// backwards compatibility; an unknown value is ignored (falls back to race).
const TRACK_QUERY = new Set(["race", "class", "profession"])

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const url = new URL(req.url)
    const requested = url.searchParams.get("track") ?? "race"
    const track = TRACK_QUERY.has(requested) ? requested : "race"
    const result = await getEvolutionOptions(
      id,
      user,
      track as "race" | "class" | "profession"
    )
    return Response.json(result)
  })
}
