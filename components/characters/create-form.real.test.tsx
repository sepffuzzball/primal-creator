// @vitest-environment jsdom
import * as React from "react"
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { CreateCharacterForm } from "@/components/characters/create-form"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {
    status = 500
  },
  jsonInit: (method: string, body?: unknown) => ({
    method,
    body: body && JSON.stringify(body),
  }),
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/drafts")
      return init?.method === "PUT"
        ? { draft: { id: "d", version: 1, data: {} } }
        : { draft: null }
    if (url === "/api/rules/creation") return { maxTranscendentSkills: 3 }
    if (url === "/api/catalog/races")
      return {
        items: [
          {
            id: "race-test",
            kind: "catalog",
            stableId: "race-test",
            name: "Test race",
            description: null,
            grade: null,
            sourceUrl: null,
            archived: false,
            config: {
              raceType: "enlightened",
              naturalGrade: "F",
              raceDefinitions: { F: {} },
            },
            gradeDescriptions: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }
    return { items: [] }
  }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

it("uses real Questionnaire navigation and blocks leaving invalid stats", async () => {
  window.localStorage.setItem(
    "primal-create-draft",
    JSON.stringify({
      step: "initialStats",
      raceType: "enlightened",
      name: "",
      description: "",
      origin: "",
      raceId: "",
      initialAttributes: Object.fromEntries(
        [
          "strength",
          "agility",
          "endurance",
          "vitality",
          "toughness",
          "wisdom",
          "intelligence",
          "perception",
          "willpower",
        ].map((n) => [n, "1"])
      ),
      classId: "",
      professionId: "",
      special: "none",
      equipment: "none",
      specialAbilities: {
        blessing: null,
        bloodlineIds: [],
        transcendentSkillIds: [],
      },
    })
  )
  render(<CreateCharacterForm />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const questionnaire = document.querySelector(
    '[data-slot="questionnaire"]'
  ) as HTMLFormElement
  expect(questionnaire.dataset.current).toBe("5")
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  expect(questionnaire.dataset.current).toBe("5")
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  expect(questionnaire.dataset.current).toBe("4")
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  fireEvent.click(screen.getByText("Test race"))
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  expect(questionnaire.dataset.current).toBe("5")
  expect((screen.getByLabelText("strength") as HTMLInputElement).value).toBe(
    "1"
  )
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  expect(questionnaire.dataset.current).toBe("4")
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  expect(questionnaire.dataset.current).toBe("5")
  fireEvent.change(screen.getByLabelText("strength"), {
    target: { value: "62" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  expect(questionnaire.dataset.current).toBe("6")
})
