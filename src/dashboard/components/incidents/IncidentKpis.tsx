/**
 * KPI row for the Incidents page.
 *
 * 4 tiles: Active Now, MTTR (7d), Resolved (7d), Flapping. Each follows the
 * same shape used by HealthPage: small tinted icon tile, big mono value,
 * contextual delta line, and a WideSpark footer computed from the incident
 * history.
 */
import { useMemo } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiIncident } from '../../types/api'
import { WideSpark } from '../health/HealthCharts'
import {
  flappingEndpoints,
  localDayKey,
  severityOf,
  volumeByDay,
  type VolumeDay,
} from './incidentHelpers'

type Tile = 'primary' | 'success' | 'warning' | 'danger'

function tileClass(tile: Tile): string {
  switch (tile) {
    case 'primary': return 'bg-wd-primary/15 text-wd-primary'
    case 'success': return 'bg-wd-success/15 text-wd-success'
    case 'warning': return 'bg-wd-warning/15 text-wd-warning'
    case 'danger':  return 'bg-wd-danger/15 text-wd-danger'
  }
}

interface Props {
  activeIncidents: ApiIncident[]
  historyIncidents: ApiIncident[]
}

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

export function IncidentKpis({ activeIncidents, historyIncidents }: Props) {
  const critCount = activeIncidents.filter((i) => severityOf(i) === 'Critical').length
  const majCount = activeIncidents.filter((i) => severityOf(i) === 'Major').length

  // MTTR across resolved incidents in the last 7 days.
  const { avgMttrSec, resolved7d, resolvedPrev7d } = useMemo(() => {
    const now = Date.now()
    const durations: number[] = []
    let cur = 0
    let prev = 0
    for (const inc of historyIncidents) {
      if (inc.status !== 'resolved') continue
      const t = new Date(inc.startedAt).getTime()
      if (t >= now - WEEK_MS) {
        cur++
        if (inc.durationSeconds != null) durations.push(inc.durationSeconds)
      } else if (t >= now - 2 * WEEK_MS) {
        prev++
      }
    }
    const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0
    return { avgMttrSec: avg, resolved7d: cur, resolvedPrev7d: prev }
  }, [historyIncidents])

  const resolvedDeltaPct = resolvedPrev7d > 0
    ? Math.round(((resolved7d - resolvedPrev7d) / resolvedPrev7d) * 100)
    : null

  const volume14d = useMemo<VolumeDay[]>(() => volumeByDay(historyIncidents, 14), [historyIncidents])
  const totalSpark = volume14d.map((d) => d.total)
  const criticalSpark = volume14d.map((d) => d.critical + d.major)
  // All four sparklines share the same 14-day daily window, so a single label
  // array drives every tooltip. "Today" replaces the date for the trailing
  // bucket so users can read the rightmost point at a glance.
  const sparkLabels = useMemo(
    () => volume14d.map((d) => (d.isToday ? 'Today' : d.label)),
    [volume14d],
  )

  const flapping = useMemo(() => flappingEndpoints(historyIncidents, DAY_MS), [historyIncidents])
  // Index lookup aligned with volume14d so all four sparklines share the same
  // calendar-day x-axis as their labels. Without this, a rolling 24-hour
  // bucketing would slide out of phase with the "Apr 9 → Today" labels.
  const dayIndex = useMemo(() => {
    const m = new Map<string, number>()
    volume14d.forEach((d, i) => m.set(d.date, i))
    return m
  }, [volume14d])

  const flapSpark = useMemo(() => {
    const counts = new Array<number>(volume14d.length).fill(0)
    const perDayPerEp = new Map<string, number[]>()
    for (const inc of historyIncidents) {
      const idx = dayIndex.get(localDayKey(new Date(inc.startedAt)))
      if (idx === undefined) continue
      const arr = perDayPerEp.get(inc.endpointId) ?? new Array<number>(volume14d.length).fill(0)
      arr[idx]++
      perDayPerEp.set(inc.endpointId, arr)
    }
    for (const arr of perDayPerEp.values()) {
      for (let i = 0; i < counts.length; i++) if (arr[i] >= 3) counts[i]++
    }
    return counts
  }, [historyIncidents, dayIndex, volume14d.length])

  const mttrSpark = useMemo(() => {
    const buckets: number[][] = Array.from({ length: volume14d.length }, () => [])
    for (const inc of historyIncidents) {
      if (inc.status !== 'resolved' || inc.durationSeconds == null) continue
      const idx = dayIndex.get(localDayKey(new Date(inc.startedAt)))
      if (idx === undefined) continue
      buckets[idx].push(inc.durationSeconds / 60)
    }
    return buckets.map((arr) =>
      arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    )
  }, [historyIncidents, dayIndex, volume14d.length])

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        icon="solar:danger-triangle-bold"
        tile={activeIncidents.length > 0 ? 'danger' : 'success'}
        title="Active Now"
        value={activeIncidents.length}
        delta={
          activeIncidents.length === 0
            ? 'All clear'
            : `${critCount} critical${majCount > 0 ? ` · ${majCount} major` : ''}`
        }
        deltaTone={activeIncidents.length === 0 ? 'success' : 'danger'}
        spark={criticalSpark}
        sparkStroke="var(--wd-danger)"
        sparkLabels={sparkLabels}
        sparkFormat={(n) => `${n} critical+major`}
      />
      <KpiCard
        icon="solar:stopwatch-linear"
        tile="primary"
        title="Mean Time to Resolve"
        value={avgMttrSec > 0 ? Math.round(avgMttrSec / 60) : '—'}
        unit={avgMttrSec > 0 ? 'm' : ''}
        delta={avgMttrSec > 0 ? 'across 7d' : 'no resolved incidents'}
        deltaTone={avgMttrSec > 0 ? 'success' : 'muted'}
        deltaLabel=""
        spark={mttrSpark}
        sparkStroke="var(--wd-primary)"
        sparkLabels={sparkLabels}
        sparkFormat={(n) => (n > 0 ? `${n} min avg` : 'no resolved')}
      />
      <KpiCard
        icon="solar:check-circle-bold"
        tile="success"
        title="Resolved · 7d"
        value={resolved7d}
        delta={
          resolvedDeltaPct === null
            ? 'no prior data'
            : resolvedDeltaPct === 0
              ? 'no change'
              : `${resolvedDeltaPct > 0 ? '+' : ''}${resolvedDeltaPct}% vs prev 7d`
        }
        deltaTone={
          resolvedDeltaPct === null
            ? 'muted'
            : resolvedDeltaPct <= 0
              ? 'success'
              : 'danger'
        }
        spark={totalSpark}
        sparkStroke="var(--wd-success)"
        sparkLabels={sparkLabels}
        sparkFormat={(n) => `${n} incident${n === 1 ? '' : 's'}`}
      />
      <KpiCard
        icon="solar:refresh-circle-linear"
        tile={flapping.length > 0 ? 'warning' : 'success'}
        title="Flapping Endpoints"
        value={flapping.length}
        delta={flapping.length === 0 ? 'stable' : 'opened ≥3× in 24h'}
        deltaTone={flapping.length === 0 ? 'success' : 'warning'}
        spark={flapSpark}
        sparkStroke="var(--wd-warning)"
        sparkLabels={sparkLabels}
        sparkFormat={(n) => `${n} flapping`}
      />
    </div>
  )
}

