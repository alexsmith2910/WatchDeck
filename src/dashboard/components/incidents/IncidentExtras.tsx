/**
 * Trends row: incident-volume bars (14d, stacked severity), cause-breakdown
 * donut, and top-affected endpoints list. All three cards read from the
 * server-side `/incidents/stats` aggregation — the paginated incident list is
 * never consulted for trend data, so bars are accurate regardless of how many
 * incidents exist in the window.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { IncidentStats } from '../../types/api'
import { formatDateShort, formatDuration } from '../../utils/format'
import { useFormat } from '../../hooks/useFormat'
import { endpointDisplay, metaFor, type CauseKind, type EndpointLite } from './incidentHelpers'

// Colour and label tables for cause donut slices. Kept inline with this file
// since it's the only consumer that needs them.
const CAUSE_KIND_COLOR: Record<CauseKind, string> = {
  down:     'var(--wd-danger)',
  degraded: 'var(--wd-warning)',
  latency:  'var(--wd-primary)',
  ssl:      '#b19cd9',
  body:     '#6aa6ff',
  port:     'var(--wd-muted)',
  other:    'var(--wd-muted)',
}

const CAUSE_KIND_LABEL: Record<CauseKind, string> = {
  down:     'Down',
  degraded: 'Degraded',
  latency:  'Latency',
  ssl:      'SSL',
  body:     'Body',
  port:     'Port',
  other:    'Other',
}

const CAUSE_ORDER: CauseKind[] = ['down', 'degraded', 'latency', 'ssl', 'body', 'port', 'other']

interface CauseSlice {
  kind: CauseKind
  label: string
  count: number
  color: string
}

interface VolumeDay {
  date: string
  label: string
  critical: number
  major: number
  minor: number
  total: number
  isToday: boolean
}

interface Props {
  stats: IncidentStats | null
  endpointById: Map<string, EndpointLite>
}

export function IncidentExtras({ stats, endpointById }: Props) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 min-w-0">
      <VolumeChart stats={stats} />
      <CauseDonut stats={stats} />
      <TopAffectedCard stats={stats} endpointById={endpointById} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stats-derived helpers
// ---------------------------------------------------------------------------

/** Fold server byDay causes into UI severity buckets for the Volume chart. */
function volumeDaysFromStats(stats: IncidentStats | null, windowDays: number): VolumeDay[] {
  const todayKey = localDayKey(new Date())
  const days = (stats?.byDay ?? []).slice(-windowDays).map((d) => {
    let critical = 0
    let major = 0
    let minor = 0
    for (const [cause, n] of Object.entries(d.causes)) {
      const sev = metaFor(cause).severity
      if (sev === 'Critical') critical += n
      else if (sev === 'Major') major += n
      else minor += n
    }
    return {
      date: d.date,
      label: labelFromDateKey(d.date),
      critical,
      major,
      minor,
      total: d.total,
      isToday: d.date === todayKey,
    }
  })
  return days
}

function causeSlicesFromStats(stats: IncidentStats | null): CauseSlice[] {
  const counts = new Map<CauseKind, number>()
  for (const row of stats?.byCause ?? []) {
    const kind = metaFor(row.cause).kind
    counts.set(kind, (counts.get(kind) ?? 0) + row.count)
  }
  return CAUSE_ORDER
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .map((k) => ({
      kind: k,
      label: CAUSE_KIND_LABEL[k],
      count: counts.get(k)!,
      color: CAUSE_KIND_COLOR[k],
    }))
}

interface TopAffectedRow {
  endpointId: string
  incidents: number
  totalDowntimeSec: number
  lastStartedAt: string
  trend: 'up' | 'down' | 'flat'
}

function topAffectedFromStats(stats: IncidentStats | null, limit = 5): TopAffectedRow[] {
  if (!stats) return []
  return stats.byEndpoint.slice(0, limit).map((r) => ({
    endpointId: r.endpointId,
    incidents: r.total,
    totalDowntimeSec: r.totalDurationSec,
    lastStartedAt: r.lastStartedAt,
    trend: r.total > r.prevTotal ? 'up' : r.total < r.prevTotal ? 'down' : 'flat',
  }))
}

/** Endpoints that fired ≥3 incidents on any single day in the window. */
function flappingFromStats(stats: IncidentStats | null): Array<{ endpointId: string; toggles: number }> {
  if (!stats) return []
  const worstDay = new Map<string, number>()
  for (const row of stats.byEndpointDay) {
    const prev = worstDay.get(row.endpointId) ?? 0
    if (row.count > prev) worstDay.set(row.endpointId, row.count)
  }
  return [...worstDay.entries()]
    .filter(([, n]) => n >= 3)
    .map(([endpointId, toggles]) => ({ endpointId, toggles }))
    .sort((a, b) => b.toggles - a.toggles)
}

