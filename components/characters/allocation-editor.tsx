"use client"

import * as React from "react"

import { ATTRIBUTE_KEYS, type AttributeKey, type StatusResult } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface AllocationEditorProps {
  status: StatusResult
  onAllocate: (
    allocation: Partial<Record<AttributeKey, number>>
  ) => Promise<void>
  busy: boolean
}

function labelFor(key: AttributeKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1)
}

export function AllocationEditor({
  status,
  onAllocate,
  busy,
}: AllocationEditorProps) {
  const [draft, setDraft] = React.useState<Record<AttributeKey, number>>(() => {
    const out = {} as Record<AttributeKey, number>
    for (const key of ATTRIBUTE_KEYS) out[key] = 0
    return out
  })

  const available = status.availablePoints
  const allocated = ATTRIBUTE_KEYS.reduce((sum, key) => sum + draft[key], 0)
  const remaining = available - allocated

  const setValue = React.useCallback(
    (key: AttributeKey, raw: string) => {
      const parsed = Number.parseInt(raw, 10)
      const value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0
      setDraft((d) => {
        const others = ATTRIBUTE_KEYS.reduce(
          (sum, k) => (k === key ? sum : sum + d[k]),
          0
        )
        const capped = Math.min(value, available - others)
        return { ...d, [key]: Math.max(0, capped) }
      })
    },
    [available]
  )

  const canSubmit = !busy && allocated > 0 && allocated <= available

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    const allocation: Partial<Record<AttributeKey, number>> = {}
    for (const key of ATTRIBUTE_KEYS) {
      if (draft[key] > 0) allocation[key] = draft[key]
    }
    await onAllocate(allocation)
    const reset = {} as Record<AttributeKey, number>
    for (const key of ATTRIBUTE_KEYS) reset[key] = 0
    setDraft(reset)
  }, [canSubmit, draft, onAllocate])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs/relaxed">
        <span className="text-muted-foreground">
          Available points: {available}
        </span>
        <span className="text-muted-foreground">
          Allocated: {allocated} / remaining: {remaining}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {ATTRIBUTE_KEYS.map((key) => {
          const current = status.attributes[key]
          const preview = current + draft[key]
          return (
            <div
              key={key}
              className="flex flex-col gap-1 rounded-lg border bg-input/20 p-2"
            >
              <label
                htmlFor={`alloc-${key}`}
                className="text-xs font-medium capitalize"
              >
                {labelFor(key)}
              </label>
              <Input
                id={`alloc-${key}`}
                type="number"
                min={0}
                max={available}
                value={draft[key]}
                onChange={(e) => setValue(key, e.target.value)}
              />
              <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground">
                <span>Current: {current}</span>
                <span>After: {preview}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? "Allocating..." : "Confirm allocation"}
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">
          Final attribute values are recomputed by the server after you confirm.
        </span>
      </div>

      {available === 0 ? (
        <p className="text-xs text-muted-foreground">
          No free points are available yet. Advance the class or profession to
          gain points.
        </p>
      ) : null}
    </div>
  )
}
