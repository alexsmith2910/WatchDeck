/**
 * Charts for the Notifications page:
 *   - DispatchChart — stacked bars, one stack per time bucket, colored by
 *     channel type plus a red segment for failures.
 *   - LatencyChart  — p50 line + p95 shaded band across the same buckets.
 *
 * Both charts are responsive (ResizeObserver) and share tooltip styling.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { ChartBucket } from './notificationHelpers'

export interface DispatchSeries {
  key: 'slack' | 'discord' | 'email' | 'webhook' | 'failed'
  label: string
  color: string
}

export const DISPATCH_SERIES: DispatchSeries[] = [
  { key: 'slack',   label: 'Slack',   color: 'var(--wd-primary)' },
  { key: 'discord', label: 'Discord', color: '#5865F2' },
  { key: 'email',   label: 'Email',   color: '#a78bfa' },
  { key: 'webhook', label: 'Webhook', color: '#22d3ee' },
  { key: 'failed',  label: 'Failed',  color: 'var(--wd-danger)' },
]

// ---------------------------------------------------------------------------
// Chart shell
// ---------------------------------------------------------------------------

function ChartHeader({
  icon,
  title,
  sub,
  legend,
  hint,
}: {
  icon: string
  title: string
  sub: string
  legend?: Array<{ label: string; color: string }>
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-wd-primary/15 text-wd-primary flex items-center justify-center shrink-0">
          <Icon icon={icon} width={16} />
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground leading-tight">{title}</div>
          <div className="text-[11px] text-wd-muted mt-0.5">{sub}</div>
        </div>
      </div>
      {legend && legend.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-wd-muted">
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      ) : hint ? (
        <span className="text-[11px] text-wd-muted">{hint}</span>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared tooltip primitives (used by both charts)
// ---------------------------------------------------------------------------

const TOOLTIP_W = 188

function ChartTooltip({
  x,
  chartW,
  top,
  children,
}: {
  x: number
  chartW: number
  top: number
  children: React.ReactNode
}) {
  // Keep tooltip body inside the chart bounds so it's not clipped near edges.
  const half = TOOLTIP_W / 2
  const minLeft = half + 4
  const maxLeft = chartW - half - 4
  const clampedX = Math.max(minLeft, Math.min(maxLeft, x))
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-wd-border bg-wd-surface shadow-lg px-3 py-2.5 text-[11px] flex flex-col gap-1.5"
      style={{ left: `${(clampedX / chartW) * 100}%`, top: top - 6, width: TOOLTIP_W }}
    >
      {children}
    </div>
  )
}

function ChartTooltipHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-wd-muted/80 font-mono border-b border-wd-border/50 pb-1.5">
      {children}
    </div>
  )
}

function ChartTooltipRow({
  color,
  label,
  value,
}: {
  color: string
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-wd-muted">
        <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
        {label}
      </span>
      <span className="font-mono font-medium text-foreground">{value}</span>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex-1 min-h-[240px] flex items-center justify-center text-[12px] text-wd-muted">
      {message}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DispatchChart — stacked bars
// ---------------------------------------------------------------------------

export const DispatchChart = memo(function DispatchChart({
  data,
  height = 240,
}: {
  data: ChartBucket[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [h, setH] = useState(height)
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((es) => {
      for (const e of es) {
        setW(Math.max(320, e.contentRect.width))
        setH(Math.max(height, e.contentRect.height))
      }
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [height])

  const H = h
  const padL = 40
  const padR = 14
  const padT = 10
  const padB = 26
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, H - padT - padB)

  const hasData = data.some((d) => d.slack + d.discord + d.email + d.webhook + d.failed > 0)

  const totals = data.map((d) => d.slack + d.discord + d.email + d.webhook + d.failed)
  const yMax = Math.max(...(totals.length ? totals : [1]), 1) * 1.2

  const stepX = innerW / Math.max(1, data.length)
  const barW = stepX * 0.68
  const barGap = stepX * 0.32
  const y = (v: number) => padT + innerH - (v / yMax) * innerH

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax)

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w
    if (px < padL || px > w - padR) { setHover(null); return }
    const idx = Math.floor(((px - padL) / innerW) * data.length)
    if (idx < 0 || idx >= data.length) { setHover(null); return }
    setHover({ idx, x: padL + (idx + 0.5) * stepX })
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-w-0 h-full">
      <ChartHeader
        icon="solar:bell-bing-outline"
        title="Dispatch Volume by Channel"
        sub="Successful deliveries per channel with failed attempts highlighted"
        legend={DISPATCH_SERIES.map((s) => ({ label: s.label, color: s.color }))}
      />
      {hasData ? (
        <>
          <div ref={ref} className="relative w-full flex-1 min-h-[240px]">
            <svg
              viewBox={`0 0 ${w} ${H}`}
              width="100%"
              height={H}
              preserveAspectRatio="none"
              className="block cursor-crosshair"
              onMouseMove={handleMove}
              onMouseLeave={() => setHover(null)}
            >
              {ticks.map((t, i) => (
                <g key={i}>
                  <line
                    x1={padL}
                    x2={w - padR}
                    y1={y(t)}
                    y2={y(t)}
                    stroke="currentColor"
                    className="text-wd-border/40"
                    strokeDasharray="2 4"
                  />
                  <text
                    x={padL - 6}
                    y={y(t) + 3}
                    fontSize="9.5"
                    fill="currentColor"
                    className="text-wd-muted/70"
                    textAnchor="end"
                  >
                    {Math.round(t)}
                  </text>
                </g>
              ))}

              {data.map((d, i) => {
                let acc = 0
                const x0 = padL + i * stepX + barGap / 2
                return (
                  <g key={i} opacity={hover && hover.idx !== i ? 0.55 : 1}>
                    {DISPATCH_SERIES.map((s) => {
                      const v = d[s.key]
                      if (v === 0) return null
                      const h = (v / yMax) * innerH
                      const y0 = padT + innerH - acc - h
                      acc += h
                      return <rect key={s.key} x={x0} y={y0} width={barW} height={h} fill={s.color} rx="1.5" />
                    })}
                  </g>
                )
              })}

              {hover && (
                <line
                  x1={hover.x}
                  x2={hover.x}
                  y1={padT}
                  y2={padT + innerH}
                  stroke="currentColor"
                  className="text-wd-border"
                  strokeDasharray="3 3"
                />
              )}
            </svg>

            {hover && data[hover.idx] && (
              <ChartTooltip x={hover.x} chartW={w} top={padT}>
                <ChartTooltipHeader>{data[hover.idx].label}</ChartTooltipHeader>
                {DISPATCH_SERIES.map((s) => {
                  const v = data[hover.idx][s.key]
                  if (v === 0) return null
                  return (
                    <ChartTooltipRow
                      key={s.key}
                      color={s.color}
                      label={s.label}
                      value={String(v)}
                    />
                  )
                })}
              </ChartTooltip>
            )}
          </div>
          <div className="flex justify-between text-[10px] text-wd-muted font-mono pl-10 pr-3.5">
            {data
              .filter((_, i) => i % Math.max(1, Math.ceil(data.length / 6)) === 0 || i === data.length - 1)
              .map((d, i) => <span key={i}>{d.label}</span>)}
          </div>
        </>
      ) : (
        <EmptyState message="No dispatches in the selected window yet." />
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// LatencyChart — p50 line + p95 band
// ---------------------------------------------------------------------------

export const LatencyChart = memo(function LatencyChart({
  data,
  height = 240,
}: {
  data: ChartBucket[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [h, setH] = useState(height)
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((es) => {
      for (const e of es) {
        setW(Math.max(320, e.contentRect.width))
        setH(Math.max(height, e.contentRect.height))
      }
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [height])

  const H = h
  const padL = 48
  const padR = 14
  const padT = 10
  const padB = 26
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, H - padT - padB)

  const points = data
    .map((d, i) => ({ i, p50: d.p50, p95: d.p95 }))
    .filter((p): p is { i: number; p50: number; p95: number } => p.p50 !== null && p.p95 !== null)

  const allVals = points.flatMap((p) => [p.p50, p.p95])
  const yMax = Math.max(...(allVals.length ? allVals : [1000]), 100) * 1.12

  const stepX = innerW / Math.max(1, data.length)
  const barW = Math.min(6, Math.max(2, stepX * 0.36))
  const xCenter = (i: number) => padL + (i + 0.5) * stepX
  const y = (v: number) => padT + innerH - (v / yMax) * innerH

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax)

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w
    if (px < padL || px > w - padR) { setHover(null); return }
    const idx = Math.floor(((px - padL) / innerW) * data.length)
    if (idx < 0 || idx >= data.length) { setHover(null); return }
    setHover({ idx, x: xCenter(idx) })
  }

  const hoverPoint = hover && data[hover.idx] && data[hover.idx].p50 !== null && data[hover.idx].p95 !== null
    ? { p50: data[hover.idx].p50 as number, p95: data[hover.idx].p95 as number }
    : null

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-w-0 h-full">
      <ChartHeader
        icon="solar:stopwatch-outline"
        title="Delivery Latency"
        sub="Round-trip time from alert firing to provider acknowledgement"
        legend={[
          { label: 'p50', color: 'var(--wd-primary)' },
          { label: 'p95', color: 'var(--wd-warning)' },
        ]}
      />
      <div ref={ref} className="relative w-full flex-1 min-h-[240px]">
        <svg
          viewBox={`0 0 ${w} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          className="block cursor-crosshair"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={padL}
                x2={w - padR}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                className="text-wd-border/40"
                strokeDasharray="2 4"
              />
              <text
                x={padL - 6}
                y={y(t) + 3}
                fontSize="9.5"
                fill="currentColor"
                className="text-wd-muted/70"
                textAnchor="end"
              >
                {Math.round(t)}ms
              </text>
            </g>
          ))}

          {points.map((p) => {
            const cx = xCenter(p.i)
            const top = Math.min(y(p.p50), y(p.p95))
            const bot = Math.max(y(p.p50), y(p.p95))
            const span = Math.max(2, bot - top)
            const isHover = hover?.idx === p.i
            return (
              <g key={p.i} opacity={hover && !isHover ? 0.55 : 1}>
                <rect
                  x={cx - barW / 2}
                  y={top}
                  width={barW}
                  height={span}
                  rx={barW / 2}
                  fill="var(--wd-warning)"
                  fillOpacity={0.55}
                />
                <circle cx={cx} cy={y(p.p95)} r={barW / 2 + 0.5} fill="var(--wd-warning)" />
                <circle cx={cx} cy={y(p.p50)} r={barW / 2 + 1} fill="var(--wd-primary)" stroke="var(--background)" strokeWidth="1" />
              </g>
            )
          })}

          {hover && (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={padT}
              y2={padT + innerH}
              stroke="currentColor"
              className="text-wd-border"
              strokeDasharray="3 3"
            />
          )}
        </svg>
        {hover && data[hover.idx] && (
          <ChartTooltip x={hover.x} chartW={w} top={padT}>
            <ChartTooltipHeader>{data[hover.idx].label}</ChartTooltipHeader>
            <ChartTooltipRow
              color="var(--wd-primary)"
              label="p50"
              value={hoverPoint ? `${Math.round(hoverPoint.p50)}ms` : '—'}
            />
            <ChartTooltipRow
              color="var(--wd-warning)"
              label="p95"
              value={hoverPoint ? `${Math.round(hoverPoint.p95)}ms` : '—'}
            />
          </ChartTooltip>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-wd-muted font-mono pl-12 pr-3.5">
        {data
          .filter((_, i) => i % Math.max(1, Math.ceil(data.length / 6)) === 0 || i === data.length - 1)
          .map((d, i) => <span key={i}>{d.label}</span>)}
      </div>
    </div>
  )
})
