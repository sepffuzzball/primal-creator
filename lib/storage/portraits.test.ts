import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import sharp from "sharp"
import {
  ALLOWED_INPUT_MIME_TYPES,
  MAX_PORTRAIT_BYTES,
  MAX_PORTRAIT_OUTPUT_BYTES,
  MAX_PORTRAIT_REQUEST_BYTES,
  PORTRAIT_EXTENSION,
  PORTRAIT_MIME_TYPE,
  deletePortraitFile,
  extractPortraitFile,
  generatePortraitFileName,
  normalizePortrait,
  parseBoundedPortraitForm,
  portraitAssetUrl,
  portraitPath,
  readBoundedPortraitRequest,
  readPortraitFile,
  resolveUploadDir,
  savePortrait,
  writePortraitFile,
} from "@/lib/storage/portraits"

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer()
}

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 10, g: 120, b: 200 },
    },
  })
    .jpeg()
    .toBuffer()
}

async function makeWebp(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 30, g: 200, b: 90 },
    },
  })
    .webp()
    .toBuffer()
}

async function makeGif(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 120, g: 90, b: 200 },
    },
  })
    .gif()
    .toBuffer()
}

/** Build a strict generated basename: `c` repeated 32 times + `.webp`. */
const validName = (c: string) => `${c.repeat(32)}.webp`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "portraits-"))
  process.env.UPLOAD_DIR = dir
})

afterEach(async () => {
  vi.unstubAllEnvs()
  delete process.env.UPLOAD_DIR
  await rm(dir, { recursive: true, force: true })
})

describe("resolveUploadDir", () => {
  it("prefers UPLOAD_DIR when set", () => {
    process.env.UPLOAD_DIR = "/custom/uploads"
    expect(resolveUploadDir()).toBe(path.resolve("/custom/uploads"))
  })

  it("falls back to the production volume when UPLOAD_DIR is unset", () => {
    delete process.env.UPLOAD_DIR
    vi.stubEnv("NODE_ENV", "production")
    expect(resolveUploadDir()).toBe("/app/data/uploads")
  })

  it("falls back to cwd/data/uploads outside production", () => {
    delete process.env.UPLOAD_DIR
    vi.stubEnv("NODE_ENV", "development")
    expect(resolveUploadDir()).toBe(
      path.resolve(process.cwd(), "data", "uploads")
    )
  })
})

describe("generatePortraitFileName", () => {
  it("produces a random 32-hex name with the .webp extension", () => {
    const name = generatePortraitFileName()
    expect(name).toMatch(/^[0-9a-f]{32}\.webp$/)
    expect(name.endsWith(PORTRAIT_EXTENSION)).toBe(true)
  })

  it("does not repeat", () => {
    const a = generatePortraitFileName()
    const b = generatePortraitFileName()
    expect(a).not.toBe(b)
  })
})

describe("portraitAssetUrl", () => {
  it("always builds an API URL, never a filesystem path", () => {
    expect(portraitAssetUrl("abc")).toBe("/api/assets/abc")
    expect(portraitAssetUrl("abc")).toContain("/api/assets/")
  })
})

describe("portraitPath", () => {
  it("resolves a strict generated basename inside the upload directory", () => {
    const name = validName("a")
    const p = portraitPath(name)
    expect(path.dirname(p)).toBe(path.resolve(dir))
    expect(path.basename(p)).toBe(name)
  })

  it("rejects an empty name", () => {
    expect(() => portraitPath("")).toThrow(/empty/)
  })

  it("rejects names that are not strict generated basenames", () => {
    // Too few hex characters.
    expect(() => portraitPath("a1.webp")).toThrow(/Invalid portrait file name/)
    // Uppercase hex is rejected (names are lowercase-only).
    expect(() => portraitPath(`${"A".repeat(32)}.webp`)).toThrow(
      /Invalid portrait file name/
    )
    // Wrong extension.
    expect(() => portraitPath(`${"a".repeat(32)}.png`)).toThrow(
      /Invalid portrait file name/
    )
    // A sub-path segment.
    expect(() => portraitPath(`sub/${validName("b")}`)).toThrow(
      /Invalid portrait file name/
    )
    // Parent traversal.
    expect(() => portraitPath(`../${validName("c")}`)).toThrow(
      /Invalid portrait file name/
    )
    // Parent traversal of the whole name.
    expect(() => portraitPath("../outside.webp")).toThrow(
      /Invalid portrait file name/
    )
    expect(() => portraitPath("../../etc/passwd")).toThrow(
      /Invalid portrait file name/
    )
  })

  it("rejects an absolute path from a different directory", () => {
    const other = path.resolve("/elsewhere")
    expect(() => portraitPath(path.join(other, validName("d")))).toThrow(
      /Invalid portrait file name/
    )
  })
})

