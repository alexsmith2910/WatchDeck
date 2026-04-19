import { useRef, useState, useEffect } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { HeatmapRow, SubsystemStatus, TimeSeriesPoint } from '../../types/systemHealth'

// ---------------------------------------------------------------------------
// Sparkline (inline)
// ---------------------------------------------------------------------------

export function Sparkline({
  data,
  color = 'var(--wd-primary)',
  width = 100,
  height = 32,
  strokeW = 1.5,
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
  strokeW?: number
}) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const stepX = width / (data.length - 1)
  const pts = data.map<[number, number]>((v, i) => [i * stepX, height - ((v - min) / range) * (height - 4) - 2])
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${d} L${width},${height} L0,${height} Z`
  const id = `sg-${Math.random().toString(36).slice(2, 8)}`
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
}

export function WideSpark({
  data,
  color,
  height = 48,
}: {
  data: number[]
  color?: string
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(240)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(100, e.contentRect.width))
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      <Sparkline data={data} color={color} width={w} height={height} strokeW={1.6} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// LineChart — SVG with hover crosshair + tooltip
// ---------------------------------------------------------------------------

interface LineSeries {
  key: 'throughput' | 'latency' | 'errors'
  label: string
  color: string
}

export function LineChart({
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
  data: TimeSeriesPoint[]
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

  const allVals = series.flatMap((s) => data.map((d) => (d[s.key] as number) ?? 0))
  const yMin = 0
  const yMax = Math.max(...allVals, 1) * 1.12

  const x = (i: number) => padL + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH

  function pathFor(key: LineSeries['key']): string {
    return data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(d[key] ?? 0)).toFixed(1)}`)
      .join(' ')
  }
  function areaFor(key: LineSeries['key']): string {
    const line = pathFor(key)
    return `${line} L${x(data.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`
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
              <Icon icon={icon} width={14} />
            </div>
          )}
          <div>
            <div className="text-sm font-semibold text-foreground">{title}</div>
            {subtitle && <div className="text-[11px] text-wd-muted mt-0.5">{subtitle}</div>}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-wd-muted">
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
                className="text-wd-muted/70"
                textAnchor="end"
              >
                {Math.round(t)}
                {unit ? ` ${unit}` : ''}
              </text>
            </g>
          ))}
          {series.map((s) => (
            <g key={s.key}>
              <path d={areaFor(s.key)} fill={s.color} fillOpacity="0.12" />
              <path
                d={pathFor(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth="1.6"
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
                const val = Number(data[hover.idx]?.[s.key] ?? 0)
                return (
                  <circle
                    key={s.key}
                    cx={hover.x}
                    cy={y(val)}
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
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px]"
            style={{ left: `${(hover.x / w) * 100}%`, top: padT - 4 }}
          >
            <div className="text-wd-muted mb-1 font-mono tabular-nums">{data[hover.idx].label}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-wd-muted">
                  <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="font-mono tabular-nums" style={{ color: s.color }}>
                  {Math.round(Number(data[hover.idx]?.[s.key] ?? 0))}
                  {unit ? ` ${unit}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-wd-muted font-mono tabular-nums pl-10 pr-3.5">
        {data
          .filter((_, i) => i % Math.max(1, Math.ceil(data.length / 6)) === 0 || i === data.length - 1)
          .map((d, i) => (
            <span key={i}>{d.label}</span>
          ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

function heatColor(v: number): string {
  if (v < 0.05) return 'color-mix(in srgb, var(--wd-success) 6%, var(--wd-surface-hover))'
  if (v < 0.2)
    return `color-mix(in srgb, var(--wd-success) ${20 + v * 120}%, var(--wd-surface-hover))`
  if (v < 0.4) return `color-mix(in srgb, var(--wd-success) 60%, transparent)`
  if (v < 0.6) return `color-mix(in srgb, var(--wd-warning) ${40 + v * 60}%, transparent)`
  return `color-mix(in srgb, var(--wd-danger) ${60 + v * 40}%, transparent)`
}

export function Heatmap({ rows, labels }: { rows: HeatmapRow[]; labels: string[] }) {
  const colCount = rows[0]?.values?.length ?? 24
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Subsystem error-rate heatmap</div>
          <div className="text-[11px] text-wd-muted mt-0.5">
            Last 24 hours · darker = more errors. Hover a cell for exact value.
          </div>
        </div>
        <div className="inline-flex items-center gap-2 text-[10px] text-wd-muted">
          <span>0%</span>
          <span
            className="w-24 h-1.5 rounded-full"
            style={{
              background:
                'linear-gradient(to right, color-mix(in srgb, var(--wd-success) 20%, transparent), var(--wd-warning), var(--wd-danger))',
            }}
          />
          <span>100%</span>
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
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          {rows.map((r) => (
            <div
              key={r.id}
              className="grid gap-0.5"
              style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
            >
              {r.values.map((v, ci) => (
                <div
                  key={ci}
                  className="h-6 rounded-sm border border-wd-border/20"
                  style={{ background: heatColor(v) }}
                  title={`${r.title} · ${labels[ci] ?? ''} · ${(v * 100).toFixed(1)}%`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-wd-muted font-mono tabular-nums pl-[100px]">
        {labels
          .filter((_, i) => i % Math.max(1, Math.ceil(labels.length / 6)) === 0 || i === labels.length - 1)
          .map((l, i) => (
            <span key={i}>{l}</span>
          ))}
      </div>
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
  status: SubsystemStatus
}

interface TopologyEdge {
  from: string
  to: string
  flow: 'active' | 'hot' | 'idle'
}

export function Topology({
  nodes,
  edges,
}: {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}) {
  const W = 1000
  const H = 200
  const xPx = (p: number) => (p / 100) * W
  const yPx = (p: number) => (p / 100) * H
  const byId: Record<string, TopologyNode> = Object.fromEntries(nodes.map((n) => [n.id, n]))

  function nodeColor(status: SubsystemStatus | undefined): string {
    if (status === 'degraded') return 'var(--wd-warning)'
    if (status === 'down') return 'var(--wd-danger)'
    return 'var(--wd-success)'
  }

  function path(from: TopologyNode, to: TopologyNode): string {
    const x1 = xPx(from.x)
    const y1 = yPx(from.y)
    const x2 = xPx(to.x)
    const y2 = yPx(to.y)
    const mx = (x1 + x2) / 2
    return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
      <div className="flex items-center gap-2.5 mb-2">
        <div className="h-7 w-7 rounded-lg bg-wd-primary/15 text-wd-primary flex items-center justify-center shrink-0">
          <Icon icon="solar:routing-outline" width={14} />
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">Data flow</div>
          <div className="text-[11px] text-wd-muted mt-0.5">
            Compact topology — dotted lines show live traffic, red = degraded path
          </div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet" height={220}>
        {edges.map((e, i) => {
          const f = byId[e.from]
          const t = byId[e.to]
          if (!f || !t) return null
          return (
            <path
              key={i}
              d={path(f, t)}
              fill="none"
              strokeWidth={e.flow === 'hot' ? 2 : 1.5}
              strokeDasharray={e.flow === 'hot' ? '6 4' : '4 6'}
              stroke={e.flow === 'hot' ? 'var(--wd-danger)' : 'var(--wd-primary)'}
              strokeOpacity={e.flow === 'hot' ? 0.85 : 0.55}
            />
          )
        })}
        {nodes.map((n) => (
          <g key={n.id} transform={`translate(${xPx(n.x)}, ${yPx(n.y)})`}>
            <circle r="18" fill="var(--wd-surface)" stroke={nodeColor(n.status)} strokeWidth="1.5" />
            <circle r="6" fill={nodeColor(n.status)} />
            <text
              y="34"
              textAnchor="middle"
              fill="currentColor"
              className="text-foreground"
              fontSize="11"
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatusPill
// ---------------------------------------------------------------------------

export function StatusPill({ status }: { status: SubsystemStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  const color =
    status === 'healthy'
      ? 'bg-wd-success/10 text-wd-success border-wd-success/20'
      : status === 'degraded'
        ? 'bg-wd-warning/10 text-wd-warning border-wd-warning/20'
        : 'bg-wd-danger/10 text-wd-danger border-wd-danger/20'
  const dot =
    status === 'healthy' ? 'bg-wd-success' : status === 'degraded' ? 'bg-wd-warning' : 'bg-wd-danger'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        color,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}
