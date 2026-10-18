import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { createSkillUpgradeVariant, type CatalogItem } from "@/lib/db/service"
import { ApiError } from "@/lib/server/errors"

// The route delegates cloning to the service, so we mock it here to assert
// exactly what the route hands it after Zod validation, and to assert that the
// admin guard gates the route before the service is ever called.
vi.mock("@/lib/db/service", () => ({
  createSkillUpgradeVariant: vi.fn(),
}))

const requireAdminMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireAdmin: requireAdminMock,
}))

const admin = { id: "admin-1", email: "a@example.com", isAdmin: true }
const cloneMock = vi.mocked(createSkillUpgradeVariant)

const sourceItem: CatalogItem = {
  id: "skill-src",
  kind: "skills",
  stableId: "fireball-common",
  name: "Fireball",
  description: "A fireball",
  grade: null,
  sourceUrl: "https://example.com/fireball",
  archived: false,
  config: { track: "race", rarity: "Common" },
  gradeDescriptions: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const cloneItem: CatalogItem = {
  id: "skill-child",
  kind: "skills",
  stableId: "fireball-uncommon",
  name: "Fireball",
  description: "A fireball",
  grade: null,
  sourceUrl: "https://example.com/fireball",
  archived: false,
  config: { track: "race", rarity: "Uncommon", upgradeToStableIds: [] },
  gradeDescriptions: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("POST /api/catalog/skills/[id]/upgrades", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAdminMock.mockResolvedValue(admin)
    cloneMock.mockResolvedValue({ source: sourceItem, item: cloneItem })
  })

  function cloneReq(body: unknown): Request {
    return new Request(
      "http://localhost/api/catalog/skills/skill-src/upgrades",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
  }

  function ctx() {
    return { params: Promise.resolve({ id: "skill-src" }) }
  }

  it("returns 201 with the linked source and the cloned item", async () => {
    const res = await POST(cloneReq({ rarity: "Uncommon" }), ctx())
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      source: CatalogItem
      item: CatalogItem
    }
    expect(body.source.stableId).toBe("fireball-common")
    expect(body.item.stableId).toBe("fireball-uncommon")
    expect(cloneMock).toHaveBeenCalledTimes(1)
    expect(cloneMock).toHaveBeenCalledWith("skill-src", { rarity: "Uncommon" })
  })

  it("forwards an optional name override", async () => {
    const res = await POST(
      cloneReq({ rarity: "Divine", name: "Sunfire" }),
      ctx()
    )
    expect(res.status).toBe(201)
    expect(cloneMock).toHaveBeenCalledWith("skill-src", {
      rarity: "Divine",
      name: "Sunfire",
    })
  })

  it("rejects an anonymous caller with 401 before touching the service", async () => {
    requireAdminMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Not authenticated")
    )
    const res = await POST(cloneReq({ rarity: "Common" }), ctx())
    expect(res.status).toBe(401)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("rejects a non-admin caller with 403 before touching the service", async () => {
    requireAdminMock.mockRejectedValueOnce(
      new ApiError(403, "forbidden", "Admin role required")
    )
    const res = await POST(cloneReq({ rarity: "Common" }), ctx())
    expect(res.status).toBe(403)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("returns 400 when the payload has no rarity", async () => {
    const res = await POST(cloneReq({}), ctx())
    expect(res.status).toBe(400)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("returns 400 for an invalid rarity", async () => {
    const res = await POST(cloneReq({ rarity: "Mythic" }), ctx())
    expect(res.status).toBe(400)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("returns 400 for a name that is blank after trimming", async () => {
    const res = await POST(cloneReq({ rarity: "Common", name: "   " }), ctx())
    expect(res.status).toBe(400)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("returns 400 for a name longer than 200 chars", async () => {
    const res = await POST(
      cloneReq({ rarity: "Common", name: "x".repeat(201) }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it("returns 400 when the body is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/catalog/skills/skill-src/upgrades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(cloneMock).not.toHaveBeenCalled()
  })
})
