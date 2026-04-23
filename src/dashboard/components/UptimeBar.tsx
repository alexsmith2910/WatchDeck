import { useState, useEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@heroui/react'
import type { DailySummary } from '../types/api'
import { useFormat } from '../hooks/useFormat'

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
  paused: 'text-wd-paused',
  nodata: 'text-wd-muted',
}

// Swatch backgrounds that mirror statusTextColor — used for the tooltip's
// leading swatches so the category reads at a glance without parsing the text.
const statusSwatch: Record<DailyStatus, string> = {
  healthy: 'bg-wd-success',
  degraded: 'bg-wd-warning',
  down: 'bg-wd-danger',
  paused: 'bg-wd-paused',
  nodata: 'bg-wd-muted/60',
}

// Same ladder as utils/format.ts::latencyColor so response-time rows get the
// same semantic tint the table cells already use. Accepts an optional
// threshold so per-endpoint tooltips reflect that endpoint's own
// latencyThreshold instead of a hardcoded 200/500 ladder.
function latencyTone(
  ms: number,
  threshold?: number | null,
): { tint: string; swatch: string } {
  if (ms === 0) return { tint: 'text-wd-muted', swatch: 'bg-wd-muted/60' }
  if (threshold != null && threshold > 0) {
    if (ms < threshold * 0.5) return { tint: 'text-wd-success', swatch: 'bg-wd-success' }
    if (ms < threshold) return { tint: 'text-wd-warning', swatch: 'bg-wd-warning' }
    return { tint: 'text-wd-danger', swatch: 'bg-wd-danger' }
  }
  if (ms < 200) return { tint: 'text-wd-success', swatch: 'bg-wd-success' }
  if (ms < 500) return { tint: 'text-wd-warning', swatch: 'bg-wd-warning' }
  return { tint: 'text-wd-danger', swatch: 'bg-wd-danger' }
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
  /** Endpoint's own latencyThreshold in ms — tints the Avg/P95 tooltip rows. */
  latencyThreshold?: number | null
}

function UptimeBar({ history, loading = false, className, latencyThreshold }: UptimeBarProps) {
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
          <UptimeTooltip
            hovered={hovered}
            rect={hover.rect}
            latencyThreshold={latencyThreshold ?? null}
          />,
          document.body,
        )}
    </>
  )
}

function UptimeTooltip({
  hovered,
  rect,
  latencyThreshold,
}: {
  hovered: DailyBucket
  rect: DOMRect
  latencyThreshold: number | null
}) {
  const fmt = useFormat()
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
      <div className="bg-wd-surface border border-wd-border rounded-lg shadow-lg px-3 py-2.5 text-[11px] min-w-[220px] flex flex-col gap-1.5">
        <div
          className={cn(
            'flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-wider font-mono border-b border-wd-border/50 pb-1.5',
          )}
        >
          <span className="text-wd-muted/80">
            {fmt.date(hovered.date)}
          </span>
          <span className={statusTextColor[hovered.status]}>
            {statusLabel[hovered.status]}
          </span>
        </div>
        {hovered.status !== 'nodata' && hovered.status !== 'paused' ? (
          <>
            <TipRow
              label="Uptime"
              value={
                hovered.uptimePercent != null
                  ? `${hovered.uptimePercent.toFixed(2)}%`
                  : '—'
              }
              color={statusSwatch[hovered.status]}
              valueClass={statusTextColor[hovered.status]}
            />
            <TipRow
              label="Checks"
              value={
                hovered.failCount > 0
                  ? `${hovered.totalChecks.toLocaleString()} · ${hovered.failCount} failed`
                  : hovered.totalChecks.toLocaleString()
              }
              color={hovered.failCount > 0 ? 'bg-wd-danger' : 'bg-wd-success'}
              valueClass={hovered.failCount > 0 ? 'text-wd-danger' : 'text-foreground'}
            />
            {(() => {
              const tone = latencyTone(hovered.avgResponseTime, latencyThreshold)
              return (
                <TipRow
                  label="Avg"
                  value={`${hovered.avgResponseTime}ms`}
                  color={tone.swatch}
                  valueClass={tone.tint}
                />
              )
            })()}
            {hovered.p95ResponseTime > 0 && (() => {
              const tone = latencyTone(hovered.p95ResponseTime, latencyThreshold)
              return (
                <TipRow
                  label="P95"
                  value={`${hovered.p95ResponseTime}ms`}
                  color={tone.swatch}
                  valueClass={tone.tint}
                />
              )
            })()}
            {hovered.incidentCount > 0 && (
              <TipRow
                label="Incidents"
                value={String(hovered.incidentCount)}
                color="bg-wd-danger"
                valueClass="text-wd-danger"
              />
            )}
          </>
        ) : (
          <div
            className={cn(
              'inline-flex items-center gap-1.5',
              statusTextColor[hovered.status],
            )}
          >
            <span aria-hidden className={cn('w-2 h-2 rounded-sm', statusSwatch[hovered.status])} />
            {hovered.status === 'paused'
              ? 'Endpoint was paused during this window'
              : 'No check data for this day'}
          </div>
        )}
      </div>
    </div>
  )
}

function TipRow({
  label,
  value,
  color,
  valueClass,
}: {
  label: string
  value: string
  color: string
  valueClass?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-wd-muted min-w-0">
        <span aria-hidden className={cn('w-2 h-2 rounded-sm shrink-0', color)} />
        <span className="truncate">{label}</span>
      </span>
      <span
        className={cn(
          'font-mono font-medium text-right shrink-0 tabular-nums',
          valueClass ?? 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  )
}

export default memo(UptimeBar)
