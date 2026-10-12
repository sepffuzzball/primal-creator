import { getSessionUser } from "@/lib/auth/session"
import { respond, unauthorized } from "@/lib/server/errors"

export const runtime = "nodejs"

export async function GET(req: Request) {
  return respond(async () => {
    const user = await getSessionUser(req)
    if (!user) throw unauthorized()
    return Response.json({ user })
  })
}
