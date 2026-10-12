import { requireUser } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import { draftPutSchema } from "@/lib/server/draft-schema"
import { deleteDraft, getDraft, saveDraft } from "@/lib/db/draft-service"

export const runtime = "nodejs"

function draftPayload(draft: {
  id: string
  data: unknown
  version: number
  updatedAt: string
}) {
  return {
    id: draft.id,
    data: draft.data,
    version: draft.version,
    updatedAt: draft.updatedAt,
  }
}

/**
 * Read the authenticated user's resumable draft. Returns `{ draft: null }` when
 * none exists. Owner-scoped: the draft is keyed by the caller's userId, so there
 * is no public read.
 */
export async function GET(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const draft = await getDraft(user)
    return Response.json({ draft: draft ? draftPayload(draft) : null })
  })
}

/**
 * Create or update the authenticated user's draft. `version` is required to
 * update an existing draft: omitted while a draft exists is a 409
 * `version_required`, and a stale `version` 409s too. A draft is only created
 * when none exists and `version` is omitted. A malformed payload is a 400.
 */
export async function PUT(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const body = await req.json().catch(() => null)
    const parsed = draftPutSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid draft payload")
    }
    const draft = await saveDraft(user, parsed.data)
    return Response.json({ draft: draftPayload(draft) })
  })
}

/**
 * Delete the authenticated user's draft. `version` (query param) is optional and
 * acts as a CAS token: deleting an existing draft requires it (omitted is a 409
 * `version_required`), a stale version 409s, and deleting a non-existent draft
 * with no version is an idempotent no-op.
 */
export async function DELETE(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const url = new URL(req.url)
    const versionRaw = url.searchParams.get("version")
    let version: number | undefined
    if (versionRaw != null) {
      version = Number(versionRaw)
      if (!Number.isInteger(version) || version < 0) {
        throw badRequest("validation", "Invalid draft version")
      }
    }
    const result = await deleteDraft(user, { version })
    return Response.json({ deleted: result.deleted })
  })
}
