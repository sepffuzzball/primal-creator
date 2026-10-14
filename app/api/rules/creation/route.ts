import { requireUser } from "@/lib/auth/guard"
import { prisma } from "@/lib/db/client"
import { loadHouseRules } from "@/lib/db/ruleset"
import { respond } from "@/lib/server/errors"

export const runtime = "nodejs"

/**
 * Creation-scoped house rules (authenticated user).
 *
 * GET returns ONLY `{ maxTranscendentSkills }` from the persisted server-wide
 * house-rules row, so the character-creation wizard can enforce the configured
 * transcendent-skill cap client-side. Only the field the wizard needs is
 * exposed; the rest of the house-rules config stays an admin-only concern.
 *
 * Auth is required (the wizard is a signed-in feature), and the row is loaded
 * through `loadHouseRules`, so a missing `house_rules` row is still a 503
 * `ruleset_unavailable` - the app never falls back to an in-memory default.
 */
export async function GET(req: Request) {
  return respond(async () => {
    await requireUser(req)
    const houseRules = await loadHouseRules(prisma)
    return Response.json({
      maxTranscendentSkills: houseRules.config.maxTranscendentSkills,
    })
  })
}
