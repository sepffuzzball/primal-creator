// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  semanticBadgeClass,
  SemanticBadge,
} from "@/components/ui/semantic-badge"

describe("semantic badges", () => {
  it("maps all grades to distinct semantic palettes", () => {
    const grades = ["G", "F", "E", "D", "C", "B", "A", "S"]
    const classes = grades.map((grade) => semanticBadgeClass("grade", grade))
    expect(new Set(classes).size).toBe(grades.length)
    grades.forEach((grade) =>
      expect(classes[grades.indexOf(grade)]).toContain("border-")
    )
  })

  it("maps every rarity, including bold premium rarities", () => {
    const rarities = [
      "Unique",
      "Inferior",
      "Common",
      "Uncommon",
      "Rare",
      "Epic",
      "Ancient",
      "Legendary",
      "Mythical",
      "Sacred",
      "Divine",
    ]
    const classes = rarities.map((rarity) =>
      semanticBadgeClass("rarity", rarity)
    )
    expect(new Set(classes).size).toBe(rarities.length)
    expect(semanticBadgeClass("rarity", "Sacred")).toContain("font-bold")
    expect(semanticBadgeClass("rarity", "Divine")).toContain("font-bold")
  })

  it("renders a neutral outlined fallback for unknown values", () => {
    const { container } = render(
      <SemanticBadge kind="rarity" value="Unknown">
        Unknown
      </SemanticBadge>
    )
    expect(screen.getByText("Unknown")).toBeTruthy()
    expect(container.firstElementChild?.className).toContain("border-border")
  })
})
