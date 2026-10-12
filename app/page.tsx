"use client"

import { AppShell } from "@/components/app-shell"
import { CharactersDashboard } from "@/components/characters/dashboard"

export default function Page() {
  return (
    <AppShell breadcrumbs={[{ label: "Dashboard" }]}>
      <CharactersDashboard />
    </AppShell>
  )
}