function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function labelFromDateKey(key: string): string {
  // The key is an already-localised calendar day (yyyy-MM-dd) — build the
  // Date in local time so it renders on the intended day, then delegate to
  // the preference-aware short date formatter.
  const [y, m, d] = key.split('-').map(Number)
  return formatDateShort(new Date(y, (m ?? 1) - 1, d ?? 1))
}

// ---------------------------------------------------------------------------
// Shared card chrome
// ---------------------------------------------------------------------------

function CardHeader({
  title,
  subtitle,
  icon,
  tileClass,
  right,
}: {
  title: string
  subtitle?: string
  icon: string
  tileClass: string
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center shrink-0', tileClass)}>
          <Icon icon={icon} width={16} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">{title}</div>
          {subtitle && <div className="text-[11px] text-wd-muted mt-0.5 truncate">{subtitle}</div>}
        </div>
      </div>
      {right}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Volume chart — stacked severity bars, one per day in the stats window
// ---------------------------------------------------------------------------

function VolumeChart({ stats }: { stats: IncidentStats | null }) {
  const windowDays = stats?.byDay.length ?? 0
  const days = useMemo(
    () => volumeDaysFromStats(stats, windowDays || 14),
    [stats, windowDays],
  )
  const max = Math.max(1, ...days.map((d) => d.total))
  const [hover, setHover] = useState<{ day: VolumeDay; rect: DOMRect } | null>(null)

  // Hide tooltip if the user scrolls — avoids it stranding mid-air.
  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-h-[280px]">
      <CardHeader
        title="Incident Volume"
        subtitle={`Last ${windowDays || 14} days · stacked by severity`}
        icon="solar:chart-square-linear"
        tileClass="bg-wd-primary/15 text-wd-primary"
        right={
          <div className="flex items-center gap-2.5 text-[10.5px] text-wd-muted flex-wrap justify-end">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-wd-danger" />
              Critical
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-wd-warning" />
              Major
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-wd-primary/70" />
              Minor
            </span>
          </div>
        }
      />
      <div className="flex-1 flex flex-col gap-2 min-h-0">
        <div
          className="flex items-stretch gap-1 flex-1 min-h-[140px] px-1"
          onMouseLeave={() => setHover(null)}
        >
          {days.map((d) => {
            const totalPct = Math.max(1.5, (d.total / max) * 100)
            const critPct = d.total ? (d.critical / d.total) * 100 : 0
            const majPct = d.total ? (d.major / d.total) * 100 : 0
            const minPct = Math.max(0, 100 - critPct - majPct)
            return (
              // Outer column is full-height so the hover zone covers empty
              // days too; the tooltip anchors to this rect so placement stays
              // consistent regardless of bar height.
              <div
                key={d.date}
                onMouseEnter={(e) =>
                  setHover({ day: d, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })
                }
                className="flex-1 flex flex-col justify-end cursor-default"
              >
                <div
                  className={cn(
                    'flex flex-col-reverse gap-[2px] rounded-[3px] overflow-hidden transition-opacity hover:opacity-85',
                    d.isToday && 'ring-1 ring-wd-danger/40',
                  )}
                  style={{ height: `${totalPct}%`, minHeight: '4px' }}
                >
                  {d.minor > 0 && (
                    <span className="w-full min-h-[2px] bg-wd-primary/70" style={{ height: `${minPct}%` }} />
                  )}
                  {d.major > 0 && (
                    <span className="w-full min-h-[2px] bg-wd-warning" style={{ height: `${majPct}%` }} />
                  )}
                  {d.critical > 0 && (
                    <span className="w-full min-h-[2px] bg-wd-danger" style={{ height: `${critPct}%` }} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-between px-1 text-[10px] text-wd-muted/70 font-mono">
          {days.map((d, i) =>
            i % 2 === 0 || i === days.length - 1 ? (
              <span key={d.date}>{d.label}</span>
            ) : (
              <span key={d.date}>&nbsp;</span>
            ),
          )}
        </div>
      </div>
      {hover && typeof document !== 'undefined' &&
        createPortal(<VolumeTooltip day={hover.day} rect={hover.rect} />, document.body)}
    </div>
  )
}

function VolumeTooltip({ day, rect }: { day: VolumeDay; rect: DOMRect }) {
  const HALF_WIDTH = 110
  const MARGIN = 8
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const cx = rect.left + rect.width / 2
  const left = Math.max(HALF_WIDTH + MARGIN, Math.min(cx, viewportW - HALF_WIDTH - MARGIN))
  const above = rect.top > 120
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left,
        top: above ? rect.top - 10 : rect.bottom + 10,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <div className="rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px] min-w-[200px]">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-semibold text-foreground">
            {day.isToday ? 'Today' : day.label}
          </span>
          <span className="font-mono text-foreground">
            {day.total} incident{day.total === 1 ? '' : 's'}
          </span>
        </div>
        <div className="text-[10.5px] text-wd-muted font-mono mb-1.5">{day.date}</div>
        <div className="space-y-1">
          <VolumeRow color="var(--wd-danger)" label="Critical" value={day.critical} />
          <VolumeRow color="var(--wd-warning)" label="Major" value={day.major} />
          <VolumeRow color="var(--wd-primary)" label="Minor" value={day.minor} />
        </div>
      </div>
    </div>
  )
}

function VolumeRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-wd-muted">
        <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
        {label}
      </span>
      <span className="font-mono font-medium" style={{ color: value > 0 ? color : undefined }}>
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cause donut
// ---------------------------------------------------------------------------

function CauseDonut({ stats }: { stats: IncidentStats | null }) {
  const slices = useMemo(() => causeSlicesFromStats(stats), [stats])
  const total = slices.reduce((s, c) => s + c.count, 0)
  const windowDays = stats?.byDay.length ?? 0
  const incidentCount = stats?.totals.total ?? 0
  const totalAlerts = stats?.totals.notificationsSent ?? 0
  const fatigueScore = incidentCount > 0 ? (totalAlerts / incidentCount).toFixed(1) : '0.0'

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-h-[280px]">
      <CardHeader
        title="Cause Breakdown"
        subtitle={`Last ${windowDays} days · ${total} incidents`}
        icon="solar:pie-chart-2-linear"
        tileClass="bg-wd-warning/15 text-wd-warning"
      />
      {total === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center py-6">
          <Icon icon="solar:shield-check-linear" width={32} className="text-wd-success" />
          <div className="text-[13px] font-medium text-foreground">
            No incidents in {windowDays || 14} days
          </div>
          <div className="text-[11px] text-wd-muted">Nothing to chart.</div>
        </div>
      ) : (
        <>
          <div className="flex-1 flex items-center gap-4 min-h-0">
            <DonutSvg slices={slices} total={total} />
            <div className="flex-1 flex flex-col gap-1.5 min-w-0">
              {slices.map((s) => (
                <div key={s.kind} className="flex items-center gap-2 text-[12px] min-w-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                  <span className="truncate text-foreground">{s.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-wd-muted">
                    {s.count} · {Math.round((s.count / total) * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-wd-primary/5 border border-wd-primary/30">
            <Icon icon="solar:bell-bing-linear" width={16} className="text-wd-primary mt-[1px] shrink-0" />
            <div className="text-[11.5px] leading-relaxed text-wd-muted">
              Avg <span className="font-semibold text-wd-primary">{fatigueScore} alerts per incident</span>{' '}
              across {incidentCount} incidents. Consider tuning cooldowns on high-volume channels.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DonutSvg({ slices, total }: { slices: CauseSlice[]; total: number }) {
  const R = 54
  const stroke = 14
  const cx = 68
  const cy = 68
  const C = 2 * Math.PI * R
  let acc = 0
  const arcs = slices.map((s) => {
    const frac = s.count / total
    const len = frac * C
    const dash = `${len} ${C - len}`
    const offset = -acc
    acc += len
    return { ...s, dash, offset, frac }
  })
  const [hover, setHover] = useState<{ slice: CauseSlice; frac: number; rect: DOMRect } | null>(null)

  useEffect(() => {
    if (!hover) return
    const onScroll = () => setHover(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover])

  return (
    <div
      className="relative shrink-0"
      style={{ width: 136, height: 136 }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={136} height={136} viewBox="0 0 136 136">
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="none"
          stroke="color-mix(in srgb, var(--wd-border) 50%, transparent)"
          strokeWidth={stroke}
        />
        {arcs.map((a) => {
          const isActive = hover?.slice.kind === a.kind
          return (
            <circle
              key={a.kind}
              cx={cx}
              cy={cy}
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={isActive ? stroke + 2 : stroke}
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                transition: 'stroke-dasharray 400ms ease, stroke-width 120ms ease',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                setHover({ slice: a, frac: a.frac, rect })
              }}
            />
          )
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-xl font-semibold font-mono text-foreground leading-none">
          {hover ? hover.slice.count : total}
        </div>
        <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-wd-muted/80 text-center px-2 truncate max-w-[120px]">
          {hover ? hover.slice.label : '7-day total'}
        </div>
      </div>
      {hover && typeof document !== 'undefined' &&
        createPortal(
          <DonutTooltip slice={hover.slice} frac={hover.frac} rect={hover.rect} />,
          document.body,
        )}
    </div>
  )
}

function DonutTooltip({
  slice,
  frac,
  rect,
}: {
  slice: CauseSlice
  frac: number
  rect: DOMRect
}) {
  const HALF_WIDTH = 110
  const MARGIN = 8
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const cx = rect.left + rect.width / 2
  const left = Math.max(HALF_WIDTH + MARGIN, Math.min(cx, viewportW - HALF_WIDTH - MARGIN))
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left,
        top: rect.top - 10,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div className="rounded-lg border border-wd-border bg-wd-surface shadow-md px-3 py-2 text-[11px] min-w-[200px]">
        <div className="flex items-center justify-between gap-3 mb-1">
          <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: slice.color }} />
            {slice.label}
          </span>
          <span className="font-mono font-medium" style={{ color: slice.color }}>
            {slice.count}
          </span>
        </div>
        <div className="text-[10.5px] text-wd-muted font-mono">
          {Math.round(frac * 100)}% of last 7 days
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top affected
// ---------------------------------------------------------------------------

function TopAffectedCard({
  stats,
  endpointById,
}: {
  stats: IncidentStats | null
  endpointById: Map<string, EndpointLite>
}) {
  const rows = useMemo(() => topAffectedFromStats(stats, 5), [stats])
  const flapping = useMemo(() => flappingFromStats(stats), [stats])
  const windowDays = stats?.byDay.length ?? 0
  const fmt = useFormat()

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-h-[280px]">
      <CardHeader
        title="Top Affected"
        subtitle={`Most incidents in last ${windowDays} days`}
        icon="solar:crown-linear"
        tileClass="bg-wd-danger/15 text-wd-danger"
      />
      <div className="flex-1 flex flex-col gap-1.5 min-h-0">
        {rows.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 py-6 text-center">
            <Icon icon="solar:shield-check-linear" width={28} className="text-wd-success" />
            <div className="text-[12px] text-wd-muted">No incidents recorded.</div>
          </div>
        ) : (
          rows.map((r, i) => {
            const ep = endpointDisplay(endpointById.get(r.endpointId))
            return (
              <div
                key={r.endpointId}
                className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-wd-surface-hover/40 transition-colors"
              >
                <span className="text-[10px] font-mono font-semibold text-wd-muted/70 w-5 shrink-0">
                  #{i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-foreground truncate">{ep.name}</div>
                  <div className="text-[10.5px] text-wd-muted font-mono">
                    {formatDuration(r.totalDowntimeSec)} total · last {fmt.relative(r.lastStartedAt)}
                  </div>
                </div>
                <span className="font-mono text-[13px] font-semibold text-foreground shrink-0">
                  {r.incidents}
                </span>
                <TrendIcon trend={r.trend} />
              </div>
            )
          })
        )}
      </div>
      {flapping.length > 0 && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-wd-warning/5 border border-wd-warning/30">
          <Icon icon="solar:refresh-circle-linear" width={16} className="text-wd-warning mt-[1px] shrink-0" />
          <div className="text-[11.5px] leading-relaxed text-wd-muted">
            <span className="font-semibold text-wd-warning">
              {flapping.length} endpoint{flapping.length === 1 ? '' : 's'} flapping
            </span>{' '}
            — repeatedly opening and resolving.
            {flapping.slice(0, 2).length > 0 && (
              <>
                {' '}
                {flapping
                  .slice(0, 2)
                  .map((f) => endpointDisplay(endpointById.get(f.endpointId)).name)
                  .join(', ')}{' '}
                hit ≥3 incidents in a single day.
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TrendIcon({ trend }: { trend: 'up' | 'down' | 'flat' }) {
  if (trend === 'up') {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-wd-danger shrink-0">
        <Icon icon="solar:arrow-right-up-linear" width={16} />
      </span>
    )
  }
  if (trend === 'down') {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-wd-success shrink-0">
        <Icon icon="solar:arrow-right-down-linear" width={16} />
      </span>
    )
  }
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded text-wd-muted shrink-0 text-[11px]">
      —
    </span>
  )
}
