import { requireAdmin } from "@/lib/auth/guard"
import { respond } from "@/lib/server/errors"
import {
  computeBulkRequestDigest,
  parseBulkEntries,
  previewBulkImport,
  readBulkUploadRequest,
} from "@/lib/db/bulk-catalog-import"

export const runtime = "nodejs"

/**
 * POST /api/admin/catalog-import/bulk/preview
 *
 * Admin-only, read-only preview of an admin-uploaded JSON/CSV catalog file. The
 * upload is parsed and validated and then computed against the live database
 * WITHOUT mutating anything: each entry is reported as `create` (no row occupies
 * its (kind, stableId) key yet) or `skip_existing` (a row already occupies the
 * key, so it would never be overwritten). The response includes a `previewDigest`
 * (SHA256 of `format + '\0' + content`). A caller MAY pass this back to the apply
 * endpoint as an optional content-integrity check; preview is UI policy, not a
 * server-enforced prerequisite. `requireAdmin` enforces the CSRF origin check for
 * this unsafe method before any database read.
 */
export async function POST(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const { format, content } = await readBulkUploadRequest(req)
    const previewDigest = computeBulkRequestDigest(format, content)
    const entries = parseBulkEntries(format, content)
    const result = await previewBulkImport(entries, previewDigest)
    return Response.json(result)
  })
}
