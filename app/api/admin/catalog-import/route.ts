import { requireAdmin } from "@/lib/auth/guard"
import { respond } from "@/lib/server/errors"
import { WIKI_REVIEWED_ENTRIES } from "@/prisma/catalog/wiki-reviewed"
import {
  applyWikiReviewedImport,
  previewWikiReviewedImport,
} from "@/lib/db/catalog-import"

export const runtime = "nodejs"

/**
 * GET /api/admin/catalog-import
 *
 * Admin-only preview: compute against the live database (no mutation) which
 * manifest entries would be created and which would be skipped because a row with
 * the same (kind, stableId) already exists. Safe method, so no CSRF origin check.
 */
export async function GET(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const result = await previewWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    return Response.json(result)
  })
}

/**
 * POST /api/admin/catalog-import
 *
 * Admin-only apply. The manifest is fixed (`WIKI_REVIEWED_ENTRIES`); no arbitrary
 * user-provided rows are accepted (the request body is ignored). Every missing row
 * is inserted in ONE SERIALIZABLE transaction; existing rows are never overwritten.
 * Returns the same preview-like shape plus `createdIds`. The `requireAdmin` guard
 * enforces the CSRF origin check for this unsafe method before any session lookup.
 */
export async function POST(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    return Response.json(result)
  })
}