describe("normalizePortrait", () => {
  it("accepts a PNG, re-encodes to WebP, and bounds the dimensions", async () => {
    const png = await makePng()
    const out = await normalizePortrait({
      buffer: png,
      declaredType: "image/png",
    })
    expect(out.mimeType).toBe(PORTRAIT_MIME_TYPE)
    expect(out.width).toBeLessThanOrEqual(1024)
    expect(out.height).toBeLessThanOrEqual(1024)
    expect(out.sizeBytes).toBeGreaterThan(0)
    // The output is actually decodable as WebP.
    const meta = await sharp(out.buffer).metadata()
    expect(meta.format).toBe("webp")
    expect(out.buffer.length).toBeLessThan(png.length)
  })

  it("accepts a JPEG", async () => {
    const jpeg = await makeJpeg()
    const out = await normalizePortrait({
      buffer: jpeg,
      declaredType: "image/jpeg",
    })
    expect(out.mimeType).toBe(PORTRAIT_MIME_TYPE)
    expect((await sharp(out.buffer).metadata()).format).toBe("webp")
  })

  it("accepts a WebP", async () => {
    const webp = await makeWebp()
    const out = await normalizePortrait({
      buffer: webp,
      declaredType: "image/webp",
    })
    expect(out.mimeType).toBe(PORTRAIT_MIME_TYPE)
    expect((await sharp(out.buffer).metadata()).format).toBe("webp")
  })

  it("rejects a GIF by content even without a declared type", async () => {
    const gif = await makeGif()
    await expect(
      normalizePortrait({ buffer: gif, declaredType: undefined })
    ).rejects.toMatchObject({ code: "unsupported_type" })
  })

  it("rejects a clearly-wrong declared image type", async () => {
    const png = await makePng()
    await expect(
      normalizePortrait({ buffer: png, declaredType: "image/gif" })
    ).rejects.toMatchObject({ code: "unsupported_type" })
  })

  it("rejects a non-image payload", async () => {
    const junk = Buffer.from("this is not an image at all", "utf8")
    await expect(
      normalizePortrait({ buffer: junk, declaredType: "image/png" })
    ).rejects.toMatchObject({ code: "invalid_image" })
  })

  it("rejects an oversized payload with 413 before decoding", async () => {
    const big = Buffer.alloc(MAX_PORTRAIT_BYTES + 1, 0x00)
    await expect(
      normalizePortrait({ buffer: big, declaredType: "image/png" })
    ).rejects.toMatchObject({ code: "too_large", status: 413 })
  })

  it("rejects an empty payload", async () => {
    await expect(
      normalizePortrait({ buffer: Buffer.alloc(0), declaredType: "image/png" })
    ).rejects.toMatchObject({ code: "empty_file" })
  })
})

