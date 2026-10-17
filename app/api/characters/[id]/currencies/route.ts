import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { currencyBalancePatchSchema } from "@/lib/server/schemas"
import {
  getCharacterCurrencies,
  setCharacterCurrencyBalance,
} from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const { currencies, version } = await getCharacterCurrencies(id, user)
    return Response.json({ currencies, version })
  })
}

export async function PATCH(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = currencyBalancePatchSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid currency balance payload")
    }
    const { version } = await setCharacterCurrencyBalance(id, parsed.data, user)
    return Response.json({ version })
  })
}
