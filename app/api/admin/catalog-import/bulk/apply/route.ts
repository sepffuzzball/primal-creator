import { requireAdmin } from "@/lib/auth/guard"
import { badRequest, respond } from "@/lib/server/errors"
import {
  applyBulkImport,
  computeBulkRequestDigest,
  parseBulkEntries,
  readBulkUploadRequest,
} from "@/lib/db/bulk-catalog-import"

export const runtime = "nodejs"

/**
 * POST /api/admin/catalog-import/bulk/apply
 *
 * Admin-only apply of an admin-uploaded JSON/CSV catalog file. `previewDigest`
 * is optional: a programmatic admin can call apply directly because preview and
 * admin confirmation are UI policy, not a server-enforced prerequisite. When a
 * `previewDigest` IS supplied, the server recomputes the content-integrity hash
 * from the uploaded text (SHA256 of `format + '\0' + content`) and rejects a
 * mismatch (400) before any write; the digest is not proof that a preview step
 * ran. Every missing row is inserted in ONE SERIALIZABLE transaction; existing
 * rows are never overwritten; a conflicting concurrent import surfaces as a 409
 * with no partial write. `requireAdmin` enforces the CSRF origin check for this
 * unsafe method before any database read.
 */
export async function POST(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const { format, content, previewDigest } = await readBulkUploadRequest(req)
    const digest = computeBulkRequestDigest(format, content)
    if (previewDigest != null && digest !== previewDigest) {
      throw badRequest(
        "preview_digest_mismatch",
        "The uploaded content does not match the digest supplied"
      )
    }
    const entries = parseBulkEntries(format, content)
    const result = await applyBulkImport(entries, digest)
    return Response.json(result)
  })
}
