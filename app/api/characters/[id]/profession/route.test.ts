import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { setCharacterProfession, type CharacterDetail } from "@/lib/db/service"
import { ApiError } from "@/lib/server/errors"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  setCharacterProfession: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const setCharacterProfessionMock = vi.mocked(setCharacterProfession)

describe("POST /api/characters/[id]/profession", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    setCharacterProfessionMock.mockResolvedValue({
      character: {} as CharacterDetail,
    })
  })

  function professionReq(body: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/profession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("hands the profession id and CAS version to the service", async () => {
    const res = await POST(
      professionReq({ professionId: "prof-f", version: 3 }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(setCharacterProfessionMock).toHaveBeenCalledTimes(1)
    expect(setCharacterProfessionMock).toHaveBeenCalledWith(
      "chr-1",
      { professionId: "prof-f", version: 3 },
      user
    )
  })

  it("returns 400 for a payload with no usable profession shape", async () => {
    const res = await POST(professionReq({ version: 0 }), ctx())
    expect(res.status).toBe(400)
    expect(setCharacterProfessionMock).not.toHaveBeenCalled()
  })

  it("returns 401 when the caller is unauthenticated", async () => {
    requireUserMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Not authenticated")
    )
    const res = await POST(
      professionReq({ professionId: "prof-f", version: 0 }),
      ctx()
    )
    expect(res.status).toBe(401)
    expect(setCharacterProfessionMock).not.toHaveBeenCalled()
  })
})
