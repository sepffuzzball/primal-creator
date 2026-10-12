/**
 * Character portrait storage.
 *
 * Portraits are the only kind of Asset with a real binary body. The binary is
 * never served from the public filesystem - it lives under a private upload
 * directory (`UPLOAD_DIR`, falling back to `/app/data/uploads` in production and
 * `<cwd>/data/uploads` otherwise) and is streamed back through an authenticated
 * route (`/api/assets/[id]`), so the server path is never exposed to the client.
 *
 * This module owns every step that touches the image bytes or the filesystem:
 * the bounded request read (rejecting oversized bodies before they are buffered),
 * decode/validate/normalize with sharp, the restrictive + exclusive write, the
 * strict basename / symlink guards, and the read/delete helpers. It deliberately
 * knows nothing about Prisma - the route handlers persist the Asset metadata
 * rows and drive the DB transaction, while this module stages the binary and
 * guarantees the staging file is cleaned up if the DB swap fails.
 */

import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import {
  ApiError,
  badRequest,
  notFound,
  payloadTooLarge,
} from "@/lib/server/errors"

/** The `Metadata` shape sharp's `.metadata()` resolves to. */
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

/** Asset.kind used for character portrait assets. */
export const PORTRAIT_KIND = "character-avatar"

/** Every portrait is re-encoded to WebP, so this is the stored/returned MIME. */
export const PORTRAIT_MIME_TYPE = "image/webp"

export const PORTRAIT_EXTENSION = ".webp"

/** Hard upload cap: 4 MiB of raw portrait bytes. */
export const MAX_PORTRAIT_BYTES = 4 * 1024 * 1024

/**
 * Ceiling on the size of a normalized portrait stored on disk. The write
 * pipeline re-encodes to WebP at most 1024x1024 and never enlarges, so a
 * legitimate stored file stays far below this. `readPortraitFile` uses it as the
 * read bound so a corrupted/oversized blob (a manually-placed file, a volume
 * mistake) is rejected rather than buffered into memory unboundedly.
 */
export const MAX_PORTRAIT_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Multipart framing allowance on top of the raw file bytes. A client may include
 * headers/boundaries around the file that themselves consume bytes; this is a
 * conservative ceiling for that overhead so the true bound on a request body is
 * MAX_PORTRAIT_BYTES + this allowance.
 */
export const MAX_PORTRAIT_MULTIPART_OVERHEAD = 64 * 1024

/**
 * Hard request-body cap enforced BEFORE parsing multipart. The route rejects the
 * request with 413 when either the Content-Length header or the streamed body
 * exceeds this, so an oversized upload is never fully buffered.
 */
export const MAX_PORTRAIT_REQUEST_BYTES =
  MAX_PORTRAIT_BYTES + MAX_PORTRAIT_MULTIPART_OVERHEAD

/** Portrait output is downscaled to fit within this square, never enlarged. */
export const MAX_PORTRAIT_DIMENSION = 1024

/**
 * Input pixel cap used as sharp's `limitInputPixels`. A decoded image larger
 * than this is a decompression bomb / resource-exhaustion risk, so sharp is
 * told to reject it before allocating output. 25 MP is far beyond the 1 MP
 * output square we actually keep, so nothing legitimate is dropped.
 */
export const MAX_PORTRAIT_PIXELS = 25_000_000

/** MIME types a client may declare for the upload field. */
export const ALLOWED_INPUT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const

/** sharp `metadata().format` values we accept as input (content-based check). */
const ALLOWED_INPUT_FORMATS = new Set(["png", "jpeg", "webp"])

/**
 * Shapes a server-generated file name: exactly 32 lowercase hex chars plus the
 * `.webp` extension. `generatePortraitFileName()` always produces this, and no
 * other value is accepted for reads/deletes (blocking arbitrary paths and
 * traversal).
 */
export const PORTRAIT_FILE_NAME_PATTERN = /^[0-9a-f]{32}\.webp$/

// ------------------------------------------------------------------ //
// Path helpers
// ------------------------------------------------------------------ //

/**
 * Resolve the private upload directory.
 *
 * Precedence:
 *   1. `UPLOAD_DIR` when set (explicit operator override).
 *   2. `/app/data/uploads` in production (the compose `uploads` volume mount).
 *   3. `<cwd>/data/uploads` for local dev / tests (never production).
 *
 * The directory is private by convention - nothing under it is ever mounted on
 * `/public`, so the files are only reachable through the authenticated asset
 * route.
 */