describe("write/read/delete file helpers", () => {
  it("round-trips the canonical bytes", async () => {
    const content = Buffer.from("portrait-bytes", "utf8")
    const name = validName("a")
    const target = await writePortraitFile(name, content)
    expect(target).toBe(portraitPath(name))
    const read = await readPortraitFile(name)
    expect(read.equals(content)).toBe(true)
    await deletePortraitFile(name)
    await expect(readPortraitFile(name)).rejects.toMatchObject({
      code: "portrait_not_found",
    })
  })

  it("writes exclusively and refuses to clobber an existing file", async () => {
    const name = validName("b")
    await writePortraitFile(name, Buffer.from("one"))
    await expect(
      writePortraitFile(name, Buffer.from("two"))
    ).rejects.toMatchObject({ code: "EEXIST" })
  })

  it("reads a missing file as a portrait_not_found 404", async () => {
    await expect(readPortraitFile(validName("c"))).rejects.toMatchObject({
      code: "portrait_not_found",
    })
  })

  it("reads a null/empty name as portrait_not_found", async () => {
    await expect(readPortraitFile(null)).rejects.toMatchObject({
      code: "portrait_not_found",
    })
  })

  it("rejects a stored file larger than the normalized max output", async () => {
    const name = validName("a")
    const big = Buffer.alloc(MAX_PORTRAIT_OUTPUT_BYTES + 1, 0x00)
    await writeFile(portraitPath(name), big)
    await expect(readPortraitFile(name)).rejects.toMatchObject({
      status: 500,
      code: "portrait_too_large",
    })
  })

  it("deleting a nonexistent file is not an error", async () => {
    await expect(
      deletePortraitFile(validName("d"))
    ).resolves.toBeUndefined()
  })

  it("deleting a null/empty name is a no-op", async () => {
    await expect(deletePortraitFile(null)).resolves.toBeUndefined()
  })

  it("creates the upload directory restrictively", async () => {
    const name = validName("e")
    await writePortraitFile(name, Buffer.from("x"))
    // Directory now exists (created recursively) at the resolved upload root.
    const entries = await readdir(dir)
    expect(entries).toContain(name)
  })

  it("ALLOWED_INPUT_MIME_TYPES includes the declared set", () => {
    expect(ALLOWED_INPUT_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ])
  })
})

describe("savePortrait", () => {
  it("stages the file, commits the swap, and removes displaced files", async () => {
    const oldName = validName("a")
    await writePortraitFile(oldName, Buffer.from("old bytes"))

    const png = await makePng()
    let swapped: {
      fileName: string
      mimeType: string
      sizeBytes: number
    } | null = null
    const result = await savePortrait({
      buffer: png,
      declaredType: "image/png",
      swap: async (portrait) => {
        swapped = portrait
        return { assetId: "asset-1", displacedFileNames: [oldName] }
      },
    })

    expect(result.assetId).toBe("asset-1")
    expect(result.url).toBe("/api/assets/asset-1")

    // The swap saw the staged, normalized metadata.
    expect(swapped).not.toBeNull()
    expect(swapped!.mimeType).toBe(PORTRAIT_MIME_TYPE)
    expect(swapped!.fileName).toMatch(/\.webp$/)

    // The new file is on disk; the displaced file is gone.
    const entries = await readdir(dir)
    expect(entries).toContain(swapped!.fileName)
    expect(entries).not.toContain(oldName)
  })

  it("does not delete files that were not reported as displaced", async () => {
    const keepName = validName("b")
    await writePortraitFile(keepName, Buffer.from("old bytes"))

    const png = await makePng()
    const result = await savePortrait({
      buffer: png,
      declaredType: "image/png",
      // The swap reports a different displaced file, e.g. a pre-existing file
      // whose name differs from the one this upload replaced.
      swap: async () => ({
        assetId: "asset-2",
        displacedFileNames: [validName("c")],
      }),
    })

    expect(result.assetId).toBe("asset-2")
    const entries = await readdir(dir)
    // The displaced file reported by the swap is not on disk, but the keep file
    // (not reported) must still be there.
    expect(entries).not.toContain(validName("c"))
    expect(entries).toContain(keepName)
  })

  it("cleans up the staged file when the swap fails (no orphan)", async () => {
    const png = await makePng()
    let swapped: { fileName: string } | null = null
    await expect(
      savePortrait({
        buffer: png,
        declaredType: "image/png",
        swap: async (portrait) => {
          swapped = portrait
          throw new Error("db down")
        },
      })
    ).rejects.toThrow("db down")

    // The temporarily staged file must have been removed.
    expect(swapped).not.toBeNull()
    const entries = await readdir(dir)
    expect(entries).not.toContain(swapped!.fileName)
  })

  it("does not delete replaced files when the swap fails", async () => {
    const oldName = validName("d")
    await writePortraitFile(oldName, Buffer.from("old bytes"))
    const png = await makePng()
    await expect(
      savePortrait({
        buffer: png,
        declaredType: "image/png",
        swap: async () => {
          throw new Error("db down")
        },
      })
    ).rejects.toThrow("db down")
    // Old file untouched (its row was rolled back), new file removed.
    const entries = await readdir(dir)
    expect(entries).toContain(oldName)
  })

  it("keeps the committed file and still succeeds when old-file cleanup fails", async () => {
    // An old portrait "file" that cannot be unlinked: the displaced path is a
    // directory, so `unlink` fails with EISDIR. The best-effort cleanup must
    // swallow that, keep the newly committed file, and still return success -
    // the DB row is correct and must not dangle.
    const staleName = validName("a")
    await mkdir(portraitPath(staleName), { recursive: true })

    const png = await makePng()
    let staged = ""
    const result = await savePortrait({
      buffer: png,
      declaredType: "image/png",
      swap: async (portrait) => {
        staged = portrait.fileName
        return { assetId: "asset-1", displacedFileNames: [staleName] }
      },
    })

    // Cleanup failure is best-effort: the request still succeeds.
    expect(result.assetId).toBe("asset-1")
    expect(result.url).toBe("/api/assets/asset-1")

    const entries = await readdir(dir)
    // The newly committed file must still be on disk - a cleanup failure must
    // not delete it (otherwise the committed row dangles).
    expect(entries).toContain(staged)
    // The unlinkable stale directory is left behind harmlessly.
    expect(entries).toContain(staleName)
  })
})

