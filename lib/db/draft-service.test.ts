import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deleteDraft, getDraft, saveDraft } from "@/lib/db/draft-service"
import {
  draftDataSchema,
  draftPutSchema,
  DRAFT_DATA_MAX_BYTES,
  DRAFT_REQUEST_MAX_BYTES,
  type DraftData,
} from "@/lib/server/draft-schema"
import { DELETE, GET, PUT } from "@/app/api/drafts/route"
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session"

type TestStore = import("./testPrisma").TestPrismaInstance["store"]
type TestPrisma = import("./testPrisma").TestPrismaInstance["prisma"]

const dbMock = vi.hoisted(() => ({
  store: undefined as unknown as TestStore,
  prisma: undefined as unknown as TestPrisma,
}))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  dbMock.prisma = instance.prisma
  return { prisma: instance.prisma, default: instance.prisma }
})

const user = { id: "user-1", email: "u@example.com", isAdmin: false }

const DATA: DraftData = {
  step: 4,
  name: "Kael",
  description: "A resolute hunter.",
  origin: "born" as const,
  raceId: "race-1",
  classId: "class-1",
  professionId: "prof-1",
  special: true,
  equipment: ["gear-1", "gear-2"],
  nickname: "Sable",
  pronouns: "she/her",
  ageDescription: "mid-20s",
  appearance: "Dark hair, green cloak.",
  biography: "Born beyond the boundary.",
  notes: "Carries an heirloom dagger.",
}

/**
 * A valid draft that pushes the payload close to its 256 KiB cap: every bounded
 * string is filled to its per-field max with a 4-byte UTF-8 emoji (so the byte
 * total far exceeds the old 20 KiB cap that could not persist it) and the
 * equipment array is filled to its 128-item cap. Used to prove a legitimate
 * large draft is accepted and persisted.
 */
function nearLimitData(): DraftData {
  const emoji = "\u{1F600}" // U+1F600: 4 UTF-8 bytes, 2 UTF-16 code units.
  const fill = (units: number) => emoji.repeat(units / 2)
  return {
    step: 4,
    name: fill(256),
    description: fill(8000),
    origin: "born",
    raceId: "race-1",
    classId: "class-1",
    professionId: "prof-1",
    special: true,
    equipment: Array.from({ length: 128 }, () => "e".repeat(128)),
    nickname: fill(200),
    pronouns: fill(100),
    ageDescription: fill(4000),
    appearance: fill(8000),
    biography: fill(8000),
    notes: fill(4000),
  }
}

