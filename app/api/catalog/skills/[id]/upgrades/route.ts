import { requireAdmin } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { skillUpgradeCloneSchema } from "@/lib/server/schemas"
import { createSkillUpgradeVariant } from "@/lib/db/service"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/catalog/skills/[id]/upgrades
 *
 * Admin-only. Clones the ACTIVE `skills` catalog entry identified by `[id]` into a
 * full mechanical copy at the requested `rarity` (the body's `rarity`), and links
 * it as a DIRECT successor of the source, all inside one SERIALIZABLE transaction
 * so a failure never leaves an orphan clone or a half-linked source.
 *
 * Body (`skillUpgradeCloneSchema`):
 *   - `rarity` (required): one of Inferior..Divine or `Unique` (the shared rarity
 *     vocabulary the source config itself uses).
 *   - `name` (optional): override the clone's display name (defaults to the source
 *     name), trimmed, nonempty, at most 200 chars. Overriding the name also
 *     changes the derived stableId slug.
 *
 * Returns 201 with `{ source, item }` where `source` is the linked predecessor
 * (its `config.upgradeToStableIds` now includes the clone) and `item` is the new
 * clone. See `createSkillUpgradeVariant` in lib/db/service.ts for the exact
 * cloning and linking semantics.
 */
export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    await requireAdmin(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const parsed = skillUpgradeCloneSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        "validation",
        "Invalid skill upgrade clone payload (rarity is required; name, when given, must be a nonempty string of at most 200 characters)"
      )
    }
    const { source, item } = await createSkillUpgradeVariant(id, parsed.data)
    return Response.json({ source, item }, { status: 201 })
  })
}