export function resolveUploadDir(): string {
  const configured = process.env.UPLOAD_DIR
  if (configured && configured.length > 0) return path.resolve(configured)
  if (process.env.NODE_ENV === "production") return "/app/data/uploads"
  return path.resolve(process.cwd(), "data", "uploads")
}

/**
 * The canonical public URL for an asset. Always `/api/assets/{id}` - never a
 * filesystem path - so the served bytes are re-validated by the asset route and
 * the storage location stays an implementation detail.
 */
export function portraitAssetUrl(assetId: string): string {
  return `/api/assets/${assetId}`
}

/**
 * Assert `fileName` is a strict generated basename (`[0-9a-f]{32}.webp`). The
 * name is produced by the server but stored on a DB row, so it is treated as
 * untrusted on every read/write/delete: anything else (traversal, wrong length,
 * wrong case, missing extension, a sub-path) is rejected as an invalid path.
 *
 * Throws a 400 when the name is not a strict basename.
 */
export function assertPortraitFileName(fileName: string): void {
  if (!PORTRAIT_FILE_NAME_PATTERN.test(fileName)) {
    throw badRequest("invalid_path", `Invalid portrait file name "${fileName}"`)
  }
}

/**
 * Resolve a strict generated basename to an absolute path inside the upload
 * directory. Because `assertPortraitFileName` rejects anything with a slash or
 * a `..` segment, the name is guaranteed to stay inside the directory; the
 * relative check below remains as a defensive backstop.
 *
 * Throws a 400 when the name is empty or escapes the upload directory.
 */
export function portraitPath(fileName: string): string {
  if (!fileName || fileName.length === 0) {
    throw badRequest("invalid_path", "Portrait file name is empty")
  }
  assertPortraitFileName(fileName)
  const dir = resolveUploadDir()
  const resolved = path.resolve(dir, fileName)
  const rel = path.relative(dir, resolved)
  // A name is safe when it stays at or below the directory. `../x` produces a
  // relative path starting with `..`; an absolute path (defensive) is likewise
  // outside the directory.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw badRequest(
      "invalid_path",
      `Portrait file name "${fileName}" escapes the upload directory`
    )
  }
  return resolved
}

/** Generate a random, collision-resistant file name (no client input). */
export function generatePortraitFileName(): string {
  return `${randomBytes(16).toString("hex")}${PORTRAIT_EXTENSION}`
}

// ------------------------------------------------------------------ //
// Staging helpers
// ------------------------------------------------------------------ //

/** Restrictively create the upload directory (mode 0700, plus parents). */
async function ensureUploadDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/**
 * The upload root must be a real directory, not a symlink. A symlinked root
 * could be swapped to point at an unexpected location (or an operator error),
 * so reject it loudly rather than silently reading/writing through it.
 */
