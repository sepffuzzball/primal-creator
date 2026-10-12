"use client"

import * as React from "react"
import { CharacterDetail } from "@/components/characters/character-detail"
import { AppShell } from "@/components/app-shell"

export default function CharacterPage() {
  const [name, setName] = React.useState<string | null>(null)

  const handleNameChange = React.useCallback((nextName: string) => {
    setName(nextName)
  }, [])

  return (
    <AppShell
      breadcrumbs={[
        { label: "Characters", href: "/" },
        { label: name ?? "Character" },
      ]}
    >
      <CharacterDetail onNameChange={handleNameChange} />
    </AppShell>
  )
}