function KpiCard({
  icon,
  tile,
  title,
  value,
  unit,
  delta,
  deltaTone = 'muted',
  deltaLabel,
  spark,
  sparkStroke,
  sparkLabels,
  sparkFormat,
}: {
  icon: string
  tile: Tile
  title: string
  value: string | number
  unit?: string
  delta?: string
  deltaTone?: 'success' | 'warning' | 'danger' | 'muted'
  deltaLabel?: string
  spark?: number[] | null
  sparkStroke?: string
  sparkLabels?: string[]
  sparkFormat?: (n: number) => string
}) {
  const deltaColor =
    deltaTone === 'success'
      ? 'text-wd-success'
      : deltaTone === 'warning'
        ? 'text-wd-warning'
        : deltaTone === 'danger'
          ? 'text-wd-danger'
          : 'text-wd-muted'
  return (
    <div className="relative flex flex-col gap-2.5 rounded-xl border border-wd-border/50 bg-wd-surface px-4 py-3.5 min-h-[118px] overflow-hidden">
      <div className="flex items-center gap-2.5">
        <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center', tileClass(tile))}>
          <Icon icon={icon} width={16} />
        </div>
        <div className="text-xs font-medium text-wd-muted">{title}</div>
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold font-mono tracking-tight text-foreground">
            {value}
          </span>
          {unit && <span className="text-[11px] text-wd-muted">{unit}</span>}
        </div>
        {delta && (
          <div className={cn('mt-1.5 text-[11px] font-medium', deltaColor)}>
            {delta}
            {deltaLabel && <span className="ml-1 text-wd-muted/70 font-normal">{deltaLabel}</span>}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-auto -mx-4">
          <WideSpark
            data={spark}
            color={sparkStroke ?? 'var(--wd-primary)'}
            height={46}
            labels={sparkLabels}
            formatValue={sparkFormat}
          />
        </div>
      )}
    </div>
  )
}
