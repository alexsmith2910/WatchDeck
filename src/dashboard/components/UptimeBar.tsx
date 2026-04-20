import { useState, useEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@heroui/react'
import type { DailySummary } from '../types/api'

export type DailyStatus = 'healthy' | 'degraded' | 'down' | 'paused' | 'nodata'

export interface DailyBucket {
  date: Date
  status: DailyStatus
  uptimePercent: number | null
  totalChecks: number
  failCount: number
  avgResponseTime: number
  p95ResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  incidentCount: number
}

const statusLabel: Record<DailyStatus, string> = {
  healthy: 'Operational',
  degraded: 'Degraded',
  down: 'Outage',
  paused: 'Paused',
  nodata: 'No data',
}

const statusTextColor: Record<DailyStatus, string> = {
  healthy: 'text-wd-success',
  degraded: 'text-wd-warning',
  down: 'text-wd-danger',
  paused: 'text-wd-muted',
  nodata: 'text-wd-muted',
}

export function buildHistory(dailies: DailySummary[], days = 30): DailyBucket[] {
  const byKey = new Map<string, DailySummary>()
  for (const d of dailies) {
    const key = new Date(d.date).toISOString().slice(0, 10)
    byKey.set(key, d)
  }

  // Cells are keyed by UTC day to match the backend's aggregation model
  // (daily summaries are stored and synthesised at UTC midnight).
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const buckets: DailyBucket[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today)
    date.setUTCDate(today.getUTCDate() - i)
    const key = date.toISOString().slice(0, 10)
    const match = byKey.get(key)

    if (!match) {
      buckets.push({
        date,
        status: 'nodata',
        uptimePercent: null,
        totalChecks: 0,
        failCount: 0,
        avgResponseTime: 0,
        p95ResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        incidentCount: 0,
      })
    } else {
      const pct = match.uptimePercent
      const status: DailyStatus =
        pct < 95 ? 'down' : pct < 99.9 ? 'degraded' : 'healthy'
      buckets.push({
        date,
        status,
        uptimePercent: pct,
        totalChecks: match.totalChecks,
        failCount: Math.max(0, Math.round((match.totalChecks * (100 - pct)) / 100)),
        avgResponseTime: match.avgResponseTime,
        p95ResponseTime: match.p95ResponseTime,
        minResponseTime: match.minResponseTime,
        maxResponseTime: match.maxResponseTime,
        incidentCount: match.incidentCount,
      })
    }
  }
  return buckets
}

export function avg30dResponse(dailies: DailySummary[]): number | null {
  if (dailies.length === 0) return null
  let sum = 0
  let count = 0
  for (const d of dailies) {
    sum += d.avgResponseTime * d.totalChecks
    count += d.totalChecks
  }
  return count > 0 ? Math.round(sum / count) : null
}

export function avg30dUptime(dailies: DailySummary[]): number | null {
  if (dailies.length === 0) return null
  let sum = 0
  let count = 0
  for (const d of dailies) {
    sum += d.uptimePercent * d.totalChecks
    count += d.totalChecks
  }
  return count > 0 ? sum / count : null
}

// Timing constants — must match globals.css keyframes.
// The pulse cycle is sweep_time + rest_pad so one full left-to-right pass
// completes before the next one begins.
const STAGGER = 40
const REST_PAD = 500
const REVEAL_DURATION = 650
const pulseCycleMs = (n: number) => Math.max(1, n - 1) * STAGGER + REST_PAD

type Stage = 'loading' | 'settling' | 'reveal' | 'done'

interface UptimeBarProps {
  history: DailyBucket[]
  loading?: boolean
  className?: string
}

