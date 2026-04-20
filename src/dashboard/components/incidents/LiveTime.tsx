/**
 * Self-ticking leaf components for live time readouts.
 *
 * Placing the setInterval here (instead of at the page/table level) ensures
 * only the specific DOM node re-renders each second — siblings (sparklines,
 * dropdowns, KPI cards) don't thrash.
 */
import { memo, useEffect, useState } from 'react'
import { cn } from '@heroui/react'
import { fmtLiveDuration } from './incidentHelpers'

function formatUpdatedAgo(sec: number): string {
  if (sec < 1) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function useSecondTicker(enabled: boolean = true): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setTick((t) => (t + 1) & 0xffff), 1000)
    return () => clearInterval(id)
  }, [enabled])
}

/** Renders "just now" / "Xs ago" / "Xm ago" and refreshes itself every second. */
export const LiveUpdatedLabel = memo(function LiveUpdatedLabel({
  lastUpdatedAt,
  prefix,
}: {
  lastUpdatedAt: number
  prefix?: string
}) {
  useSecondTicker(true)
  const label = formatUpdatedAgo(Math.round((Date.now() - lastUpdatedAt) / 1000))
  return <>{prefix ? `${prefix} ${label}` : label}</>
})

/**
 * Live-ticking duration for an active incident. Renders `fmtLiveDuration` and
 * refreshes every second. Pass `enabled={false}` for resolved incidents to
 * skip the interval entirely.
 */
export const LiveDuration = memo(function LiveDuration({
  startedAt,
  className,
  enabled = true,
}: {
  startedAt: string
  className?: string
  enabled?: boolean
}) {
  useSecondTicker(enabled)
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  return <span className={cn(className)}>{fmtLiveDuration(elapsed)}</span>
})