async function signedRequest(
  url: string,
  method: string,
  body?: unknown,
  sessionUser: { id: string; email: string; isAdmin: boolean } = user
): Promise<Request> {
  const token = await createSessionToken(sessionUser)
  const headers = new Headers()
  headers.set("cookie", `${SESSION_COOKIE}=${token}`)
  headers.set("content-type", "application/json")
  // The guard enforces the same-origin CSRF check on unsafe methods, so every
  // mutating signed request must carry an Origin matching its own URL.
  headers.set("origin", new URL(url).origin)
  return new Request(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.AUTH_SECRET = "x".repeat(40)
  dbMock.store.reset()
  // Session verification now queries the user row on every request, so the
  // signed requests in the route tests need the current user to exist.
  dbMock.store.addUser({ id: user.id, email: user.email })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("draft data schema (whitelist / bounds)", () => {
  it("accepts a full whitelisted payload", () => {
    const parsed = draftDataSchema.safeParse(DATA)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.name).toBe("Kael")
  })

  it("accepts a partial draft (resumable at any step)", () => {
    const parsed = draftDataSchema.safeParse({ step: 1, name: "Kael" })
    expect(parsed.success).toBe(true)
  })

  it("rejects a stat/award/effect field that is not in the whitelist", () => {
    const parsed = draftDataSchema.safeParse({
      step: 2,
      name: "Kael",
      stats: { strength: 5 },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a non-object data payload", () => {
    expect(draftDataSchema.safeParse("hello").success).toBe(false)
    expect(draftDataSchema.safeParse([1, 2]).success).toBe(false)
  })

  it("rejects an oversized string", () => {
    const parsed = draftDataSchema.safeParse({
      name: "x".repeat(257),
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts a near-limit data payload spread across fields (over 20KiB)", () => {
    const data = nearLimitData()
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8")
    expect(bytes).toBeGreaterThan(20 * 1024)
    expect(bytes).toBeLessThanOrEqual(DRAFT_DATA_MAX_BYTES)
    const parsed = draftDataSchema.safeParse(data)
    expect(parsed.success).toBe(true)
  })

  it("rejects an oversized data payload (over 256KiB)", () => {
    // Every field is at (or under) its own cap, but a deliberately long
    // specialAbilities id (whose string length is intentionally unbounded) is
    // enough to push the serialized total beyond the whole-payload cap.
    const parsed = draftDataSchema.safeParse({
      ...nearLimitData(),
      specialAbilities: { blessingId: "b".repeat(DRAFT_DATA_MAX_BYTES) },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a negative or non-integer version in the PUT body", () => {
    expect(draftPutSchema.safeParse({ data: DATA, version: -1 }).success).toBe(
      false
    )
    expect(draftPutSchema.safeParse({ data: DATA, version: 1.5 }).success).toBe(
      false
    )
  })

  it("accepts a PUT body with no version", () => {
    const parsed = draftPutSchema.safeParse({ data: DATA })
    expect(parsed.success).toBe(true)
  })

  it("accepts a draft with an explicit specialAbilities selection", () => {
    const parsed = draftDataSchema.safeParse({
      step: 4,
      name: "Kael",
      special: true,
      specialAbilities: {
        blessingId: "bless-1",
        bloodlineIds: ["blood-1", "blood-2"],
        transcendentSkillIds: ["trans-1"],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy draft with special:true and no explicit specialAbilities", () => {
    const parsed = draftDataSchema.safeParse({
      step: 4,
      name: "Kael",
      special: true,
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a draft whose specialAbilities arrays exceed the 8-id cap", () => {
    const parsed = draftDataSchema.safeParse({
      step: 4,
      specialAbilities: {
        bloodlineIds: Array.from({ length: 9 }, (_, i) => `blood-${i}`),
      },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a draft that selects the same id in more than one field (overlap)", () => {
    const parsed = draftDataSchema.safeParse({
      step: 4,
      specialAbilities: {
        blessingId: "bless-1",
        bloodlineIds: ["bless-1"],
      },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an empty-string id in a specialAbilities array", () => {
    const parsed = draftDataSchema.safeParse({
      step: 4,
      specialAbilities: { bloodlineIds: [""] },
    })
    expect(parsed.success).toBe(false)
  })
})

describe("draft service (persistence + CAS)", () => {
  beforeEach(() => {
    dbMock.store.reset()
    dbMock.store.addUser({ id: user.id, email: user.email })
  })

  it("getDraft returns null when no draft exists", async () => {
    await expect(getDraft(user)).resolves.toBeNull()
  })

  it("saveDraft creates a draft when absent and version is omitted", async () => {
    const draft = await saveDraft(user, { data: DATA })
    expect(draft.id).toBeTruthy()
    expect(draft.version).toBe(0)
    expect(draft.data).toEqual(DATA)
    expect(typeof draft.updatedAt).toBe("string")
    expect(dbMock.store.drafts.size).toBe(1)
    const stored = [...dbMock.store.drafts.values()][0]
    expect(stored.userId).toBe(user.id)
  })

  it("saveDraft CAS-updates at the exact supplied version", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 0 },
      version: 3,
    })
    const updated = await saveDraft(user, {
      data: { step: 5, name: "New" },
      version: 3,
    })
    expect(updated.version).toBe(4)
    expect(updated.data).toEqual({ step: 5, name: "New" })
    expect(
      ([...dbMock.store.drafts.values()][0].data as { step: number }).step
    ).toBe(5)
  })

  it("saveDraft rejects a no-version update to an existing draft (version_required) and never overwrites", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 0 },
      version: 2,
    })
    await expect(saveDraft(user, { data: { step: 6 } })).rejects.toMatchObject({
      status: 409,
      code: "version_required",
    })
    const stored = [...dbMock.store.drafts.values()][0]
    expect(stored.version).toBe(2)
    expect((stored.data as { step: number }).step).toBe(0)
  })

  it("saveDraft rejects a stale version with a 409 and never overwrites", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 1 },
      version: 5,
    })
    await expect(
      saveDraft(user, { data: { step: 9 }, version: 3 })
    ).rejects.toMatchObject({ status: 409, code: "draft_conflict" })
    const stored = [...dbMock.store.drafts.values()][0]
    expect(stored.version).toBe(5)
    expect((stored.data as { step: number }).step).toBe(1)
  })

  it("saveDraft rejects a supplied version when no draft exists", async () => {
    await expect(
      saveDraft(user, { data: DATA, version: 0 })
    ).rejects.toMatchObject({ status: 409, code: "draft_conflict" })
    expect(dbMock.store.drafts.size).toBe(0)
  })

  it("saveDraft maps a create race (unique violation) to a 409", async () => {
    // A concurrent create already committed a row for this user.
    dbMock.store.addDraft({ userId: user.id, data: { step: 0 } })
    // Force the service to believe no draft exists, so it attempts a CREATE which
    // then hits the unique per-user constraint => 409 (the losing create never
    // silently overwrites the winner).
    vi.spyOn(dbMock.prisma.characterDraft, "findUnique").mockResolvedValueOnce(
      null
    )
    await expect(saveDraft(user, { data: { step: 1 } })).rejects.toMatchObject({
      status: 409,
      code: "draft_conflict",
    })
    // The pre-existing draft is untouched.
    const stored = [...dbMock.store.drafts.values()][0]
    expect((stored.data as { step: number }).step).toBe(0)
  })

  it("deleteDraft deletes at the supplied version", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 2 },
      version: 4,
    })
    const res = await deleteDraft(user, { version: 4 })
    expect(res.deleted).toBe(true)
    expect(dbMock.store.drafts.size).toBe(0)
  })

  it("deleteDraft rejects a no-version delete of an existing draft (version_required) and keeps it", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 2 },
      version: 4,
    })
    await expect(deleteDraft(user)).rejects.toMatchObject({
      status: 409,
      code: "version_required",
    })
    expect(dbMock.store.drafts.size).toBe(1)
    expect(
      ([...dbMock.store.drafts.values()][0] as { version: number }).version
    ).toBe(4)
  })

  it("deleteDraft rejects a stale version with a 409 and keeps the draft", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 2 },
      version: 7,
    })
    await expect(deleteDraft(user, { version: 3 })).rejects.toMatchObject({
      status: 409,
      code: "draft_conflict",
    })
    expect(dbMock.store.drafts.size).toBe(1)
    expect(
      ([...dbMock.store.drafts.values()][0] as { version: number }).version
    ).toBe(7)
  })

  it("deleteDraft is an idempotent no-op when no draft exists and version omitted", async () => {
    const res = await deleteDraft(user)
    expect(res.deleted).toBe(false)
  })

  it("deleteDraft rejects a supplied version when no draft exists", async () => {
    await expect(deleteDraft(user, { version: 1 })).rejects.toMatchObject({
      status: 409,
      code: "draft_conflict",
    })
  })

  it("scopes drafts per user (owner only)", async () => {
    // A different user's draft must not be visible or mutated by user-1.
    dbMock.store.addDraft({
      userId: "user-2",
      data: { step: 3 },
      version: 1,
    })
    await expect(getDraft(user)).resolves.toBeNull()
    const created = await saveDraft(user, { data: { step: 1 } })
    expect(created.version).toBe(0)
    expect(dbMock.store.drafts.size).toBe(2)
    // user-1's new draft does not clobber user-2's.
    const other = [...dbMock.store.drafts.values()].find(
      (d) => d.userId === "user-2"
    )!
    expect((other.data as { step: number }).step).toBe(3)
  })
})

