import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "./route"
import {
  adjustCharacterInventory,
  getCharacterInventory,
  type CharacterDetail,
  type CharacterInventoryItemView,
} from "@/lib/db/service"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  getCharacterInventory: vi.fn(),
  adjustCharacterInventory: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const getInventoryMock = vi.mocked(getCharacterInventory)
const adjustMock = vi.mocked(adjustCharacterInventory)

const item: CharacterInventoryItemView = {
  id: "inv-1",
  definitionId: "gear-1",
  name: "Gear gear-1",
  kind: "equipment",
  quantity: 2,
  archived: false,
  slot: "head",
  provenance: "house",
}

describe("inventory route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    getInventoryMock.mockResolvedValue({ inventory: [item], version: 3 })
    adjustMock.mockResolvedValue({
      character: {} as CharacterDetail,
      inventory: [item],
      version: 4,
    })
  })

  function req(method: string, body?: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/inventory", {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("GET reads the character inventory with the current version", async () => {
    const res = await GET(req("GET"), ctx())
    expect(res.status).toBe(200)
    expect(getInventoryMock).toHaveBeenCalledWith("chr-1", user)
    const data = (await res.json()) as { inventory: unknown[]; version: number }
    expect(data).toEqual({ inventory: [item], version: 3 })
  })

  it("POST hands a valid add payload to the service and returns the refreshed detail", async () => {
    const res = await POST(
      req("POST", {
        operation: "add",
        definitionId: "gear-1",
        quantity: 2,
        version: 3,
        sourceNote: "bought",
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(adjustMock).toHaveBeenCalledWith(
      "chr-1",
      {
        operation: "add",
        definitionId: "gear-1",
        quantity: 2,
        version: 3,
        sourceNote: "bought",
      },
      user
    )
    const data = (await res.json()) as { inventory: unknown[]; version: number }
    expect(data.inventory).toEqual([item])
    expect(data.version).toBe(4)
  })

  it("POST returns 400 for a payload that fails schema validation", async () => {
    const res = await POST(
      req("POST", { operation: "add", definitionId: "gear-1", quantity: 0 }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(adjustMock).not.toHaveBeenCalled()
  })

  it("POST returns 400 for an empty sourceNote", async () => {
    const res = await POST(
      req("POST", {
        operation: "remove",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "",
      }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(adjustMock).not.toHaveBeenCalled()
  })
})
