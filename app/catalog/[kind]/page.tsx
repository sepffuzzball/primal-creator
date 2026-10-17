"use client"

import * as React from "react"
import { useParams } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { CatalogManager } from "@/components/catalog/catalog-manager"

const KIND_LABELS: Record<string, string> = {
  races: "Races",
  classes: "Classes",
  professions: "Professions",
  titles: "Titles",
  equipment: "Equipment",
  skills: "Skills",
  bloodlines: "Bloodlines",
  items: "Items",
  currencies: "Currencies",
  gods: "Gods",
  transcendent_skills: "Transcendent Skills",
}

export default function CatalogPage() {
  const params = useParams<{ kind: string }>()
  // Blessings is retired as a catalog kind; legacy links now land on Gods.
  const kind = params.kind === "blessings" ? "gods" : params.kind
  const label = KIND_LABELS[kind] ?? kind

  return (
    <AppShell
      breadcrumbs={[{ label: "Catalog", href: "/catalog/races" }, { label }]}
    >
      <CatalogManager kind={kind} />
    </AppShell>
  )
}
