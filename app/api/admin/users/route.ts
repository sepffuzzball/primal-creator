import { requireAdmin } from "@/lib/auth/guard"
import { createUser, listUsers } from "@/lib/db/user-service"
import { badRequest, respond } from "@/lib/server/errors"
import { adminUserCreateSchema } from "@/lib/server/schemas"

export const runtime = "nodejs"

/**
 * Admin-managed user list/create.
 *
 * There is no public registration: only an admin may create a user. GET lists every
 * user (never returning a password hash); POST accepts {email, password, isAdmin?},
 * normalizes the email to lowercase (duplicates 409), hashes the password with
 * bcrypt cost 12, and requires a password of at least 12 characters.
 */
export async function GET(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const users = await listUsers()
    return Response.json({ users })
  })
}

export async function POST(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const body = await req.json().catch(() => null)
    const parsed = adminUserCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        "validation",
        "Provide a valid email and a password (at least 12 characters)"
      )
    }
    const user = await createUser(parsed.data)
    return Response.json({ user }, { status: 201 })
  })
}
