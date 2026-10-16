import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import {
  refreshPendingSkillOffers,
  type CharacterDetail,
} from "@/lib/db/service"
import { ApiError } from "@/lib/server/errors"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  refreshPendingSkillOffers: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const refreshMock = vi.mocked(refreshPendingSkillOffers)

describe("POST /api/characters/[id]/skills/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    refreshMock.mockResolvedValue({
      character: {} as CharacterDetail,
    })
  })

  function refreshReq(): Request {
    return new Request("http://localhost/api/characters/chr-1/skills/refresh", {
      method: "POST",
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("hands the character id and user to the service and returns the detail", async () => {
    const res = await POST(refreshReq(), ctx())
    expect(res.status).toBe(200)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(refreshMock).toHaveBeenCalledWith("chr-1", user)
    const body = await res.json()
    expect(body).toEqual({ character: {} })
  })

  it("returns 401 when the caller is unauthenticated", async () => {
    requireUserMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Not authenticated")
    )
    const res = await POST(refreshReq(), ctx())
    expect(res.status).toBe(401)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("surfaces a non-owner 403 from the service", async () => {
    refreshMock.mockRejectedValueOnce(
      new ApiError(403, "forbidden", "Not the owner")
    )
    const res = await POST(refreshReq(), ctx())
    expect(res.status).toBe(403)
  })
})
