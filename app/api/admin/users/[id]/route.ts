import { requireAdmin } from "@/lib/auth/guard"
import { updateUser } from "@/lib/db/user-service"
import { badRequest, respond } from "@/lib/server/errors"
import { adminUserPatchSchema } from "@/lib/server/schemas"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * Admin user patch.
 *
 * Admin only. Body is {isAdmin?, disabled?, password?} with at least one property.
 * Role/disable/password changes bump `sessionVersion`, so the target user's
 * existing tokens are revoked immediately. The password hash is never returned.
 * The last enabled admin and self-demotion guards are enforced in the service.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  return respond(async () => {
    const actor = await requireAdmin(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = adminUserPatchSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        "validation",
        "Provide at least one of isAdmin, disabled, or a new password (at least 12 characters)"
      )
    }
    const user = await updateUser(id, parsed.data, actor)
    return Response.json({ user })
  })
}
