import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DELETE, POST } from "./route"
import { prisma } from "@/lib/db/client"
import { createSessionToken } from "@/lib/auth/session"
import { PORTRAIT_KIND } from "@/lib/storage/portraits"
import { resolveDbIntegration } from "@/lib/test/db-integration"

// Real-Postgres integration test for the portrait route. Runs only when explicitly
// opted in (RUN_DB_INTEGRATION_TESTS=1) against a test-named database. When the
// caller has opted in but the database is missing/not test-named/unreachable, the
// gate throws so this file fails loudly rather than silently skipping, while an
// ordinary (non-opted-in) `pnpm test` still skips the suite.
const gate = await resolveDbIntegration()

// The guard rejects unsafe methods without a matching Origin, so every mutating
// request in this suite must carry one that matches the request URL's own origin.
const ORIGIN = "http://localhost"

describe.skipIf(!gate.run)(
  "POST /api/characters/[id]/portrait (real PG)",
  () => {
    let dir: string
    let userId: string
    let charId: string
    let email: string
    let token: string

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "concurrent-portraits-"))
      process.env.UPLOAD_DIR = dir

      userId = randomUUID()
      email = `portrait-${userId}@local.test`
      await prisma.user.create({
        data: { id: userId, email, password: "x", isAdmin: true },
      })
      charId = randomUUID()
      await prisma.character.create({
        data: {
          id: charId,
          ownerId: userId,
          name: "Concurrent portrait",
          state: {},
        },
      })
      token = await createSessionToken({ id: userId, email, isAdmin: true })
    })

    afterAll(async () => {
      await prisma.asset.deleteMany({ where: { characterId: charId } })
      await prisma.character.deleteMany({ where: { id: charId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      delete process.env.UPLOAD_DIR
      await rm(dir, { recursive: true, force: true })
    })

    async function makePng(): Promise<Buffer> {
      return sharp({
        create: {
          width: 32,
          height: 32,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
        .png()
        .toBuffer()
    }

    function uploadReq(bytes: Buffer, filename: string): Request {
      const form = new FormData()
      form.append(
        "file",
        new Blob([bytes as unknown as BlobPart], { type: "image/png" }),
        filename
      )
      return new Request(`http://localhost/api/characters/${charId}/portrait`, {
        method: "POST",
        body: form,
        headers: { cookie: `primal_session=${token}`, origin: ORIGIN },
      })
    }

    function deleteReq(): Request {
      return new Request(`http://localhost/api/characters/${charId}/portrait`, {
        method: "DELETE",
        headers: { cookie: `primal_session=${token}`, origin: ORIGIN },
      })
    }

    it("two simultaneous uploads leave exactly one asset and one on-disk file", async () => {
      const [pngA, pngB] = [await makePng(), await makePng()]
      const ctx = { params: Promise.resolve({ id: charId }) }

      const [resA, resB] = await Promise.all([
        POST(uploadReq(pngA, "a.png"), ctx),
        POST(uploadReq(pngB, "b.png"), ctx),
      ])

      expect(resA.status).toBe(201)
      expect(resB.status).toBe(201)

      const assets = await prisma.asset.findMany({
        where: { kind: PORTRAIT_KIND, characterId: charId },
      })
      expect(assets.length).toBe(1)
      expect(assets[0].characterId).toBe(charId)

      const files = (await readdir(dir)).filter((n) => n.endsWith(".webp"))
      expect(files.length).toBe(1)

      // The surviving asset must point at the surviving file - no orphaned
      // byte on disk and no row pointing at a removed file.
      expect(assets[0].fileName).toBe(files[0])
    })

    it("rejects an archived character with 400", async () => {
      const png = await makePng()
      await prisma.character.update({
        where: { id: charId },
        data: { archived: true },
      })
      const res = await POST(uploadReq(png, "arch.png"), {
        params: Promise.resolve({ id: charId }),
      })
      const body = (await res.json()) as {
        error: { code: string }
      }
      expect(res.status).toBe(400)
      expect(body.error.code).toBe("character_archived")

      await prisma.character.update({
        where: { id: charId },
        data: { archived: false },
      })
    })

    it("DELETE removes the active portrait row and bumps the character version", async () => {
      // The previous tests leave exactly one active portrait asset, so a DELETE
      // must remove it and, because removing a portrait is a content change,
      // increment the character version so the client reloads a fresh version.
      const before = await prisma.character.findUnique({
        where: { id: charId },
      })
      expect(before).not.toBeNull()

      const res = await DELETE(deleteReq(), {
        params: Promise.resolve({ id: charId }),
      })
      expect(res.status).toBe(200)

      const after = await prisma.character.findUnique({
        where: { id: charId },
      })
      expect(after!.version).toBe(before!.version + 1)

      const assets = await prisma.asset.findMany({
        where: { kind: PORTRAIT_KIND, characterId: charId },
      })
      expect(assets.length).toBe(0)
    })
  }
)
