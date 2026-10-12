import { randomUUID } from "node:crypto"
import { requireUser, assertCharacterAccess } from "@/lib/auth/guard"
import { badRequest, notFound, payloadTooLarge, respond } from "@/lib/server/errors"
import { prisma } from "@/lib/db/client"
import {
  MAX_PORTRAIT_BYTES,
  PORTRAIT_KIND,
  deletePortraitFile,
  extractPortraitFile,
  parseBoundedPortraitForm,
  portraitAssetUrl,
  readBoundedPortraitRequest,
  savePortrait,
} from "@/lib/storage/portraits"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

async function getOwnedCharacter(
  id: string,
  user: Awaited<ReturnType<typeof requireUser>>
) {
  const character = await prisma.character.findUnique({ where: { id } })
  if (!character) throw notFound("character_not_found", "Character not found")
  assertCharacterAccess(character, user)
  return character
}

/**
 * GET /api/characters/[id]/portrait
 *
 * Returns the character's active portrait as `{ portrait: { assetId, url } }`,
 * or `{ portrait: null }` when none has been uploaded. Reads always succeed for
 * an authenticated owner/admin, including for archived characters.
 */
export async function GET(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    await getOwnedCharacter(id, user)

    const asset = await prisma.asset.findFirst({
      where: { kind: PORTRAIT_KIND, characterId: id },
      orderBy: { updatedAt: "desc" },
    })

    return Response.json({
      portrait: asset ? { assetId: asset.id, url: asset.url } : null,
    })
  })
}

/**
 * POST /api/characters/[id]/portrait
 *
 * Multipart upload with a single `file` field (max 4 MiB, PNG/JPEG/WebP). Only
 * the owner or an admin may upload, and an archived character is inert so it is
 * rejected. A character has at most one active portrait: the old Asset row and
 * its file are replaced only after the new file + row are durably persisted, and
 * the staged file is cleaned up if the database write fails.
 *
 * Returns `{ assetId, url }` where url is always `/api/assets/{id}` (never a
 * filesystem path).
 */
export async function POST(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    const character = await getOwnedCharacter(id, user)
    if (character.archived) {
      throw badRequest(
        "character_archived",
        "Archived character cannot receive a portrait"
      )
    }

    // Bound the request body BEFORE parsing multipart. The cap is
    // MAX_PORTRAIT_BYTES + a multipart overhead allowance; an oversized upload
    // is rejected with 413 instead of buffering unbounded bytes.
    const body = await readBoundedPortraitRequest(req)
    const form = await parseBoundedPortraitForm(
      body,
      req.headers.get("content-type")
    )
    const { file, declaredType } = extractPortraitFile(form)
    if (file.size > MAX_PORTRAIT_BYTES) {
      throw payloadTooLarge(
        "too_large",
        `Portrait exceeds the ${MAX_PORTRAIT_BYTES}-byte limit`
      )
    }
    const buffer = Buffer.from(await file.arrayBuffer())

    const result = await savePortrait({
      buffer,
      declaredType,
      swap: async (portrait) =>
        prisma.$transaction(async (tx) => {
          // Serialize concurrent portrait uploads on the character row by
          // incrementing its version (acquires a row-level write lock held until
          // commit). Re-check owner/admin + archived against the freshly locked
          // row so a concurrently removed/archived character is handled
          // atomically.
          const locked = await tx.character
            .update({
              where: { id },
              data: { version: { increment: 1 } },
            })
            .catch((err) => {
              if ((err as { code?: string }).code === "P2025") {
                throw notFound("character_not_found", "Character not found")
              }
              throw err
            })
          assertCharacterAccess(locked, user)
          if (locked.archived) {
            throw badRequest(
              "character_archived",
              "Archived character cannot receive a portrait"
            )
          }

          // Discover the rows being replaced INSIDE the transaction so a
          // concurrent upload never discovers a stale previous asset. Only
          // these exact files are deleted after commit; the new staged file is
          // never deleted.
          const existing = await tx.asset.findMany({
            where: { kind: PORTRAIT_KIND, characterId: id },
          })
          const displacedFileNames = existing
            .map((a) => a.fileName)
            .filter((n): n is string => Boolean(n))

          // One active portrait per character: drop any prior portrait rows.
          await tx.asset.deleteMany({
            where: { kind: PORTRAIT_KIND, characterId: id },
          })
          const assetId = randomUUID()
          await tx.asset.create({
            data: {
              id: assetId,
              kind: PORTRAIT_KIND,
              fileName: portrait.fileName,
              mimeType: portrait.mimeType,
              sizeBytes: portrait.sizeBytes,
              url: portraitAssetUrl(assetId),
              characterId: id,
            },
          })
          return { assetId, displacedFileNames }
        }),
    })

    return Response.json(result, { status: 201 })
  })
}

/**
 * DELETE /api/characters/[id]/portrait
 *
 * Remove the character's portrait: the Asset metadata row is deleted first, then
 * the backed file is removed best-effort (a stale file is not an error). Owners
 * and admins only; archived characters may still have their portrait removed.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  return respond(async () => {
    const user = await requireUser(req)
    const { id } = await ctx.params
    await getOwnedCharacter(id, user)

    const asset = await prisma.asset.findFirst({
      where: { kind: PORTRAIT_KIND, characterId: id },
      orderBy: { updatedAt: "desc" },
    })
    if (!asset) {
      throw notFound(
        "portrait_not_found",
        "Character has no portrait to remove"
      )
    }

    // Remove the metadata row before touching the file, so a file-delete error
    // never leaves a row pointing at bytes an admin still wants to keep. Removing
    // a portrait is a content change, so bump the character version in the same
    // transaction - the client reloads the full detail after DELETE and uses the
    // fresh version for progression/actions.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.character.update({
          where: { id },
          data: { version: { increment: 1 } },
        })
        await tx.asset.delete({ where: { id: asset.id } })
      })
    } catch (err) {
      if ((err as { code?: string }).code === "P2025") {
        throw notFound(
          "portrait_not_found",
          "Character has no portrait to remove"
        )
      }
      throw err
    }
    if (asset.fileName) await deletePortraitFile(asset.fileName)

    return Response.json({ assetId: asset.id, url: asset.url })
  })
}