describe("readBoundedPortraitRequest", () => {
  it("rejects a Content-Length above the cap with 413", async () => {
    const req = new Request("http://localhost/api/portrait", {
      method: "POST",
      body: new Uint8Array(10),
      headers: {
        "content-length": String(MAX_PORTRAIT_REQUEST_BYTES + 1),
      },
    })
    await expect(readBoundedPortraitRequest(req)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    })
  })

  it("buffers a body within the cap", async () => {
    const body = Buffer.from("hello world")
    const req = new Request("http://localhost/api/portrait", {
      method: "POST",
      body,
    })
    const buf = await readBoundedPortraitRequest(req)
    expect(buf.toString()).toBe("hello world")
  })

  it("rejects a stream that exceeds the cap with 413", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PORTRAIT_REQUEST_BYTES + 1))
        controller.close()
      },
    })
    const req = new Request("http://localhost/api/portrait", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit)
    await expect(readBoundedPortraitRequest(req)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    })
  })

  it("returns an empty buffer for a bodyless request", async () => {
    const req = new Request("http://localhost/api/portrait", {
      method: "POST",
    })
    const buf = await readBoundedPortraitRequest(req)
    expect(buf.length).toBe(0)
  })
})

describe("parseBoundedPortraitForm + extractPortraitFile", () => {
  async function parseUpload(
    entries: Array<
      | { name: string; text: string }
      | {
          name: string
          file: { bytes: Uint8Array; type: string; filename: string }
        }
    >
  ): Promise<FormData> {
    const form = new FormData()
    for (const e of entries) {
      if ("text" in e) {
        form.append(e.name, e.text)
      } else {
        form.append(
          e.name,
          new Blob([e.file.bytes as unknown as BlobPart], {
            type: e.file.type,
          }),
          e.file.filename
        )
      }
    }
    const req = new Request("http://localhost/api/portrait", {
      method: "POST",
      body: form,
    })
    const body = await readBoundedPortraitRequest(req)
    return parseBoundedPortraitForm(body, req.headers.get("content-type"))
  }

  it("extracts the single file part and its declared type", async () => {
    const form = await parseUpload([
      {
        name: "file",
        file: { bytes: Buffer.from("x"), type: "image/png", filename: "a.png" },
      },
    ])
    const { file, declaredType } = extractPortraitFile(form)
    expect(file.name).toBe("a.png")
    expect(file.type).toBe("image/png")
    expect(declaredType).toBe("image/png")
  })

  it("rejects a form with no file part", async () => {
    const form = await parseUpload([{ name: "caption", text: "hello" }])
    expect(() => extractPortraitFile(form)).toThrow(
      /A `file` multipart field is required/
    )
  })

  it("rejects extra file parts", async () => {
    const form = await parseUpload([
      {
        name: "file",
        file: { bytes: Buffer.from("a"), type: "image/png", filename: "a.png" },
      },
      {
        name: "file",
        file: { bytes: Buffer.from("b"), type: "image/png", filename: "b.png" },
      },
    ])
    expect(() => extractPortraitFile(form)).toThrow(
      /Exactly one `file` multipart field/
    )
  })

  it("rejects a file part under a name other than `file`", async () => {
    const form = await parseUpload([
      {
        name: "avatar",
        file: { bytes: Buffer.from("a"), type: "image/png", filename: "a.png" },
      },
    ])
    expect(() => extractPortraitFile(form)).toThrow(
      /Exactly one `file` multipart field/
    )
  })
})

