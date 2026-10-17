import { Badge } from "@/components/ui/badge"

const gradeStyles: Record<string, string> = {
  G: "border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100",
  F: "border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-950 dark:text-zinc-100",
  E: "border-green-600 bg-green-100 text-green-950 dark:border-green-400 dark:bg-green-950 dark:text-green-100",
  D: "border-blue-600 bg-blue-100 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100",
  C: "border-purple-600 bg-purple-100 text-purple-950 dark:border-purple-400 dark:bg-purple-950 dark:text-purple-100",
  B: "border-yellow-600 bg-yellow-100 text-yellow-950 dark:border-yellow-400 dark:bg-yellow-950 dark:text-yellow-100",
  A: "border-orange-600 bg-orange-100 text-orange-950 dark:border-orange-400 dark:bg-orange-950 dark:text-orange-100",
  S: "border-red-600 bg-red-100 text-red-950 dark:border-red-400 dark:bg-red-950 dark:text-red-100",
}

const rarityStyles: Record<string, string> = {
  Unique:
    "border-stone-400 bg-stone-100 text-stone-900 dark:border-stone-500 dark:bg-stone-900 dark:text-stone-100",
  Inferior:
    "border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100",
  Common:
    "border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-950 dark:text-zinc-100",
  Uncommon:
    "border-green-600 bg-green-100 text-green-950 dark:border-green-400 dark:bg-green-950 dark:text-green-100",
  Rare: "border-blue-600 bg-blue-100 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100",
  Epic: "border-purple-600 bg-purple-100 text-purple-950 dark:border-purple-400 dark:bg-purple-950 dark:text-purple-100",
  Ancient:
    "border-yellow-600 bg-yellow-100 text-yellow-950 dark:border-yellow-400 dark:bg-yellow-950 dark:text-yellow-100",
  Legendary:
    "border-orange-600 bg-orange-100 text-orange-950 dark:border-orange-400 dark:bg-orange-950 dark:text-orange-100",
  Mythical:
    "border-red-600 bg-red-100 text-red-950 dark:border-red-400 dark:bg-red-950 dark:text-red-100",
  Sacred:
    "border-slate-300 bg-slate-200 text-slate-950 font-bold dark:border-slate-300 dark:bg-slate-800 dark:text-slate-50",
  Divine:
    "border-amber-400 bg-amber-200 text-amber-950 font-bold dark:border-amber-400 dark:bg-amber-900 dark:text-amber-50",
}

export type SemanticBadgeKind = "grade" | "rarity"

export function semanticBadgeClass(
  kind: SemanticBadgeKind,
  value: string
): string {
  return (
    (kind === "grade" ? gradeStyles : rarityStyles)[value] ??
    "border-border bg-transparent text-foreground"
  )
}

export function SemanticBadge({
  kind,
  value,
  children,
}: {
  kind: SemanticBadgeKind
  value: string
  children?: React.ReactNode
}) {
  return (
    <Badge variant="outline" className={semanticBadgeClass(kind, value)}>
      {children ?? value}
    </Badge>
  )
}
