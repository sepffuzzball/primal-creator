import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { experienceCharacter, type CharacterDetail } from "@/lib/db/service"
import { ApiError } from "@/lib/server/errors"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  experienceCharacter: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const experienceCharacterMock = vi.mocked(experienceCharacter)

describe("POST /api/characters/[id]/experience", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    experienceCharacterMock.mockResolvedValue({
      character: {} as CharacterDetail,
      journal: {},
    })
  })

  function experienceReq(body: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/experience", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("hands a set operation body to the service", async () => {
    const res = await POST(
      experienceReq({
        operation: "set",
        track: "class",
        percent: 50,
        version: 3,
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(experienceCharacterMock).toHaveBeenCalledTimes(1)
    expect(experienceCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { operation: "set", track: "class", percent: 50, version: 3 },
      user
    )
  })

  it("hands a levelUp operation body to the service", async () => {
    const res = await POST(
      experienceReq({ operation: "levelUp", track: "race", version: 1 }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(experienceCharacterMock).toHaveBeenCalledTimes(1)
    expect(experienceCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { operation: "levelUp", track: "race", version: 1 },
      user
    )
  })

  it("hands an undo operation body to the service", async () => {
    const res = await POST(
      experienceReq({ operation: "undo", track: "class", version: 7 }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(experienceCharacterMock).toHaveBeenCalledTimes(1)
    expect(experienceCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { operation: "undo", track: "class", version: 7 },
      user
    )
  })

  it("returns the character and journal from the service", async () => {
    experienceCharacterMock.mockResolvedValueOnce({
      character: { id: "chr-1" } as unknown as CharacterDetail,
      journal: { leveledUp: true, turnsAdvanced: 1 },
    })
    const res = await POST(
      experienceReq({
        operation: "set",
        track: "class",
        percent: 100,
        version: 0,
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      character: { id: "chr-1" },
      journal: { leveledUp: true, turnsAdvanced: 1 },
    })
  })

  it("returns 400 for a payload with no usable experience shape", async () => {
    const res = await POST(experienceReq({ track: "class", version: 0 }), ctx())
    expect(res.status).toBe(400)
    expect(experienceCharacterMock).not.toHaveBeenCalled()
  })

  it("returns 400 for a levelUp payload carrying a percent", async () => {
    const res = await POST(
      experienceReq({
        operation: "levelUp",
        track: "class",
        percent: 75,
        version: 0,
      }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(experienceCharacterMock).not.toHaveBeenCalled()
  })

  it("returns 400 for an undo payload carrying a percent", async () => {
    const res = await POST(
      experienceReq({
        operation: "undo",
        track: "class",
        percent: 75,
        version: 0,
      }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(experienceCharacterMock).not.toHaveBeenCalled()
  })

  it("returns 401 when the caller is unauthenticated", async () => {
    requireUserMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Not authenticated")
    )
    const res = await POST(
      experienceReq({
        operation: "set",
        track: "class",
        percent: 50,
        version: 0,
      }),
      ctx()
    )
    expect(res.status).toBe(401)
    expect(experienceCharacterMock).not.toHaveBeenCalled()
  })

  it("surfaces a service grade_blocked as a 400 (never a 500)", async () => {
    experienceCharacterMock.mockRejectedValueOnce(
      new ApiError(
        400,
        "grade_blocked",
        'advanceQuarter: level-up on "class" would push class level past the F->E threshold (25) without completed track evolution'
      )
    )
    const res = await POST(
      experienceReq({
        operation: "set",
        track: "class",
        percent: 100,
        version: 0,
      }),
      ctx()
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({
      error: {
        code: "grade_blocked",
        message:
          'advanceQuarter: level-up on "class" would push class level past the F->E threshold (25) without completed track evolution',
      },
    })
  })
})