describe("api drafts route (auth + validation)", () => {
  beforeEach(() => {
    dbMock.store.reset()
    dbMock.store.addUser({ id: user.id, email: user.email })
  })

  it("GET rejects an unauthenticated request (no public reads)", async () => {
    const res = await GET(new Request("http://test/api/drafts"))
    expect(res.status).toBe(401)
  })

  it("PUT rejects an unauthenticated request", async () => {
    const res = await PUT(
      new Request("http://test/api/drafts", {
        method: "PUT",
        headers: { origin: "http://test" },
        body: JSON.stringify({ data: DATA }),
      })
    )
    expect(res.status).toBe(401)
  })

  it("DELETE rejects an unauthenticated request", async () => {
    const res = await DELETE(new Request("http://test/api/drafts"))
    expect(res.status).toBe(401)
  })

  it("PUT rejects a malformed payload with a 400", async () => {
    const res = await PUT(
      await signedRequest("http://test/api/drafts", "PUT", {
        data: "not-an-object",
      })
    )
    expect(res.status).toBe(400)
  })

  it("PUT rejects a payload with an unknown (non-whitelist) key", async () => {
    const res = await PUT(
      await signedRequest("http://test/api/drafts", "PUT", {
        data: { name: "Kael", stats: {} },
      })
    )
    expect(res.status).toBe(400)
  })

  it("PUT creates a draft for an authenticated user", async () => {
    const res = await PUT(
      await signedRequest("http://test/api/drafts", "PUT", { data: DATA })
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      draft: { id: string; version: number; data: unknown }
    }
    expect(json.draft.version).toBe(0)
    expect(json.draft.data).toEqual(DATA)
  })

  it("PUT accepts a near-limit draft payload (over 20KiB) and persists it", async () => {
    const data = nearLimitData()
    const res = await PUT(
      await signedRequest("http://test/api/drafts", "PUT", { data })
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      draft: { id: string; version: number; data: DraftData }
    }
    expect(json.draft.version).toBe(0)
    expect(json.draft.data).toEqual(data)
    expect(dbMock.store.drafts.size).toBe(1)
    const stored = [...dbMock.store.drafts.values()][0]
    expect(stored.data).toEqual(data)
  })

  it("PUT rejects an oversized declared Content-Length with a 413 before reading", async () => {
    const token = await createSessionToken(user)
    const headers = new Headers()
    headers.set("cookie", `${SESSION_COOKIE}=${token}`)
    headers.set("content-type", "application/json")
    headers.set("origin", "http://test")
    headers.set("content-length", String(DRAFT_REQUEST_MAX_BYTES + 1))
    const res = await PUT(
      new Request("http://test/api/drafts", {
        method: "PUT",
        headers,
        body: JSON.stringify({ data: DATA }),
      })
    )
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("payload_too_large")
  })

  it("PUT rejects an oversized streaming body (no Content-Length) with a 413", async () => {
    const token = await createSessionToken(user)
    const headers = new Headers()
    headers.set("cookie", `${SESSION_COOKIE}=${token}`)
    headers.set("content-type", "application/json")
    headers.set("origin", "http://test")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(DRAFT_REQUEST_MAX_BYTES + 1).fill(0x61)
        )
        controller.close()
      },
    })
    const res = await PUT(
      new Request("http://test/api/drafts", {
        method: "PUT",
        headers,
        body: stream,
        // `duplex: "half"` is required by undici to send a stream body; the
        // property is not in this TS lib's RequestInit, so assert the init.
        duplex: "half",
      } as RequestInit)
    )
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("payload_too_large")
  })

  it("PUT rejects a body that is not valid JSON with a 400", async () => {
    const token = await createSessionToken(user)
    const headers = new Headers()
    headers.set("cookie", `${SESSION_COOKIE}=${token}`)
    headers.set("content-type", "application/json")
    headers.set("origin", "http://test")
    const res = await PUT(
      new Request("http://test/api/drafts", {
        method: "PUT",
        headers,
        body: "{ not json",
      })
    )
    expect(res.status).toBe(400)
  })

  it("PUT returns 409 version_required when a draft exists and no version is supplied", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 0 },
      version: 3,
    })
    const res = await PUT(
      await signedRequest("http://test/api/drafts", "PUT", { data: DATA })
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("version_required")
  })

  it("DELETE returns 409 version_required when a draft exists and no version is supplied", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 0 },
      version: 3,
    })
    const res = await DELETE(
      await signedRequest("http://test/api/drafts", "DELETE")
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("version_required")
  })

  it("GET returns a draft for an authenticated user", async () => {
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 2 },
      version: 1,
    })
    const res = await GET(await signedRequest("http://test/api/drafts", "GET"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { draft: { version: number } | null }
    expect(json.draft).not.toBeNull()
    expect(json.draft!.version).toBe(1)
  })

  it("GET returns draft:null for an authenticated user with no draft", async () => {
    const res = await GET(await signedRequest("http://test/api/drafts", "GET"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { draft: null }
    expect(json.draft).toBeNull()
  })

  it("DELETE validates a malformed version query param", async () => {
    const res = await DELETE(
      await signedRequest(
        "http://test/api/drafts?version=not-a-number",
        "DELETE"
      )
    )
    expect(res.status).toBe(400)
  })
})
