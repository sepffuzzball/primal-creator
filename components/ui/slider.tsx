"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none items-center py-2",
        className
      )}
      {...props}
    />
  )
}
function SliderControl({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Control>) {
  return (
    <SliderPrimitive.Control
      className={cn("flex h-5 w-full items-center", className)}
      {...props}
    />
  )
}
function SliderTrack({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Track>) {
  return (
    <SliderPrimitive.Track
      className={cn(
        "relative h-2 w-full grow overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    />
  )
}
function SliderIndicator({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Indicator>) {
  return (
    <SliderPrimitive.Indicator
      className={cn("absolute h-full bg-primary", className)}
      {...props}
    />
  )
}
function SliderThumb({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Thumb>) {
  return (
    <SliderPrimitive.Thumb
      className={cn(
        "block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
}
export { Slider, SliderControl, SliderTrack, SliderIndicator, SliderThumb }
