/**
 * Suppression breakdown — donut chart on the left, labelled rows on the right.
 * Each row exposes a reason, its share, and a "Filter log" shortcut so users
 * can cross-reference which dispatches were silenced.
 *
 * Data source: `ApiNotificationStats.bySuppressedReason`. Zero-state shows an
 * encouraging empty state rather than an empty donut.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiNotificationStats } from '../../types/notifications'
import { colorForReason, readableReason } from './notificationHelpers'

interface Props {
  stats: ApiNotificationStats | null
  onFilterReason?: (reason: string) => void
}

export function SuppressionPanel({ stats, onFilterReason }: Props) {
  const items = useMemo(() => {
    const reasons = stats?.bySuppressedReason ?? {}
    return Object.entries(reasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => ({
        reason,
        count,
        color: colorForReason(reason),
      }))
      .sort((a, b) => b.count - a.count)
  }, [stats])

  const total = items.reduce((s, i) => s + i.count, 0)
  const top = items[0]

  const sub = total === 0
    ? 'Every eligible alert was delivered in the last 24h.'
    : items.length === 1
      ? `All ${total.toLocaleString()} silences came from ${readableReason(top!.reason).toLowerCase()}.`
      : `${readableReason(top!.reason)} is the top cause (${Math.round((top!.count / total) * 100)}%). Click a row to filter the log.`

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-wd-warning/15 text-wd-warning flex items-center justify-center shrink-0">
            <Icon icon="solar:shield-minus-outline" width={16} />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground leading-tight">
              Suppressed Notifications
            </div>
            <div className="text-[11px] text-wd-muted mt-0.5">{sub}</div>
          </div>
        </div>
        <span className="text-[11px] text-wd-muted font-mono">
          {items.length} {items.length === 1 ? 'reason' : 'reasons'} · {total.toLocaleString()} total
        </span>
      </div>

      {total === 0 ? (
        <div className="h-[180px] flex items-center justify-center text-[12px] text-wd-muted">
          No suppressions in the last 24h.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-5 items-center">
          <Donut items={items} total={total} />
          <div className="flex flex-col gap-1.5">
            {items.map((it) => (
              <Row
                key={it.reason}
                color={it.color}
                label={readableReason(it.reason)}
                count={it.count}
                pct={(it.count / total) * 100}
                onFilter={onFilterReason ? () => onFilterReason(it.reason) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Donut({
  items,
  total,
}: {
  items: Array<{ reason: string; count: number; color: string }>
  total: number
}) {
  const R = 96
  const STROKE = 22
  const C = 2 * Math.PI * R
  const [hover, setHover] = useState<{
    reason: string
    count: number
    pct: number
    color: string
    x: number
    y: number
  } | null>(null)

  // Hide tooltip on scroll so it doesn't strand mid-air when the page scrolls.
  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  let offset = 0
  return (
    <div className="flex justify-center">
      <svg viewBox="0 0 240 240" width="220" height="220" aria-label="Suppression breakdown">
        <circle
          cx={120}
          cy={120}
          r={R}
          fill="none"
          stroke="currentColor"
          className="text-wd-border/30"
          strokeWidth={STROKE}
        />
        {items.map((it) => {
          const frac = it.count / total
          const dash = frac * C
          const pct = frac * 100
          const el = (
            <circle
              key={it.reason}
              cx={120}
              cy={120}
              r={R}
              fill="none"
              stroke={it.color}
              strokeWidth={STROKE}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 120 120)"
              strokeLinecap="butt"
              pointerEvents="stroke"
              style={{ cursor: 'pointer' }}
              onMouseMove={(e) => {
                setHover({
                  reason: it.reason,
                  count: it.count,
                  pct,
                  color: it.color,
                  x: e.clientX,
                  y: e.clientY,
                })
              }}
              onMouseLeave={() => setHover(null)}
            />
          )
          offset += dash
          return el
        })}
        <text
          x={120}
          y={118}
          textAnchor="middle"
          fontSize={42}
          fontWeight={600}
          fill="currentColor"
          className="text-foreground font-mono"
          pointerEvents="none"
        >
          {total.toLocaleString()}
        </text>
        <text
          x={120}
          y={142}
          textAnchor="middle"
          fontSize={10}
          fill="currentColor"
          className="text-wd-muted"
          letterSpacing={2}
          pointerEvents="none"
        >
          SUPPRESSED · 24H
        </text>
      </svg>
      {hover && typeof document !== 'undefined' &&
        createPortal(<DonutTooltip hover={hover} />, document.body)}
    </div>
  )
}

function DonutTooltip({
  hover,
}: {
  hover: { reason: string; count: number; pct: number; color: string; x: number; y: number }
}) {
  const HALF_WIDTH = 110
  const MARGIN = 8
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const left = Math.max(
    HALF_WIDTH + MARGIN,
    Math.min(hover.x, viewportW - HALF_WIDTH - MARGIN),
  )
  const above = hover.y > 80
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left,
        top: above ? hover.y - 12 : hover.y + 12,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px] min-w-[180px]">
        <div className="flex items-center gap-2 mb-1">
          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: hover.color }} />
          <span className="font-semibold text-foreground capitalize">{readableReason(hover.reason)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-wd-muted">Count</span>
          <span className="font-mono font-medium text-foreground">{hover.count.toLocaleString()}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-wd-muted">Share</span>
          <span className="font-mono font-medium" style={{ color: hover.color }}>
            {hover.pct.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  )
}

function Row({
  color,
  label,
  count,
  pct,
  onFilter,
}: {
  color: string
  label: string
  count: number
  pct: number
  onFilter?: () => void
}) {
  const inner = (
    <div className={cn(
      'grid grid-cols-[10px_1fr_60px_48px_40px] items-center gap-3 py-1.5 px-2 rounded-md',
      onFilter && 'hover:bg-wd-surface-hover/50 cursor-pointer',
    )}>
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span className="text-[12px] text-foreground capitalize truncate">{label}</span>
      <span className="h-1.5 rounded-full bg-wd-border/30 overflow-hidden">
        <span className="block h-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="text-[11px] font-mono text-foreground text-right">
        {count.toLocaleString()}
      </span>
      <span className="text-[10.5px] font-mono text-wd-muted text-right">
        {Math.round(pct)}%
      </span>
    </div>
  )
  if (!onFilter) return inner
  return (
    <button type="button" onClick={onFilter} className="text-left">
      {inner}
    </button>
  )
}
