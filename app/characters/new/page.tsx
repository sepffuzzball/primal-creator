"use client"

import { AppShell } from "@/components/app-shell"
import { CreateCharacterForm } from "@/components/characters/create-form"

export default function NewCharacterPage() {
  return (
    <AppShell breadcrumbs={[{ label: "New Character" }]}>
      <CreateCharacterForm />
    </AppShell>
  )
}
