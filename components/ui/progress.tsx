"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cn } from "cn"

function Progress({
  className,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root className={cn("w-full", className)} {...props} />
  )
}
function ProgressTrack({
  className,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Track>) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    />
  )
}
function ProgressIndicator({
  className,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Indicator>) {
  return (
    <ProgressPrimitive.Indicator
      className={cn("h-full bg-primary transition-[width]", className)}
      {...props}
    />
  )
}
function ProgressLabel({
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Label>) {
  return <ProgressPrimitive.Label {...props} />
}
function ProgressValue({
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Value>) {
  return <ProgressPrimitive.Value {...props} />
}
export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
