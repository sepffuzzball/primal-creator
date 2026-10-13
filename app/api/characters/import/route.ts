import { z } from "zod"
import { requireUser } from "@/lib/auth/guard"
import { badRequest, payloadTooLarge, respond } from "@/lib/server/errors"
import {
  characterImportDocumentSchema,
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
} from "@/lib/server/import-schema"
import { importCharacter } from "@/lib/db/service"

export const runtime = "nodejs"

/** Request body cap: a trusted backup is at most 2 MiB before parsing. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

/**
 * Read the request body with a hard byte cap, throwing a 413 before the JSON is
 * ever parsed. Reading through the stream (rather than `request.json()`) means a
 * pathological >2MiB payload never allocates unbounded memory and never reaches
 * the Zod validator.
 */
async function readBodyBounded(req: Request): Promise<string> {
  const reader = req.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel()
      throw payloadTooLarge(
        "import_too_large",
        `Import payload exceeds the ${MAX_IMPORT_BYTES / (1024 * 1024)}MiB limit`
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

/** Summarize up to five Zod issues into a single actionable 400 message. */
function formatImportError(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)"
      return `${path}: ${issue.message}`
    })
    .join("; ")
  return `Invalid import document - ${issues}`
}

export async function POST(req: Request) {
  return respond(async () => {
    const user = await requireUser(req)
    const raw = await readBodyBounded(req)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw badRequest("validation", "Request body is not valid JSON")
    }

    // The accepted payload is `{ document: <v3> }`; for convenience a bare v3
    // document (an exported file) is also accepted.
    let doc: unknown
    if (
      body &&
      typeof body === "object" &&
      "document" in (body as Record<string, unknown>)
    ) {
      doc = (body as Record<string, unknown>).document
    } else {
      doc = body
    }

    const schemaValue = (doc as { schema?: unknown } | null)?.schema
    const SUPPORTED_SCHEMAS = new Set<string>([
      IMPORT_SCHEMA_V3,
      IMPORT_SCHEMA_V4,
    ])
    if (!SUPPORTED_SCHEMAS.has(String(schemaValue))) {
      throw badRequest(
        "unsupported_schema",
        `Unsupported schema "${String(schemaValue)}"; expected "${IMPORT_SCHEMA_V3}" or "${IMPORT_SCHEMA_V4}"`
      )
    }

    const parsed = characterImportDocumentSchema.safeParse(doc)
    if (!parsed.success) {
      throw badRequest("validation", formatImportError(parsed.error))
    }

    const character = await importCharacter(parsed.data, user)
    return Response.json({ character }, { status: 201 })
  })
}
