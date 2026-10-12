import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { characterCreateSchema } from "@/lib/server/schemas"
import { createCharacter, listCharacters } from "@/lib/db/service"

export const runtime = "nodejs"

function truthy(value: string | null): boolean {
  if (!value) return false
  return value === "1" || value.toLowerCase() === "true" || value === "yes"
}

export async function GET(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const url = new URL(req.url)
    const withStatus = truthy(url.searchParams.get("withStatus"))
    const includeArchived = truthy(url.searchParams.get("archived"))
    const characters = await listCharacters(user, {
      withStatus,
      includeArchived,
    })
    return Response.json({ characters })
  })
}

export async function POST(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const body = await req.json().catch(() => null)
    const parsed = characterCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid character payload")
    }
    const character = await createCharacter(parsed.data, user)
    return Response.json({ character }, { status: 201 })
  })
}
