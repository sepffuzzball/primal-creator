import { requireUser, assertCharacterAccess } from "@/lib/auth/guard"
import { notFound, respond } from "@/lib/server/errors"
import { prisma } from "@/lib/db/client"
import {
  PORTRAIT_KIND,
  PORTRAIT_MIME_TYPE,
  readPortraitFile,
} from "@/lib/storage/portraits"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/assets/[id]
 *
 * Serves a stored asset's binary bytes. This route is scoped to character
 * portrait assets (`kind === "character-avatar"`), so requesting any other kind
 * (e.g. a future catalog image) does not leak bytes - it 404s.
 *
 * Authorization is via the owning character: only the owner or an admin may read
 * the bytes, mirroring character access. The response never exposes the server
 * filesystem path - it is a private, uncached binary response with
 * `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
 */
export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params

    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) throw notFound("asset_not_found", "Asset not found")
    // No arbitrary asset-kind leakage: this endpoint serves portraits only.
    if (asset.kind !== PORTRAIT_KIND) {
      throw notFound("asset_not_found", "Asset not found")
    }

    // Resolve the owning character to check owner/admin access. A portrait
    // always carries a characterId; defensively, an orphaned asset with no
    // character is only readable by an admin.
    if (asset.characterId) {
      const character = await prisma.character.findUnique({
        where: { id: asset.characterId },
      })
      if (!character) {
        throw notFound("character_not_found", "Character not found")
      }
      assertCharacterAccess(character, user)
    } else if (!user.isAdmin) {
      throw notFound("asset_not_found", "Asset not found")
    }

    const data = await readPortraitFile(asset.fileName)
    // `Buffer` is a `Uint8Array` and is a valid BlobPart at runtime, but the DOM
    // lib types the `BlobPart` array-buffer view as `ArrayBuffer`-backed, which
    // `ArrayBufferLike` (as typed by @types/node) does not satisfy. Cast the
    // runtime-safe value rather than copy the bytes.
    const body = new Blob([data as unknown as BlobPart])
    return new Response(body, {
      headers: {
        "Content-Type": PORTRAIT_MIME_TYPE,
        "Content-Length": String(data.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
