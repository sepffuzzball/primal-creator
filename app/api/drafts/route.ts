import { requireUser } from "@/lib/auth/guard"
import { badRequest, payloadTooLarge, respond } from "@/lib/server/errors"
import {
  draftPutSchema,
  DRAFT_REQUEST_MAX_BYTES,
} from "@/lib/server/draft-schema"
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
 * Read the PUT body with a hard byte cap, throwing a 413 before the JSON is ever
 * parsed. Reading through the stream (rather than `request.json()`) means a
 * pathological payload larger than the cap never allocates unbounded memory and
 * never reaches the Zod validator. A trusted `Content-Length` header is checked
 * up front so an obviously oversized body is rejected without reading a single
 * byte; a missing or untrusted value falls back to the streamed hard limit.
 */
async function readDraftBodyBounded(req: Request): Promise<string> {
  const declared = req.headers.get("content-length")
  if (declared != null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > DRAFT_REQUEST_MAX_BYTES) {
      throw payloadTooLarge(
        "payload_too_large",
        `Draft payload exceeds the ${DRAFT_REQUEST_MAX_BYTES / 1024}KiB limit`
      )
    }
  }

  const reader = req.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > DRAFT_REQUEST_MAX_BYTES) {
      // Stop consuming the stream at the cap instead of buffering the whole body.
      await reader.cancel()
      throw payloadTooLarge(
        "payload_too_large",
        `Draft payload exceeds the ${DRAFT_REQUEST_MAX_BYTES / 1024}KiB limit`
      )
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
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
    // Auth + same-origin CSRF are verified before the body is ever read.
    const user = await requireUser(req)
    const raw = await readDraftBodyBounded(req)
    let body: unknown
    try {
      body = raw.length ? JSON.parse(raw) : undefined
    } catch {
      throw badRequest("validation", "Draft payload is not valid JSON")
    }
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
