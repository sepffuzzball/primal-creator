import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { upgradeSkill, type CharacterDetail } from "@/lib/db/service"
import { ApiError } from "@/lib/server/errors"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  upgradeSkill: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const upgradeSkillMock = vi.mocked(upgradeSkill)

describe("POST /api/characters/[id]/skills/upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    upgradeSkillMock.mockResolvedValue({
      character: {} as CharacterDetail,
    })
  })

  function upgradeReq(body: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/skills/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("hands the target definition id, CAS version and reason to the service", async () => {
    const res = await POST(
      upgradeReq({ definitionId: "sk-1", version: 3, reason: "because" }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(upgradeSkillMock).toHaveBeenCalledTimes(1)
    expect(upgradeSkillMock).toHaveBeenCalledWith(
      "chr-1",
      { definitionId: "sk-1", version: 3, reason: "because" },
      user
    )
  })

  it("forwards an explicit sourceDefinitionId to the service when supplied", async () => {
    const res = await POST(
      upgradeReq({
        sourceDefinitionId: "sk-low",
        definitionId: "sk-high",
        version: 3,
        reason: "because",
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(upgradeSkillMock).toHaveBeenCalledTimes(1)
    expect(upgradeSkillMock).toHaveBeenCalledWith(
      "chr-1",
      {
        sourceDefinitionId: "sk-low",
        definitionId: "sk-high",
        version: 3,
        reason: "because",
      },
      user
    )
  })

  it("returns 400 for a payload with no usable upgrade shape", async () => {
    const res = await POST(upgradeReq({ version: 0 }), ctx())
    expect(res.status).toBe(400)
    expect(upgradeSkillMock).not.toHaveBeenCalled()
  })

  it("returns 400 when reason is missing or too long", async () => {
    const missing = await POST(
      upgradeReq({ definitionId: "sk-1", version: 0 }),
      ctx()
    )
    expect(missing.status).toBe(400)
    const tooLong = await POST(
      upgradeReq({
        definitionId: "sk-1",
        version: 0,
        reason: "x".repeat(501),
      }),
      ctx()
    )
    expect(tooLong.status).toBe(400)
    expect(upgradeSkillMock).not.toHaveBeenCalled()
  })

  it("returns 401 when the caller is unauthenticated", async () => {
    requireUserMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Not authenticated")
    )
    const res = await POST(
      upgradeReq({ definitionId: "sk-1", version: 0, reason: "x" }),
      ctx()
    )
    expect(res.status).toBe(401)
    expect(upgradeSkillMock).not.toHaveBeenCalled()
  })
})