describe("symlink safety", () => {
  it("rejects a symlinked upload root on write", async () => {
    const real = path.join(dir, "real-uploads")
    await mkdir(real, { recursive: true })
    const link = path.join(dir, "link-uploads")
    await symlink(real, link)
    process.env.UPLOAD_DIR = link

    await expect(
      writePortraitFile(validName("a"), Buffer.from("x"))
    ).rejects.toMatchObject({ status: 500, code: "invalid_upload_dir" })
  })

  it("treats a symlinked portrait file as not found on read", async () => {
    const targetFile = path.join(dir, "source.webp")
    await writeFile(targetFile, "real bytes")
    const name = validName("b")
    await symlink(targetFile, portraitPath(name))

    await expect(readPortraitFile(name)).rejects.toMatchObject({
      code: "portrait_not_found",
    })
  })

  it("deletes a symlinked portrait file without touching its target", async () => {
    const targetFile = path.join(dir, "target-bytes.webp")
    await writeFile(targetFile, "keep")
    const name = validName("c")
    await symlink(targetFile, portraitPath(name))

    await deletePortraitFile(name)
    // The link is gone; the real target is untouched.
    await expect(lstat(portraitPath(name))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(readFile(targetFile)).resolves.toEqual(Buffer.from("keep"))
  })

  it("rejects a symlinked upload root on read", async () => {
    const real = path.join(dir, "real-uploads")
    await mkdir(real, { recursive: true })
    const link = path.join(dir, "link-uploads")
    await symlink(real, link)
    process.env.UPLOAD_DIR = link

    await expect(readPortraitFile(validName("a"))).rejects.toMatchObject({
      status: 500,
      code: "invalid_upload_dir",
    })
  })

  it("rejects a regular file that is swapped to a symlink before the read", async () => {
    const name = validName("b")
    await writePortraitFile(name, Buffer.from("real bytes"))
    // Reads fine as a regular file.
    await expect(readPortraitFile(name)).resolves.toEqual(
      Buffer.from("real bytes")
    )

    // Replace the regular file with a symlink: the O_NOFOLLOW open must reject it
    // (ELOOP -> not found) - a swapped-in link is never served.
    const targetFile = path.join(dir, "source.webp")
    await writeFile(targetFile, "link bytes")
    await rm(portraitPath(name))
    await symlink(targetFile, portraitPath(name))

    await expect(readPortraitFile(name)).rejects.toMatchObject({
      code: "portrait_not_found",
    })
  })
})
