/**
 * Trends row: incident-volume bars (14d, stacked severity), cause-breakdown
 * donut, and top-affected endpoints list. Everything is derived from the
 * incident-history page we already fetched — no extra API calls.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiIncident } from '../../types/api'
import { timeAgo, formatDuration } from '../../utils/format'
import {
  causeBreakdown,
  endpointDisplay,
  flappingEndpoints,
  topAffected,
  volumeByDay,
  type CauseSlice,
  type EndpointLite,
  type VolumeDay,
} from './incidentHelpers'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

interface Props {
  historyIncidents: ApiIncident[]
  endpointById: Map<string, EndpointLite>
}

export function IncidentExtras({ historyIncidents, endpointById }: Props) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 min-w-0">
      <VolumeChart historyIncidents={historyIncidents} />
      <CauseDonut historyIncidents={historyIncidents} />
      <TopAffectedCard historyIncidents={historyIncidents} endpointById={endpointById} />
    </div>
  )
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
// Volume chart — 14-day stacked severity bars
// ---------------------------------------------------------------------------

function VolumeChart({ historyIncidents }: { historyIncidents: ApiIncident[] }) {
  const days = useMemo(() => volumeByDay(historyIncidents, 14), [historyIncidents])
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
        subtitle="Last 14 days · stacked by severity"
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

function CauseDonut({ historyIncidents }: { historyIncidents: ApiIncident[] }) {
  const slices = useMemo(() => causeBreakdown(historyIncidents, WEEK_MS), [historyIncidents])
  const total = slices.reduce((s, c) => s + c.count, 0)

  const { totalAlerts, incidentCount } = useMemo(() => {
    const cutoff = Date.now() - WEEK_MS
    let alerts = 0
    let count = 0
    for (const inc of historyIncidents) {
      if (new Date(inc.startedAt).getTime() < cutoff) continue
      alerts += inc.notificationsSent
      count++
    }
    return { totalAlerts: alerts, incidentCount: count }
  }, [historyIncidents])
  const fatigueScore = incidentCount > 0 ? (totalAlerts / incidentCount).toFixed(1) : '0.0'

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-h-[280px]">
      <CardHeader
        title="Cause Breakdown"
        subtitle={`Last 7 days · ${total} incidents`}
        icon="solar:pie-chart-2-linear"
        tileClass="bg-wd-warning/15 text-wd-warning"
      />
      {total === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center py-6">
          <Icon icon="solar:shield-check-linear" width={32} className="text-wd-success" />
          <div className="text-[13px] font-medium text-foreground">No incidents in 7 days</div>
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
  historyIncidents,
  endpointById,
}: {
  historyIncidents: ApiIncident[]
  endpointById: Map<string, EndpointLite>
}) {
  const rows = useMemo(() => topAffected(historyIncidents, WEEK_MS, 5), [historyIncidents])
  const flapping = useMemo(() => flappingEndpoints(historyIncidents, DAY_MS), [historyIncidents])

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3 min-h-[280px]">
      <CardHeader
        title="Top Affected"
        subtitle="Most incidents in last 7 days"
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
                    {formatDuration(r.totalDowntimeSec)} total · last {timeAgo(r.lastStartedAt)}
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
                toggled ≥3× in the last 24h.
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