function UptimeBar({ history, loading = false, className }: UptimeBarProps) {
  const [hover, setHover] = useState<{ idx: number; rect: DOMRect } | null>(null)
  const [stage, setStage] = useState<Stage>(loading ? 'loading' : 'done')
  const loadStartMs = useRef<number>(performance.now())
  const prevLoading = useRef(loading)

  // Orchestrate stage transitions on loading prop changes.
  //   true → false: wait for the current wave pass to finish (cycle boundary),
  //                 then reveal → done.
  //   false → true: restart the wave.
  // At a cycle boundary every cell is in the pulse's rest state (scaleY 1,
  // brightness 0.82), which matches the reveal animation's 0% frame, so the
  // hand-off is visually seamless.
  useEffect(() => {
    if (prevLoading.current === loading) return

    if (prevLoading.current && !loading) {
      const cycle = pulseCycleMs(history.length)
      const elapsed = performance.now() - loadStartMs.current
      const settleWait = cycle - (elapsed % cycle)
      setStage('settling')
      const toReveal = window.setTimeout(() => setStage('reveal'), settleWait)
      const toDone = window.setTimeout(
        () => setStage('done'),
        settleWait + (history.length - 1) * STAGGER + REVEAL_DURATION,
      )
      prevLoading.current = loading
      return () => {
        window.clearTimeout(toReveal)
        window.clearTimeout(toDone)
      }
    }

    // false → true
    loadStartMs.current = performance.now()
    setStage('loading')
    prevLoading.current = loading
  }, [loading, history.length])

  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  const hovered = hover ? history[hover.idx] : null
  const interactive = stage === 'done'

  return (
    <>
      <div
        className={cn('wd-up-bar h-[22px]', className)}
        data-stage={stage}
        style={{
          ['--wd-up-cycle' as string]: `${pulseCycleMs(history.length)}ms`,
          ['--wd-up-stagger' as string]: `${STAGGER}ms`,
        }}
        onMouseLeave={() => setHover(null)}
      >
        {history.map((b, i) => (
          <div
            key={i}
            className="wd-up-cell"
            data-status={b.status}
            style={{ ['--cell-idx' as string]: i }}
            onMouseEnter={(e) => {
              if (!interactive) return
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setHover({ idx: i, rect })
            }}
          />
        ))}
      </div>
      {hovered && hover && typeof document !== 'undefined' &&
        createPortal(
          <UptimeTooltip hovered={hovered} rect={hover.rect} />,
          document.body,
        )}
    </>
  )
}

function UptimeTooltip({ hovered, rect }: { hovered: DailyBucket; rect: DOMRect }) {
  // Clamp the tooltip's left edge so it never clips past the viewport.
  // Half-width 130 covers typical content within the min-w-[220px] box.
  const HALF_WIDTH = 130
  const MARGIN = 8
  const cellCenter = rect.left + rect.width / 2
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const clampedLeft = Math.max(
    HALF_WIDTH + MARGIN,
    Math.min(cellCenter, viewportW - HALF_WIDTH - MARGIN),
  )
  const above = rect.top > 140

  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left: clampedLeft,
        top: above ? rect.top - 8 : rect.bottom + 8,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="bg-wd-surface border border-wd-border rounded-md shadow-lg px-3 py-2 text-[11px] min-w-[220px]">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-mono text-[10.5px] text-wd-muted">
            {hovered.date.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </span>
          <span
            className={cn(
              'text-[10px] font-semibold uppercase tracking-wider',
              statusTextColor[hovered.status],
            )}
          >
            {statusLabel[hovered.status]}
          </span>
        </div>
        {hovered.status !== 'nodata' && hovered.status !== 'paused' ? (
          <div className="space-y-1">
            <TipRow
              label="Uptime"
              value={
                hovered.uptimePercent != null
                  ? `${hovered.uptimePercent.toFixed(2)}%`
                  : '—'
              }
            />
            <TipRow
              label="Checks"
              value={
                hovered.failCount > 0
                  ? `${hovered.totalChecks.toLocaleString()} · ${hovered.failCount} failed`
                  : hovered.totalChecks.toLocaleString()
              }
            />
            <TipRow label="Avg" value={`${hovered.avgResponseTime}ms`} />
            {hovered.p95ResponseTime > 0 && (
              <TipRow label="P95" value={`${hovered.p95ResponseTime}ms`} />
            )}
            {hovered.incidentCount > 0 && (
              <TipRow label="Incidents" value={String(hovered.incidentCount)} />
            )}
          </div>
        ) : (
          <div className="italic text-wd-muted/70 text-[11px]">
            {hovered.status === 'paused'
              ? 'Endpoint was paused during this window'
              : 'No check data for this day'}
          </div>
        )}
      </div>
    </div>
  )
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-wd-muted min-w-[56px]">{label}</span>
      <span className="font-mono font-medium text-right flex-1 text-foreground">
        {value}
      </span>
    </div>
  )
}

export default memo(UptimeBar)
