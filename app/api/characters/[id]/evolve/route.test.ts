import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { evolveCharacter, type CharacterDetail } from "@/lib/db/service"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  evolveCharacter: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const evolveCharacterMock = vi.mocked(evolveCharacter)

describe("POST /api/characters/[id]/evolve", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    evolveCharacterMock.mockResolvedValue({
      character: {} as CharacterDetail,
      journal: {},
    })
  })

  function evolveReq(body: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/evolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("hands a class track path to the service with its track preserved", async () => {
    const res = await POST(
      evolveReq({ track: "class", optionId: "evo-c", version: 0 }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(evolveCharacterMock).toHaveBeenCalledTimes(1)
    expect(evolveCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { track: "class", optionId: "evo-c", version: 0 },
      user
    )
  })

  it("hands a profession track path to the service with its track preserved", async () => {
    const res = await POST(
      evolveReq({
        track: "profession",
        optionId: "evo-p",
        version: 0,
        reason: "story",
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(evolveCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { track: "profession", optionId: "evo-p", version: 0, reason: "story" },
      user
    )
  })

  it("keeps a legacy race path (no track key) as a race path", async () => {
    const res = await POST(evolveReq({ optionId: "evo-r", version: 0 }), ctx())
    expect(res.status).toBe(200)
    expect(evolveCharacterMock).toHaveBeenCalledWith(
      "chr-1",
      { optionId: "evo-r", version: 0 },
      user
    )
  })

  it("returns 400 for a payload with no evolution shape", async () => {
    const res = await POST(evolveReq({}), ctx())
    expect(res.status).toBe(400)
    expect(evolveCharacterMock).not.toHaveBeenCalled()
  })
})
