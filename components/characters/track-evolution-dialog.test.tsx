// @vitest-environment jsdom
import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TrackEvolutionDialog } from "@/components/characters/track-evolution-dialog"
import { apiFetch } from "@/lib/api"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  jsonInit: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("TrackEvolutionDialog grade badges", () => {
  it("renders the source and destination grades as separate semantic badges", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      options: [
        {
          id: "race-next",
          track: "race",
          name: "Next Race",
          fromGrade: "G",
          toGrade: "F",
          toTrackName: "Next Race",
          eligible: true,
          blockers: [],
        },
      ],
    } as never)
    const character = {
      id: "character-1",
      state: { race: { grade: "G", level: 1 }, tracks: {} },
    } as never
    render(
      <TrackEvolutionDialog
        track="race"
        character={character}
        onClose={vi.fn()}
        onEvolved={vi.fn()}
      />
    )
    await screen.findByText("Next Race")
    expect(
      screen
        .getAllByText("G", { selector: "span" })
        .some((node) => node.className.includes("border-slate-400"))
    ).toBe(true)
    expect(
      screen
        .getAllByText("F", { selector: "span" })
        .some((node) => node.className.includes("border-zinc-400"))
    ).toBe(true)
    expect(screen.getByText("->").getAttribute("aria-hidden")).toBe("true")
  })
})