async function assertRealUploadDir(dir: string): Promise<void> {
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink()) {
      throw new ApiError(
        500,
        "invalid_upload_dir",
        `Upload directory "${dir}" is a symlink`
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
}

/**
 * Write `buffer` to `fileName` inside the upload directory.
 *
 * - The directory is created restrictively (0700) first.
 * - The upload root is verified to be a real directory (not a symlink).
 * - The file is written with the `wx` flag (exclusive create) so it never
 *   clobbers an existing file/symlink; a collision (astronomically unlikely with
 *   a random name) fails loudly instead of silently overwriting.
 * - Returns the absolute path that was written.
 */
export async function writePortraitFile(
  fileName: string,
  buffer: Buffer
): Promise<string> {
  const target = portraitPath(fileName)
  const dir = path.dirname(target)
  await ensureUploadDir(dir)
  await assertRealUploadDir(dir)
  await writeFile(target, buffer, { flag: "wx", mode: 0o600 })
  return target
}

/**
 * Read a stored portrait back as a Buffer.
 *
 * The read is race-free against a symlink swap at the portrait path:
 *
 * - `portraitPath` validates the strict generated basename (no traversal), and
 *   the upload root must be a real directory, never a symlink - a symlinked root
 *   could be retargeted to an unexpected location, so it is rejected.
 * - The file is opened with `O_NOFOLLOW | O_RDONLY`, so a symlink placed at the
 *   final component is rejected out of hand (ELOOP) instead of being accepted by
 *   an `lstat` and then read through a link. There is no `lstat`/`readFile` gap
 *   to race.
 * - The descriptor is `fstat`ed (never a second path lookup) and only a regular
 *   file is served; a directory or any non-regular object is not-found.
 * - The read is bounded to `MAX_PORTRAIT_OUTPUT_BYTES`, so a corrupted oversized
 *   blob is rejected instead of buffered unboundedly.
 * - The handle is always closed in `finally`.
 *
 * A missing file, an empty/null name, a symlink, a directory, or an oversized
 * blob each surface as a controlled error (404/500) rather than a raw
 * filesystem error, so a symlinked `/etc/passwd` is never served.
 */
export async function readPortraitFile(
  fileName: string | null | undefined
): Promise<Buffer> {
  if (!fileName) {
    throw notFound("portrait_not_found", "Portrait file not found")
  }
  const target = portraitPath(fileName)
  const dir = path.dirname(target)

  // Reject a symlinked upload root before reading through it.
  await assertRealUploadDir(dir)

  // The flags are applied atomically at open time - no lstat/readFile race. A
  // symlink at the final component fails open with ELOOP and is mapped below.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW
  let handle: FileHandle
  try {
    // The upload location is runtime/operator-driven (UPLOAD_DIR / production
    // volume), so it cannot be statically scoped to a project subfolder. Opt out
    // of whole-project tracing for this dynamic read.
    handle = await open(/* turbopackIgnore: true */ target, flags)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT: the file (or its directory) is gone; ELOOP: the final component is
    // a symlink. Both mean "no regular portrait bytes here" -> 404.
    if (code === "ENOENT" || code === "ELOOP") {
      throw notFound("portrait_not_found", "Portrait file not found")
    }
    throw err
  }

  try {
    // fstat via the open descriptor: only a regular file is served, and the check
    // runs on the same descriptor we read from (no second path lookup to race).
    const st = await handle.stat()
    if (!st.isFile()) {
      throw notFound("portrait_not_found", "Portrait file not found")
    }

    // Bounded read of the normalized max output: reject anything larger rather
    // than allocating it all.
    if (st.size > MAX_PORTRAIT_OUTPUT_BYTES) {
      throw new ApiError(
        500,
        "portrait_too_large",
        `Stored portrait exceeds the ${MAX_PORTRAIT_OUTPUT_BYTES}-byte limit`
      )
    }

    const buf = Buffer.alloc(st.size)
    const { bytesRead } = await handle.read(buf, 0, st.size, 0)
    // A concurrent truncation could make a single read return short; slice to
    // what was actually read so we never serve trailing zero padding.
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Remove a stored portrait file. Best-effort: a missing file (already deleted,
 * volume reset, or the row outlived the binary) is not an error, so callers can
 * safely tear down a replaced or orphaned staging file. A null/empty name is a
 * no-op. Removing a symlink unlinks the link itself (leaving its target), so the
 * operation is safe for both regular files and links.
 */
export async function deletePortraitFile(
  fileName: string | null | undefined
): Promise<void> {
  if (!fileName) return
  const target = portraitPath(fileName)
  try {
    await unlink(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

// ------------------------------------------------------------------ //
// Bounded request read + multipart extraction
// ------------------------------------------------------------------ //

/**
 * Read a portrait upload request body into a Buffer, never buffering more than
 * `MAX_PORTRAIT_REQUEST_BYTES`.
 *
 * The Content-Length header is checked first (immediate 413 when it is already
 * known to be too large). The body stream is then read with a hard cap as a
 * second line of defense against a missing/wrong Content-Length (chunked
 * uploads). The stream is cancelled as soon as the cap is exceeded so we stop
 * pulling bytes we will never use.
 */
export async function readBoundedPortraitRequest(
  req: Request
): Promise<Buffer> {
  const contentLength = req.headers.get("content-length")
  if (contentLength) {
    const n = Number(contentLength)
    if (Number.isFinite(n) && n > MAX_PORTRAIT_REQUEST_BYTES) {
      throw payloadTooLarge(
        "payload_too_large",
        `Portrait request exceeds the ${MAX_PORTRAIT_REQUEST_BYTES}-byte limit`
      )
    }
  }

  const body = req.body
  if (!body) return Buffer.alloc(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PORTRAIT_REQUEST_BYTES) {
      await reader.cancel()
      throw payloadTooLarge(
        "payload_too_large",
        `Portrait request exceeds the ${MAX_PORTRAIT_REQUEST_BYTES}-byte limit`
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

/**
 * Parse multipart FormData from an already-bounded buffer, never from the raw
 * (possibly unbounded) incoming request. `contentType` must carry the original
 * `multipart/form-data` boundary so the reconstruction parses identically.
 */
export async function parseBoundedPortraitForm(
  buffer: Buffer,
  contentType: string | null
): Promise<FormData> {
  const headers = new Headers()
  if (contentType) headers.set("content-type", contentType)
  const boundedReq = new Request("http://localhost/api/portrait", {
    method: "POST",
    // `Buffer` is a `Uint8Array` and is a valid BodyInit at runtime, but the DOM
    // lib types `BodyInit`'s view as `ArrayBuffer`-backed, which `ArrayBufferLike`
    // (as typed by @types/node) does not satisfy. Cast the runtime-safe value.
    body: buffer as unknown as BodyInit,
    headers,
  })
  return boundedReq.formData()
}

/**
 * Extract the single `file` part from a parsed portrait form.
 *
 * Rejects a request that carries no file (`file_required`), any file part under
 * a name other than `file`, or more than one file part (extra file parts) - a
 * portrait upload accepts exactly one file and no others. Scalar fields are
 * tolerated and ignored.
 */
export function extractPortraitFile(form: FormData): {
  file: File
  declaredType: string | null
} {
  let file: File | null = null
  for (const [name, value] of form.entries()) {
    if (!(value instanceof File)) continue
    if (name !== "file" || file !== null) {
      throw badRequest(
        "extra_file_parts",
        "Exactly one `file` multipart field is required"
      )
    }
    file = value
  }
  if (!file) {
    throw badRequest("file_required", "A `file` multipart field is required")
  }
  return { file, declaredType: file.type || null }
}

// ------------------------------------------------------------------ //
// Decode / normalize (content-based validation)
// ------------------------------------------------------------------ //

export interface NormalizedPortrait {
  buffer: Buffer
  mimeType: string
  sizeBytes: number
  width: number
  height: number
}

/** Normalize an upload MIME type: strip parameters, lowercase. */
function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? ""
}

/**
 * Validate and normalize an uploaded portrait.
 *
 * Every check is content-based, never trust-the-MIME:
 * - empty payload -> 400
 * - byte limit -> 413
 * - sharp cannot decode -> 400 (not an image)
 * - decoded `format` is not PNG/JPEG/WebP -> 400 (e.g. GIF/SVG/TIFF/AVIF)
 * - decoded dimension exceeds the pixel cap -> 400 (resource exhaustion)
 *
 * On success the image is auto-oriented, downscaled to fit a 1024x1024 square
 * (never enlarged), re-encoded to WebP, and re-encoded without carrying over
 * source metadata (EXIF etc.). Returns the re-encoded bytes plus dimensions.
 */
export async function normalizePortrait(input: {
  buffer: Buffer
  declaredType?: string | null
}): Promise<NormalizedPortrait> {
  const buffer = input.buffer
  const declaredType = input.declaredType?.trim() || ""

  if (!buffer || buffer.length === 0) {
    throw badRequest("empty_file", "Portrait file is empty")
  }
  if (buffer.length > MAX_PORTRAIT_BYTES) {
    throw payloadTooLarge(
      "too_large",
      `Portrait exceeds the ${MAX_PORTRAIT_BYTES}-byte limit`
    )
  }

  // Fast pre-check on a clearly-wrong declared image type. Anything else (an
  // unknown/absent MIME, application/octet-stream, text/plain) is left to the
  // authoritative sharp decode below.
  if (declaredType) {
    const norm = normalizeMime(declaredType)
    if (
      norm !== "application/octet-stream" &&
      !ALLOWED_INPUT_MIME_TYPES.includes(
        norm as (typeof ALLOWED_INPUT_MIME_TYPES)[number]
      ) &&
      norm !== "image/jpg" &&
      norm.startsWith("image/")
    ) {
      throw badRequest(
        "unsupported_type",
        `Unsupported portrait type "${norm}"; expected PNG, JPEG or WebP`
      )
    }
  }

  const options = { limitInputPixels: MAX_PORTRAIT_PIXELS }

  // Content check: decode + inspect. sharp only accepts real images, and we
  // restrict the decoded format to PNG/JPEG/WebP so a GIF/SVG etc. is rejected.
  let meta: SharpMetadata
  try {
    meta = await sharp(buffer, options).metadata()
  } catch {
    throw badRequest(
      "invalid_image",
      "Uploaded file is not a valid PNG, JPEG or WebP image"
    )
  }
  if (!meta.format || !ALLOWED_INPUT_FORMATS.has(meta.format)) {
    throw badRequest(
      "unsupported_type",
      `Unsupported portrait type "${meta.format ?? "unknown"}"; expected PNG, JPEG or WebP`
    )
  }

  // Decode again through the full pipeline: auto-orient, fit within the square
  // without enlarging, re-encode to WebP, and drop source metadata (we never
  // call `.withMetadata()`, so EXIF/ICC are not carried over).
  const result = await sharp(buffer, options)
    .rotate()
    .resize({
      width: MAX_PORTRAIT_DIMENSION,
      height: MAX_PORTRAIT_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp()
    .toBuffer({ resolveWithObject: true })

  return {
    buffer: result.data,
    mimeType: PORTRAIT_MIME_TYPE,
    sizeBytes: result.data.length,
    width: result.info.width,
    height: result.info.height,
  }
}

// ------------------------------------------------------------------ //
// Upload orchestration (staging + swap + rollback)
// ------------------------------------------------------------------ //

/**
 * Metadata passed to the DB swap so the Asset row can be written from the
 * already-normalized bytes (never re-derived from the raw upload).
 */
export interface PortraitCommitInput {
  fileName: string
  mimeType: string
  sizeBytes: number
}

/**
 * The DB work for a single portrait commit. Implemented by the route handler as
 * a `prisma.$transaction`: serialize on the character row, re-check ownership
 * inside the transaction, discover the portrait Asset rows being replaced
 * INSIDE the same transaction, delete them and insert the new one, and return
 * the new asset id plus the exact file names that were displaced. It must be
 * atomic - if it throws, the previous Asset rows remain untouched (and their
 * files must not be deleted).
 *
 * The `displacedFileNames` are deleted by the caller ONLY after the transaction
 * commits, so a failed write never removes a file still referenced by a
 * rolled-back row.
 */
export type PortraitSwap = (
  portrait: PortraitCommitInput
) => Promise<{ assetId: string; displacedFileNames: string[] }>

export interface SavePortraitInput {
  buffer: Buffer
  declaredType?: string | null
  /**
   * The atomic DB replacement. The returned `displacedFileNames` are the exact
   * file names replaced inside the transaction; their files are removed only
   * AFTER the swap commits, so a failed DB write never deletes a file that is
   * still referenced by a rolled-back row.
   */
  swap: PortraitSwap
}

/**
 * Stage a new portrait end-to-end.
 *
 * 1. Normalize/validate the upload and write it (exclusively) under the upload
 *    directory as a server-generated name - this is the "staging" write.
 * 2. Hand off to `swap` (the atomic DB row replacement, which serializes on the
 *    character row and returns the precisely displaced file names).
 * 3. Only on a *committed* swap, remove exactly the displaced file(s); on a
 *    failed swap, remove the newly staged file so a DB error never leaves an
 *    orphan behind.
 *
 * The old-file cleanup is strictly best-effort and lives OUTSIDE the rollback
 * catch: a failure to delete an old file must neither delete the newly committed
 * file (so the DB row does not dangle) nor turn a committed portrait into a
 * failing request. Cleanup errors are swallowed and any stale file is left behind
 * harmlessly.
 *
 * Returns the asset id and the public URL (never a filesystem path).
 */
export async function savePortrait(
  input: SavePortraitInput
): Promise<{ assetId: string; url: string }> {
  const normalized = await normalizePortrait({
    buffer: input.buffer,
    declaredType: input.declaredType,
  })
  const fileName = generatePortraitFileName()
  await writePortraitFile(fileName, normalized.buffer)

  let committed: Awaited<ReturnType<PortraitSwap>>
  try {
    committed = await input.swap({
      fileName,
      mimeType: normalized.mimeType,
      sizeBytes: normalized.sizeBytes,
    })
  } catch (err) {
    // DB swap failed; the staged file is now an orphan - clean it up (best-effort
    // so the cleanup failure never masks the original DB error) and rethrow.
    await deletePortraitFile(fileName).catch(() => {})
    throw err
  }

  // The transaction (which serialized on the character row and discovered the
  // replaced rows inside the same transaction) has committed, so it is now safe
  // to remove exactly the displaced files. Best-effort: a stale/missing previous
  // file is ignored, and a hard cleanup failure must not fail the committed
  // request or delete the newly committed file.
  for (const old of committed.displacedFileNames) {
    if (!old) continue
    try {
      await deletePortraitFile(old)
    } catch {
      // stale file left behind; harmless - the row and new file are correct.
    }
  }

  return {
    assetId: committed.assetId,
    url: portraitAssetUrl(committed.assetId),
  }
}
