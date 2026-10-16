// @vitest-environment jsdom
import * as React from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiFetch } from "@/lib/api"
import SettingsPage from "@/app/settings/page"
import { toast } from "sonner"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, apiFetch: vi.fn() }
})
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAppShell: () => ({
    user: { id: "admin", email: "admin@example.com", isAdmin: true },
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}))
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}))
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: React.ComponentProps<"div">) => (
    <section>{children}</section>
  ),
  CardHeader: ({ children }: React.ComponentProps<"div">) => (
    <header>{children}</header>
  ),
  CardContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  CardTitle: ({ children }: React.ComponentProps<"h2">) => <h2>{children}</h2>,
  CardDescription: ({ children }: React.ComponentProps<"p">) => (
    <p>{children}</p>
  ),
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: React.ComponentProps<"span">) => (
    <span>{children}</span>
  ),
}))
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))
vi.mock("@/components/ui/label", () => ({
  Label: (props: React.ComponentProps<"label">) => <label {...props} />,
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.ComponentProps<"div">) => <>{children}</>,
  DialogContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: React.ComponentProps<"p">) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: React.ComponentProps<"h2">) => (
    <h2>{children}</h2>
  ),
}))

const defaults = {
  equipmentIndividualCapPercent: 20,
  equipmentCombinedCapPercent: 15,
  consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
  maxTranscendentSkills: 3,
  skillChoiceIntervals: { G: 5, F: 5, E: 5, D: 20, C: 30, B: 40, A: 50, S: 60 },
}
const response = (config = defaults, version = 7) => ({
  version,
  config,
  updatedAt: "2026-01-01T00:00:00.000Z",
})

beforeEach(() =>
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === "/api/admin/users") return { users: [] } as never
    if (init?.method === "PATCH")
      return response(JSON.parse(String(init.body)).config, 8) as never
    return response() as never
  })
)
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function load() {
  render(<SettingsPage />)
  await screen.findByText("House rules")
  await screen.findByRole("button", { name: "Save house rules" })
}

describe("admin skill choice settings", () => {
  it("loads versioned settings and renders interval defaults", async () => {
    await load()
    expect(apiFetch).toHaveBeenCalledWith("/api/admin/rules")
    for (const [grade, value] of Object.entries(
      defaults.skillChoiceIntervals
    )) {
      expect(
        (screen.getByLabelText(`${grade} Class interval`) as HTMLInputElement)
          .value
      ).toBe(String(value))
      expect(screen.getAllByText(`Default ${value}.`).length).toBeGreaterThan(0)
    }
    expect(
      screen.getByText(/Monster Race G grants credits every 5 levels/)
    ).toBeTruthy()
  })

  it("PATCHes the complete versioned configuration, preserving other house rules", async () => {
    await load()
    const values = { G: 6, F: 6, E: 7, D: 21, C: 31, B: 41, A: 51, S: 61 }
    for (const [grade, value] of Object.entries(values))
      fireEvent.change(screen.getByLabelText(`${grade} Class interval`), {
        target: { value: String(value) },
      })
    fireEvent.click(screen.getByRole("button", { name: "Save house rules" }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/admin/rules",
        expect.objectContaining({ method: "PATCH" })
      )
    )
    const init = vi
      .mocked(apiFetch)
      .mock.calls.find((call) => call[1]?.method === "PATCH")?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({
      version: 7,
      config: { ...defaults, skillChoiceIntervals: values },
    })
  })

  it.each(["", "2.5", "0", "251"])(
    "rejects interval value %s without PATCH",
    async (value) => {
      await load()
      const field = screen.getByLabelText("F Class interval")
      fireEvent.change(field, { target: { value } })
      fireEvent.blur(field)
      fireEvent.click(screen.getByRole("button", { name: "Save house rules" }))
      expect(
        await screen.findByText("Enter a whole number from 1 to 250.")
      ).toBeTruthy()
      expect(apiFetch).not.toHaveBeenCalledWith(
        "/api/admin/rules",
        expect.objectContaining({ method: "PATCH" })
      )
    }
  )

  it.each(["", "2.5", "0", "251"])(
    "rejects G interval value %s without PATCH",
    async (value) => {
      await load()
      const field = screen.getByLabelText("G Class interval")
      fireEvent.change(field, { target: { value } })
      fireEvent.blur(field)
      fireEvent.click(screen.getByRole("button", { name: "Save house rules" }))
      expect(
        await screen.findByText("Enter a whole number from 1 to 250.")
      ).toBeTruthy()
      expect(apiFetch).not.toHaveBeenCalledWith(
        "/api/admin/rules",
        expect.objectContaining({ method: "PATCH" })
      )
    }
  )

  it("shows and saves the latest server values after a CAS conflict", async () => {
    await load()
    fireEvent.change(screen.getByLabelText("B Class interval"), {
      target: { value: "44" },
    })
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === "/api/admin/users") return { users: [] } as never
      if (init?.method === "PATCH")
        throw new ApiError(409, "conflict", "Conflict")
      return response(
        {
          ...defaults,
          skillChoiceIntervals: { ...defaults.skillChoiceIntervals, B: 42 },
        },
        8
      ) as never
    })
    fireEvent.click(screen.getByRole("button", { name: "Save house rules" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "House rules changed elsewhere. Reloading the latest values."
      )
    )
    expect(await screen.findByText("8")).toBeTruthy()
    expect(
      (screen.getByLabelText("B Class interval") as HTMLInputElement).value
    ).toBe("42")

    fireEvent.click(screen.getByRole("button", { name: "Save house rules" }))
    await waitFor(() =>
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter((call) => call[1]?.method === "PATCH")
      ).toHaveLength(2)
    )
    const retry = vi
      .mocked(apiFetch)
      .mock.calls.filter((call) => call[1]?.method === "PATCH")[1]?.[1]
    expect(JSON.parse(String(retry?.body))).toEqual({
      version: 8,
      config: {
        ...defaults,
        skillChoiceIntervals: { ...defaults.skillChoiceIntervals, B: 42 },
      },
    })
  })
})
