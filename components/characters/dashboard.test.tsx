// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { cleanup, render, screen, fireEvent } from "@testing-library/react"
import { afterEach } from "vitest"
import type { CharacterListItem, Grade } from "@/lib/api"
import { CharacterPortrait, getRaceLevelTier, RaceBadges } from "./dashboard"

const grades: Grade[] = ["G", "F", "E", "D", "C", "B", "A", "S"]

afterEach(cleanup)

function item(overrides: Partial<CharacterListItem> = {}): CharacterListItem {
  return {
    id: "id",
    name: "Test",
    description: null,
    raceName: null,
    className: null,
    professionName: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    archived: false,
    imported: false,
    raceGrade: "G",
    raceLevel: 0,
    raceGradeBand: { min: 0, max: 10 },
    portrait: null,
    ...overrides,
  }
}

describe("race progression badges", () => {
  it("shows distinct explicit grade palettes for every grade", () => {
    const classes = grades.map((raceGrade) => {
      const { container } = render(<RaceBadges item={item({ raceGrade })} />)
      const badge = screen.getByText(`${raceGrade} grade`)
      const className = badge.className
      container.remove()
      return className
    })
    expect(new Set(classes).size).toBe(grades.length)
  })

  it("uses the provided grade independently from level", () => {
    render(<RaceBadges item={item({ raceGrade: "G", raceLevel: 9 })} />)
    expect(screen.getByText("G grade")).toBeTruthy()
    expect(screen.getByText("9").getAttribute("aria-label")).toBe(
      "Race level 9, Pinnacle, inferred"
    )
  })

  it("classifies band boundaries and clamped out-of-band levels", () => {
    expect(getRaceLevelTier(0, { min: 0, max: 10 })).toBe("Early")
    expect(getRaceLevelTier(2, { min: 0, max: 10 })).toBe("Early")
    expect(getRaceLevelTier(3, { min: 0, max: 10 })).toBe("Developing")
    expect(getRaceLevelTier(8, { min: 0, max: 10 })).toBe("Late")
    expect(getRaceLevelTier(9, { min: 0, max: 10 })).toBe("Pinnacle")
    expect(getRaceLevelTier(10, { min: 0, max: 10 })).toBe("Pinnacle")
    expect(getRaceLevelTier(-1, { min: 0, max: 10 })).toBe("Early")
    expect(getRaceLevelTier(0, { min: 0, max: 10 })).toBe("Early")
    expect(getRaceLevelTier(5, { min: 5, max: 5 })).toBe("Pinnacle")
    expect(getRaceLevelTier(4, { min: 5, max: 5 })).toBe("Early")
  })

  it("uses the documented E-grade stages and assigns shared boundaries upward", () => {
    const band = { min: 25, max: 99 }
    const expected = [
      [49, "Early"],
      [50, "Mid"],
      [74, "Mid"],
      [75, "Late"],
      [94, "Late"],
      [95, "Pinnacle"],
      [99, "Pinnacle"],
    ] as const
    for (const [level, tier] of expected) {
      expect(getRaceLevelTier(level, band, "E")).toBe(tier)
    }
    expect(getRaceLevelTier(24, band, "E")).toBe("Early")
    expect(getRaceLevelTier(100, band, "E")).toBe("Pinnacle")
    render(
      <RaceBadges
        item={item({ raceGrade: "E", raceLevel: 50, raceGradeBand: band })}
      />
    )
    expect(screen.getByText("50").getAttribute("aria-label")).toBe(
      "Race level 50, Mid"
    )
  })

  it("keeps custom E bands on the generic inferred fraction tiers", () => {
    expect(getRaceLevelTier(50, { min: 25, max: 100 }, "E")).toBe("Developing")
    render(
      <RaceBadges
        item={{
          ...item({ raceGrade: "E", raceLevel: 50 }),
          raceGradeBand: { min: 25, max: 100 },
        }}
      />
    )
    expect(screen.getByText("50").getAttribute("aria-label")).toBe(
      "Race level 50, Developing, inferred"
    )
  })

  it("keeps high-grade level zero early and uses a neutral level without a band", () => {
    render(
      <RaceBadges
        item={item({
          raceGrade: "B",
          raceLevel: 0,
          raceGradeBand: { min: 4, max: 8 },
        })}
      />
    )
    expect(screen.getByText("B grade")).toBeTruthy()
    expect(screen.getByText("0").getAttribute("aria-label")).toBe(
      "Race level 0, Early, inferred"
    )
    render(<RaceBadges item={item({ raceGradeBand: null, raceLevel: 12 })} />)
    expect(screen.getByText("12").getAttribute("aria-label")).toBe(
      "Race level 12"
    )
  })
})

describe("character portrait", () => {
  it("shows the private portrait URL with character-specific alternative text", () => {
    render(
      <CharacterPortrait
        item={item({
          portrait: { assetId: "asset-1", url: "/api/assets/asset-1" },
        })}
      />
    )
    const image = screen.getByRole("img", { name: "Test portrait" })
    expect(image.getAttribute("src")).toBe("/api/assets/asset-1")
    expect(screen.queryByText("T")).toBeNull()
  })

  it("shows stable initials when no portrait exists", () => {
    render(<CharacterPortrait item={item({ portrait: null, name: "Mira" })} />)
    expect(screen.getByText("M")).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("shows initials after image failure and resets when portrait URL changes", () => {
    const first = item({
      portrait: { assetId: "one", url: "/one" },
      name: "Mira",
    })
    const { rerender } = render(<CharacterPortrait item={first} />)
    fireEvent.error(screen.getByRole("img", { name: "Mira portrait" }))
    expect(screen.getByText("M")).toBeTruthy()
    rerender(
      <CharacterPortrait
        item={{
          ...first,
          portrait: { assetId: "two", url: "/two" },
          name: "Nova",
        }}
      />
    )
    expect(
      screen.getByRole("img", { name: "Nova portrait" }).getAttribute("src")
    ).toBe("/two")
    expect(screen.queryByText("N")).toBeNull()
  })
})
