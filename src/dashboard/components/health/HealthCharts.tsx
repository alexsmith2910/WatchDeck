import { memo, useId, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { cn, Separator } from '@heroui/react'
import type { HeatmapCell, HeatmapRow, ProbeStatus } from '../../types/systemHealth'

// ---------------------------------------------------------------------------
// Sparkline (inline)
// ---------------------------------------------------------------------------

export const Sparkline = memo(function Sparkline({
  data,
  color = 'var(--wd-primary)',
  width = 100,
  height = 32,
  strokeW = 1.5,
  yMin,
  yMax,
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
  strokeW?: number
  /** Override the baseline (y-axis min). Useful for bounded metrics like
   *  percentages where a flat 100% line should draw at the top, not collapse
   *  to the bottom when min === max. */
  yMin?: number
  /** Override the y-axis max. Pair with `yMin` for bounded ranges (0-100). */
  yMax?: number
}) {
  const reactId = useId()
  if (!data || data.length < 2) return null
  const min = yMin ?? Math.min(...data)
  const max = yMax ?? Math.max(...data)
  const range = max - min || 1
  const stepX = width / (data.length - 1)
  const pts = data.map<[number, number]>((v, i) => [i * stepX, height - ((v - min) / range) * (height - 4) - 2])
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${d} L${width},${height} L0,${height} Z`
  const id = `sg-${reactId.replace(/:/g, '')}`
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className="block"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
})

export const WideSpark = memo(function WideSpark({
  data,
  color = 'var(--wd-primary)',
  height = 48,
  labels,
  formatValue,
  yMin,
  yMax,
}: {
  data: number[]
  color?: string
  height?: number
  /** Per-point labels (typically dates/times). Enables a hover tooltip when
   *  provided; same length as `data`. */
  labels?: string[]
  /** Optional value formatter for the hover tooltip (e.g. `n => `${n} m``). */
  formatValue?: (n: number) => string
  /** Override the baseline (y-axis min). Useful for bounded metrics like
   *  percentages where a flat 100% line should draw at the top, not collapse
   *  to the bottom when min === max. */
  yMin?: number
  /** Override the y-axis max. Pair with `yMin` for bounded ranges (0-100). */
  yMax?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(240)
  const [hover, setHover] = useState<{
    idx: number
    x: number
    y: number
    rect: DOMRect
  } | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(100, e.contentRect.width))
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  // Hide tooltip on scroll so it doesn't strand mid-air when the page scrolls.
  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  const interactive = !!labels && labels.length === data.length && data.length >= 2

  function handleMove(e: React.MouseEvent<HTMLDivElement>): void {
    if (!interactive || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const stepX = w / Math.max(1, data.length - 1)
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(px / stepX)))
    const x = idx * stepX
    const min = yMin ?? Math.min(...data)
    const max = yMax ?? Math.max(...data)
    const range = max - min || 1
    const y = height - ((data[idx] - min) / range) * (height - 4) - 2
    setHover({ idx, x, y, rect })
  }

  return (
    <div
      ref={ref}
      className={cn('relative w-full', interactive && 'cursor-crosshair')}
      style={{ height }}
      onMouseMove={interactive ? handleMove : undefined}
      onMouseLeave={interactive ? () => setHover(null) : undefined}
    >
      <Sparkline data={data} color={color} width={w} height={height} strokeW={1.6} yMin={yMin} yMax={yMax} />
      {interactive && hover && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-wd-border/70"
            style={{ left: hover.x }}
          />
          <div
            className="pointer-events-none absolute w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2"
            style={{
              left: hover.x,
              top: hover.y,
              background: color,
              boxShadow: '0 0 0 2px var(--background, var(--wd-surface))',
            }}
          />
          {typeof document !== 'undefined' &&
            createPortal(
              <SparkTooltip
                rectLeft={hover.rect.left + hover.x}
                rectTop={hover.rect.top + hover.y}
                color={color}
                label={labels![hover.idx]}
                value={formatValue ? formatValue(data[hover.idx]) : String(data[hover.idx])}
              />,
              document.body,
            )}
        </>
      )}
    </div>
  )
})

function SparkTooltip({
  rectLeft,
  rectTop,
  color,
  label,
  value,
}: {
  rectLeft: number
  rectTop: number
  color: string
  label: string
  value: string
}) {
  const HALF_WIDTH = 80
  const MARGIN = 8
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const left = Math.max(
    HALF_WIDTH + MARGIN,
    Math.min(rectLeft, viewportW - HALF_WIDTH - MARGIN),
  )
  const above = rectTop > 80
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left,
        top: above ? rectTop - 12 : rectTop + 12,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="rounded-lg border border-wd-border bg-wd-surface shadow-md px-2.5 py-1.5 text-[11px] whitespace-nowrap">
        <div className="text-wd-muted font-mono text-[10px]">{label}</div>
        <div className="font-mono font-semibold mt-0.5" style={{ color }}>
          {value}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LineChart — SVG with hover crosshair + tooltip
//
// Generic: each series picks values out of the row by `key`. Rows are loosely
// typed (Record<string, number | string | null>) so the same chart renders
// throughput/latency frames AND probe-latency-per-subsystem frames.
// ---------------------------------------------------------------------------

export interface LineSeries {
  key: string
  label: string
  color: string
}

export type LineChartRow = { label: string; ts: number } & Record<string, number | string | null | undefined>

export const LineChart = memo(function LineChart({
  title,
  subtitle,
  icon,
  unit = '',
  series,
  data,
  height = 220,
}: {
  title: string
  subtitle?: string
  icon?: string
  unit?: string
  series: LineSeries[]
  data: LineChartRow[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(320, e.contentRect.width))
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  const H = height
  const padL = 40
  const padR = 14
  const padT = 10
  const padB = 26
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, H - padT - padB)

  function num(v: unknown): number | null {
    if (v === null || v === undefined) return null
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }

  const allVals = series.flatMap((s) => data.map((d) => num(d[s.key])).filter((v): v is number => v !== null))
  const yMin = 0
  const yMax = Math.max(...(allVals.length ? allVals : [1])) * 1.12 || 1

  const x = (i: number) => padL + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH

  function pathFor(key: string): string {
    let started = false
    let out = ''
    for (let i = 0; i < data.length; i++) {
      const v = num(data[i]?.[key])
      if (v === null) {
        started = false
        continue
      }
      out += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `
      started = true
    }
    return out.trim()
  }

  function handleMove(e: React.MouseEvent<SVGSVGElement>): void {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w
    if (px < padL || px > w - padR) {
      setHover(null)
      return
    }
    const rel = (px - padL) / innerW
    const idx = Math.round(rel * (data.length - 1))
    if (idx < 0 || idx >= data.length) {
      setHover(null)
      return
    }
    setHover({ idx, x: x(idx) })
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin))

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="h-7 w-7 rounded-lg bg-wd-primary/15 text-wd-primary flex items-center justify-center shrink-0">
              <Icon icon={icon} width={16} />
            </div>
          )}
          <div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            {subtitle && <div className="text-[11px] text-wd-muted mt-0.5">{subtitle}</div>}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-wd-muted flex-wrap justify-end max-w-[55%]">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div ref={ref} className="relative w-full" style={{ height: H }}>
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
                className="text-wd-muted/70 font-mono"
                textAnchor="end"
              >
                {Math.round(t)}
                {unit ? ` ${unit}` : ''}
              </text>
            </g>
          ))}
          {series.map((s) => (
            <g key={s.key}>
              <path
                d={pathFor(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
          {hover && (
            <g>
              <line
                x1={hover.x}
                x2={hover.x}
                y1={padT}
                y2={padT + innerH}
                stroke="currentColor"
                className="text-wd-border"
                strokeDasharray="3 3"
              />
              {series.map((s) => {
                const v = num(data[hover.idx]?.[s.key])
                if (v === null) return null
                return (
                  <circle
                    key={s.key}
                    cx={hover.x}
                    cy={y(v)}
                    r="3.5"
                    fill={s.color}
                    stroke="var(--background)"
                    strokeWidth="1.5"
                  />
                )
              })}
            </g>
          )}
        </svg>
        {hover && data[hover.idx] && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px] min-w-[180px]"
            style={{ left: `${(hover.x / w) * 100}%`, top: padT - 4 }}
          >
            <div className="text-wd-muted mb-1 font-mono">{data[hover.idx].label}</div>
            {series.map((s) => {
              const v = num(data[hover.idx]?.[s.key])
              return (
                <div key={s.key} className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5 text-wd-muted">
                    <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-mono" style={{ color: s.color }}>
                    {v === null ? '—' : Math.round(v)}
                    {v !== null && unit ? ` ${unit}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-wd-muted font-mono pl-10 pr-3.5">
        {data
          .filter((_, i) => i % Math.max(1, Math.ceil(data.length / 6)) === 0 || i === data.length - 1)
          .map((d, i) => (
            <span key={i}>{d.label}</span>
          ))}
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Heatmap — 24h activity per subsystem, GitHub-commits style.
//
// Color precedence per cell:
//   down > 0     → red
//   degraded > 0 → yellow
//   count > 0    → green at 1 of 4 intensities (relative to row's max count)
//   else         → idle
// ---------------------------------------------------------------------------

function greenStep(intensity: number): string {
  // 4-step ramp like GitHub's contribution graph.
  if (intensity >= 0.75) return 'color-mix(in srgb, var(--wd-success) 90%, transparent)'
  if (intensity >= 0.5) return 'color-mix(in srgb, var(--wd-success) 65%, transparent)'
  if (intensity >= 0.25) return 'color-mix(in srgb, var(--wd-success) 40%, transparent)'
  return 'color-mix(in srgb, var(--wd-success) 20%, transparent)'
}

function cellColor(c: HeatmapCell, rowMax: number): string {
  if (c.down > 0) return 'color-mix(in srgb, var(--wd-danger) 80%, transparent)'
  if (c.degraded > 0) return 'color-mix(in srgb, var(--wd-warning) 75%, transparent)'
  if (c.count <= 0) return 'color-mix(in srgb, var(--wd-muted) 8%, transparent)'
  const intensity = rowMax > 0 ? c.count / rowMax : 0
  return greenStep(intensity)
}

type HeatmapCellState = 'down' | 'degraded' | 'active' | 'idle'

function cellState(c: HeatmapCell): HeatmapCellState {
  if (c.down > 0) return 'down'
  if (c.degraded > 0) return 'degraded'
  if (c.count > 0) return 'active'
  return 'idle'
}

interface HeatmapHover {
  title: string
  cell: HeatmapCell
  bucketStartIso: string
  bucketMinutes: number
  intensity: number
  rect: DOMRect
  /** Probe cadence for this row in ms — used to approximate how long the
   *  subsystem was degraded/down within the bucket. `undefined` for
   *  event-driven (passive) probes where no cadence estimate makes sense. */
  cadenceMs?: number
}

export const Heatmap = memo(function Heatmap({
  rows,
  labels,
  title = 'Subsystem Activity',
  subtitle,
  bucketMinutes = 60,
  cadenceById,
}: {
  rows: HeatmapRow[]
  labels: string[]
  title?: string
  subtitle?: string
  bucketMinutes?: number
  cadenceById?: Record<string, number>
}) {
  const colCount = rows[0]?.values?.length ?? 24
  const [hover, setHover] = useState<HeatmapHover | null>(null)

  // Hide tooltip on scroll — avoids it getting stranded mid-air when the
  // dashboard scrolls while a cell is hovered.
  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-[11px] text-wd-muted mt-0.5">{subtitle}</div>
        </div>
        <div className="inline-flex items-center gap-3 text-[10px] text-wd-muted">
          <span className="inline-flex items-center gap-1">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: 'color-mix(in srgb, var(--wd-muted) 8%, transparent)' }}
            />
            idle
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: greenStep(0.25) }} />
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: greenStep(0.5) }} />
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: greenStep(0.75) }} />
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: greenStep(1) }} />
            healthy
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: 'color-mix(in srgb, var(--wd-warning) 75%, transparent)' }}
            />
            degraded
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: 'color-mix(in srgb, var(--wd-danger) 80%, transparent)' }}
            />
            down
          </span>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto">
        <div className="flex flex-col gap-1 shrink-0">
          {rows.map((r) => (
            <div
              key={r.id}
              className="h-6 flex items-center text-[11px] text-foreground/80 whitespace-nowrap pr-2"
            >
              {r.title}
            </div>
          ))}
        </div>
        <div
          className="flex flex-col gap-1 flex-1 min-w-0"
          onMouseLeave={() => setHover(null)}
        >
          {rows.map((r) => {
            const rowMax = r.values.reduce((m, c) => (c.count > m ? c.count : m), 0)
            return (
              <div
                key={r.id}
                className="grid gap-0.5"
                style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
              >
                {r.values.map((c, ci) => {
                  const intensity = rowMax > 0 ? c.count / rowMax : 0
                  return (
                    <div
                      key={ci}
                      className="h-6 rounded-sm border border-wd-border/20 cursor-default"
                      style={{ background: cellColor(c, rowMax) }}
                      onMouseEnter={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        const cadenceMs = cadenceById?.[r.id]
                        setHover({
                          title: r.title,
                          cell: c,
                          bucketStartIso: labels[ci] ?? '',
                          bucketMinutes,
                          intensity,
                          rect,
                          cadenceMs: cadenceMs && cadenceMs > 0 ? cadenceMs : undefined,
                        })
                      }}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-wd-muted font-mono pl-[100px] pr-1">
        {labels
          .filter((_, i) => i % Math.max(1, Math.ceil(labels.length / 6)) === 0 || i === labels.length - 1)
          .map((l, i) => (
            <span key={i}>
              {new Date(l).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ))}
      </div>
      {hover && typeof document !== 'undefined' &&
        createPortal(<HeatmapTooltip hover={hover} />, document.body)}
    </div>
  )
})

function formatApproxDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

function HeatmapTooltip({ hover }: { hover: HeatmapHover }) {
  const { title, cell, bucketStartIso, bucketMinutes, intensity, rect, cadenceMs } = hover
  const state = cellState(cell)
  const bucketStart = new Date(bucketStartIso)
  const bucketEnd = new Date(bucketStart.getTime() + bucketMinutes * 60_000)
  const sameDay = bucketStart.toDateString() === bucketEnd.toDateString()
  const dateLabel = bucketStart.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const rangeLabel = sameDay
    ? `${fmtTime(bucketStart)} – ${fmtTime(bucketEnd)}`
    : `${fmtTime(bucketStart)} → ${bucketEnd.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })} ${fmtTime(bucketEnd)}`

  const statusPill =
    state === 'down'
      ? { cls: 'bg-wd-danger/15 text-wd-danger', label: 'Down' }
      : state === 'degraded'
        ? { cls: 'bg-wd-warning/15 text-wd-warning', label: 'Degraded' }
        : state === 'active'
          ? { cls: 'bg-wd-success/15 text-wd-success', label: 'Active' }
          : { cls: 'bg-wd-muted/15 text-wd-muted', label: 'Idle' }

  const HALF_WIDTH = 140
  const MARGIN = 8
  const cellCenter = rect.left + rect.width / 2
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const clampedLeft = Math.max(
    HALF_WIDTH + MARGIN,
    Math.min(cellCenter, viewportW - HALF_WIDTH - MARGIN),
  )
  const above = rect.top > 180

  const hasIncident = cell.down > 0 || cell.degraded > 0

  // Approximate probe-observed duration within the bucket. Passive probes
  // (cadence 0) don't yield a meaningful estimate, so we fall back to
  // "observations" in that case.
  let incidentSummary: { label: string; value: string; cls: string } | null = null
  if (cell.down > 0) {
    const value =
      cadenceMs && cadenceMs > 0
        ? `~${formatApproxDuration(cell.down * cadenceMs)}`
        : `${cell.down} observation${cell.down === 1 ? '' : 's'}`
    incidentSummary = { label: 'Down for', value, cls: 'text-wd-danger' }
  } else if (cell.degraded > 0) {
    const value =
      cadenceMs && cadenceMs > 0
        ? `~${formatApproxDuration(cell.degraded * cadenceMs)}`
        : `${cell.degraded} observation${cell.degraded === 1 ? '' : 's'}`
    incidentSummary = { label: 'Degraded for', value, cls: 'text-wd-warning' }
  }

  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left: clampedLeft,
        top: above ? rect.top - 8 : rect.bottom + 8,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px] min-w-[240px]">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-semibold text-foreground">{title}</span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              statusPill.cls,
            )}
          >
            {statusPill.label}
          </span>
        </div>
        <div className="text-[10.5px] text-wd-muted font-mono mb-1.5 whitespace-nowrap">
          {dateLabel} · {rangeLabel}
        </div>
        <div className="space-y-1">
          <TipRow
            label="Activity"
            value={
              cell.count > 0
                ? `${cell.count.toLocaleString()} event${cell.count === 1 ? '' : 's'}`
                : 'none'
            }
          />
          {cell.count > 0 && intensity > 0 && (
            <TipRow label="Intensity" value={`${Math.round(intensity * 100)}% of row peak`} />
          )}
        </div>
        {hasIncident && incidentSummary && (
          <>
            <Separator className="my-2 bg-wd-border/60" />
            <div className="space-y-1">
              <TipRow
                label={incidentSummary.label}
                value={incidentSummary.value}
                valueClass={incidentSummary.cls}
              />
              {cell.degraded > 0 && (
                <TipRow
                  label="Degraded Probes"
                  value={`${cell.degraded}`}
                  valueClass="text-wd-warning"
                />
              )}
              {cell.down > 0 && (
                <TipRow
                  label="Down Probes"
                  value={`${cell.down}`}
                  valueClass="text-wd-danger"
                />
              )}
              {cadenceMs && cadenceMs > 0 && (
                <div className="text-[10px] text-wd-muted/70 italic pt-0.5 whitespace-nowrap">
                  Estimate based on {Math.round(cadenceMs / 1000)}s probe cadence.
                </div>
              )}
            </div>
          </>
        )}
        {!hasIncident && cell.count === 0 && (
          <div className="italic text-wd-muted/70 mt-1">No activity in this window.</div>
        )}
      </div>
    </div>
  )
}

function TipRow({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-wd-muted min-w-[72px]">{label}</span>
      <span
        className={cn(
          'font-mono font-medium text-right flex-1 text-foreground',
          valueClass,
        )}
      >
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

interface TopologyNode {
  id: string
  label: string
  x: number
  y: number
  group: string
  status: ProbeStatus
}

interface TopologyEdge {
  from: string
  to: string
  flow: 'active' | 'hot' | 'idle'
}

function nodeStrokeColor(status: ProbeStatus | undefined): string {
  switch (status) {
    case 'down':     return 'var(--wd-danger)'
    case 'degraded': return 'var(--wd-warning)'
    case 'standby':  return 'var(--wd-primary)'
    case 'disabled': return 'var(--wd-muted)'
    case 'healthy':
    default:         return 'var(--wd-success)'
  }
}

/** Build the canonical edge key used by the pulsingEdges Set. */
export function topologyEdgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

export const Topology = memo(function Topology({
  nodes,
  edges,
  pulsingEdges,
}: {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  /** Map of edge key (`from->to`) → pulse identity (e.g. expiry ms). A new
   *  identity forces the pulse element to remount, restarting the animation. */
  pulsingEdges?: ReadonlyMap<string, number>
}) {
  const W = 1000
  const H = 220
  const R = 13
  const xPx = (p: number) => (p / 100) * W
  const yPx = (p: number) => (p / 100) * H
  const byId: Record<string, TopologyNode> = Object.fromEntries(nodes.map((n) => [n.id, n]))

  const BANDS: Array<{ label: string; y: number; height: number }> = [
    { label: 'Write path', y: 8,  height: 28 },
    { label: 'Hub',        y: 40, height: 28 },
    { label: 'Consumers',  y: 72, height: 28 },
  ]

  function path(from: TopologyNode, to: TopologyNode): string {
    const x1 = xPx(from.x)
    const y1 = yPx(from.y)
    const x2 = xPx(to.x)
    const y2 = yPx(to.y)
    const sameRow = Math.abs(from.y - to.y) < 2
    const sameCol = Math.abs(from.x - to.x) < 2

    if (sameRow) {
      const dir = x2 > x1 ? 1 : -1
      const sx = x1 + dir * R
      const ex = x2 - dir * R
      const mx = (sx + ex) / 2
      return `M${sx} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${ex} ${y2}`
    }
    if (sameCol) {
      // Bow outward so the curve skirts the label sitting below the node.
      const dirY = y2 > y1 ? 1 : -1
      const sx = x1 + R
      const ex = x2 + R
      const sy = y1 + dirY * 4
      const ey = y2 - dirY * 4
      const bow = 52
      return `M${sx} ${sy} C${sx + bow} ${sy}, ${ex + bow} ${ey}, ${ex} ${ey}`
    }
    // Diagonal: exit/enter from the side so the curve never crosses the
    // label that sits directly below (or above) the source/target node.
    const dirX = x2 > x1 ? 1 : -1
    const sx = x1 + dirX * R
    const ex = x2 - dirX * R
    const mx = (sx + ex) / 2
    return `M${sx} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${ex} ${y2}`
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
      <style>{`
        @keyframes wd-flow-glide {
          0%   { stroke-dashoffset: 22;  opacity: 0; }
          14%  { opacity: 0.95; }
          82%  { opacity: 0.95; }
          100% { stroke-dashoffset: -100; opacity: 0; }
        }
        @keyframes wd-flow-hot {
          0%, 100% { stroke-opacity: 0.45; }
          50%      { stroke-opacity: 0.9; }
        }
        .wd-edge-glide { animation: wd-flow-glide 1.6s linear 1 forwards; }
        .wd-edge-hot   { animation: wd-flow-hot 1.4s ease-in-out infinite; }
      `}</style>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        <defs>
          <filter id="wd-flow-aura" x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="2.6" />
          </filter>
        </defs>

        {/* Tier bands — muted backing so the three rows read as layers */}
        {BANDS.map((b) => (
          <g key={b.label}>
            <rect
              x={xPx(2)}
              y={yPx(b.y)}
              width={xPx(96)}
              height={yPx(b.height)}
              rx={14}
              ry={14}
              fill="var(--wd-border)"
              fillOpacity={0.18}
            />
            <text
              x={xPx(3.2)}
              y={yPx(b.y + b.height / 2)}
              fill="currentColor"
              className="text-wd-muted font-mono"
              fontSize="7.5"
              fontWeight={500}
              letterSpacing="0.12em"
              fillOpacity={0.6}
              dominantBaseline="middle"
              style={{ textTransform: 'uppercase' }}
            >
              {b.label}
            </text>
          </g>
        ))}

        {edges.map((e, i) => {
          const f = byId[e.from]
          const t = byId[e.to]
          if (!f || !t) return null
          const isHot = e.flow === 'hot'
          const pulseId = pulsingEdges?.get(topologyEdgeKey(e.from, e.to))
          const stroke = isHot ? 'var(--wd-danger)' : 'var(--wd-primary)'
          const baseOpacity = isHot ? 0.7 : 0.3
          const baseWidth = isHot ? 1.5 : 1.1
          const d = path(f, t)
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                strokeWidth={baseWidth}
                strokeDasharray="4 6"
                stroke={stroke}
                strokeOpacity={baseOpacity}
                className={isHot ? 'wd-edge-hot' : ''}
              />
              {pulseId != null && (
                <g key={pulseId} pointerEvents="none">
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={7}
                    strokeOpacity={0.35}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray="22 200"
                    filter="url(#wd-flow-aura)"
                    className="wd-edge-glide"
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={2.2}
                    strokeOpacity={0.95}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray="22 200"
                    className="wd-edge-glide"
                  />
                </g>
              )}
            </g>
          )
        })}

        {nodes.map((n) => {
          const color = nodeStrokeColor(n.status)
          // Auth has no edges — give it a dashed ring so it reads as
          // "isolated middleware, not part of the flow".
          const isolated = n.id === 'auth'
          return (
            <g key={n.id} transform={`translate(${xPx(n.x)}, ${yPx(n.y)})`}>
              <circle
                r={R}
                fill="var(--wd-surface)"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray={isolated ? '3 3' : undefined}
                strokeOpacity={isolated ? 0.8 : 1}
              />
              <circle r="4.5" fill={color} />
              <text
                y={24}
                textAnchor="middle"
                fill="currentColor"
                className="text-foreground font-mono"
                fontSize="10"
                fontWeight={500}
              >
                {n.label}
              </text>
              {isolated && (
                <text
                  y={-20}
                  textAnchor="middle"
                  fill="currentColor"
                  className="text-wd-muted font-mono"
                  fontSize="8"
                >
                  middleware
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
})

// ---------------------------------------------------------------------------
// StatusPill — supports the full 5-state ProbeStatus space
// ---------------------------------------------------------------------------

export const StatusPill = memo(function StatusPill({ status }: { status: ProbeStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  let pill: string
  let dot: string
  switch (status) {
    case 'healthy':
      pill = 'bg-wd-success/10 text-wd-success border-wd-success/20'
      dot = 'bg-wd-success'
      break
    case 'degraded':
      pill = 'bg-wd-warning/10 text-wd-warning border-wd-warning/20'
      dot = 'bg-wd-warning'
      break
    case 'down':
      pill = 'bg-wd-danger/10 text-wd-danger border-wd-danger/20'
      dot = 'bg-wd-danger'
      break
    case 'standby':
      pill = 'bg-wd-primary/10 text-wd-primary border-wd-primary/20'
      dot = 'bg-wd-primary'
      break
    case 'disabled':
    default:
      pill = 'bg-wd-muted/10 text-wd-muted border-wd-border/40'
      dot = 'bg-wd-muted'
      break
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        pill,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
})
