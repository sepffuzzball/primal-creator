import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET, PATCH } from "./route"
import {
  getCharacterCurrencies,
  setCharacterCurrencyBalance,
  type CharacterCurrencyView,
} from "@/lib/db/service"

// The route delegates all persistence to the service, so we mock it here to
// assert exactly what the route hands it after Zod validation.
vi.mock("@/lib/db/service", () => ({
  getCharacterCurrencies: vi.fn(),
  setCharacterCurrencyBalance: vi.fn(),
}))

const requireUserMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/guard", () => ({
  requireUser: requireUserMock,
}))

const user = { id: "user-1", email: "u@example.com", isAdmin: false }
const getCurrenciesMock = vi.mocked(getCharacterCurrencies)
const setBalanceMock = vi.mocked(setCharacterCurrencyBalance)

const currency: CharacterCurrencyView = {
  definitionId: "cur-1",
  stableId: "crowns",
  name: "Crowns",
  description: "The realm's coinage",
  amount: 250,
}

describe("currencies route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockResolvedValue(user)
    getCurrenciesMock.mockResolvedValue({ currencies: [currency], version: 3 })
    setBalanceMock.mockResolvedValue({ version: 4 })
  })

  function req(method: string, body?: unknown): Request {
    return new Request("http://localhost/api/characters/chr-1/currencies", {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  function ctx() {
    return { params: Promise.resolve({ id: "chr-1" }) }
  }

  it("GET reads the character currencies with the current version", async () => {
    const res = await GET(req("GET"), ctx())
    expect(res.status).toBe(200)
    expect(getCurrenciesMock).toHaveBeenCalledWith("chr-1", user)
    const data = (await res.json()) as {
      currencies: unknown[]
      version: number
    }
    expect(data).toEqual({ currencies: [currency], version: 3 })
  })

  it("PATCH hands a valid payload to the service and returns the new version", async () => {
    const res = await PATCH(
      req("PATCH", {
        definitionId: "cur-1",
        amount: 250,
        version: 3,
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(setBalanceMock).toHaveBeenCalledWith(
      "chr-1",
      { definitionId: "cur-1", amount: 250, version: 3 },
      user
    )
    const data = (await res.json()) as { version: number }
    expect(data).toEqual({ version: 4 })
  })

  it("PATCH passes a null amount through to clear a balance", async () => {
    const res = await PATCH(
      req("PATCH", {
        definitionId: "cur-1",
        amount: null,
        version: 3,
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(setBalanceMock).toHaveBeenCalledWith(
      "chr-1",
      { definitionId: "cur-1", amount: null, version: 3 },
      user
    )
  })

  it("PATCH passes a zero amount through to persist a zero balance", async () => {
    const res = await PATCH(
      req("PATCH", {
        definitionId: "cur-1",
        amount: 0,
        version: 3,
      }),
      ctx()
    )
    expect(res.status).toBe(200)
    expect(setBalanceMock).toHaveBeenCalledWith(
      "chr-1",
      { definitionId: "cur-1", amount: 0, version: 3 },
      user
    )
  })

  it("PATCH returns 400 for a payload that fails schema validation", async () => {
    const res = await PATCH(
      req("PATCH", { definitionId: "cur-1", amount: -1, version: 3 }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect(setBalanceMock).not.toHaveBeenCalled()
  })

  it("PATCH returns 400 for a missing definitionId", async () => {
    const res = await PATCH(req("PATCH", { amount: 5, version: 3 }), ctx())
    expect(res.status).toBe(400)
    expect(setBalanceMock).not.toHaveBeenCalled()
  })
})
