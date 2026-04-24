/**
 * KPI row for the Incidents page.
 *
 * 4 tiles: Active Now, MTTR (7d), Resolved (7d), Flapping. Each follows the
 * same shape used by HealthPage: small tinted icon tile, big mono value,
 * contextual delta line, and a WideSpark footer. All derivations read from
 * the pre-aggregated `/incidents/stats` payload so the sparklines cover the
 * full window regardless of how many incidents exist.
 */
import { useMemo } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiIncident, IncidentStats } from '../../types/api'
import { WideSpark } from '../health/HealthCharts'
import { metaFor, severityOf } from './incidentHelpers'
import { formatDateShort, formatDuration } from '../../utils/format'

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
  stats: IncidentStats | null
}

const SPARK_DAYS = 14
const WEEK_DAYS = 7

function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function labelFromDateKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return formatDateShort(new Date(y, (m ?? 1) - 1, d ?? 1))
}

export function IncidentKpis({ activeIncidents, stats }: Props) {
  const critCount = activeIncidents.filter((i) => severityOf(i) === 'Critical').length
  const majCount = activeIncidents.filter((i) => severityOf(i) === 'Major').length

  // Trailing 14 days lifted out of the stats window. Safe even when the
  // window is shorter — slice just returns whatever's there.
  const last14 = useMemo(() => (stats?.byDay ?? []).slice(-SPARK_DAYS), [stats])
  const last14Keys = useMemo(() => new Set(last14.map((d) => d.date)), [last14])
  const today = todayKey()

  const sparkLabels = useMemo(
    () => last14.map((d) => (d.date === today ? 'Today' : labelFromDateKey(d.date))),
    [last14, today],
  )

  // 7d window: right-aligned so the rightmost day is "today".
  const last7Keys = useMemo(
    () => new Set(last14.slice(-WEEK_DAYS).map((d) => d.date)),
    [last14],
  )

  // MTTR (7d) + resolved counts, with previous 7d for the delta.
  const { avgMttrSec, resolved7d, resolvedPrev7d } = useMemo(() => {
    if (!stats) return { avgMttrSec: 0, resolved7d: 0, resolvedPrev7d: 0 }
    const mttrByDay = new Map(stats.resolvedDurationsByDay.map((r) => [r.date, r]))
    let cur = 0
    let durSum = 0
    let durCount = 0
    for (const key of last7Keys) {
      const m = mttrByDay.get(key)
      if (!m || m.count === 0) continue
      cur += m.count
      durSum += m.avgSec * m.count
      durCount += m.count
    }
    // Previous 7d window = the 7 days ending where last7 starts.
    const prevWindow = stats.byDay.slice(-14, -7)
    const prevKeys = new Set(prevWindow.map((d) => d.date))
    let prev = 0
    for (const key of prevKeys) {
      const m = mttrByDay.get(key)
      if (m) prev += m.count
    }
    return {
      avgMttrSec: durCount > 0 ? Math.round(durSum / durCount) : 0,
      resolved7d: cur,
      resolvedPrev7d: prev,
    }
  }, [stats, last7Keys])

  const resolvedDeltaPct = resolvedPrev7d > 0
    ? Math.round(((resolved7d - resolvedPrev7d) / resolvedPrev7d) * 100)
    : null

  const totalSpark = useMemo(() => last14.map((d) => d.total), [last14])

  // Critical+Major per day, folded from per-cause counts via CAUSE_META.
  const criticalSpark = useMemo(
    () => last14.map((d) => {
      let n = 0
      for (const [cause, count] of Object.entries(d.causes)) {
        const sev = metaFor(cause).severity
        if (sev === 'Critical' || sev === 'Major') n += count
      }
      return n
    }),
    [last14],
  )

  // Flapping sparkline: per-day count of endpoints that hit ≥3 incidents
  // on that day. Uses byEndpointDay so every endpoint's daily volume is
  // represented regardless of pagination state.
  const flapSpark = useMemo(() => {
    if (!stats) return new Array<number>(last14.length).fill(0)
    const perDay = new Map<string, Map<string, number>>()
    for (const key of last14Keys) perDay.set(key, new Map())
    for (const row of stats.byEndpointDay) {
      const bucket = perDay.get(row.date)
      if (!bucket) continue
      bucket.set(row.endpointId, row.count)
    }
    return last14.map((d) => {
      const bucket = perDay.get(d.date)
      if (!bucket) return 0
      let n = 0
      for (const count of bucket.values()) if (count >= 3) n++
      return n
    })
  }, [stats, last14, last14Keys])

  // Today's flapping endpoint count — drives the tile value.
  const flappingToday = flapSpark[flapSpark.length - 1] ?? 0

  // MTTR sparkline: per-day avg resolved duration in seconds. Kept in the
  // same unit as avgMttrSec so tooltips can reuse formatDuration.
  const mttrSpark = useMemo(() => {
    if (!stats) return new Array<number>(last14.length).fill(0)
    const byDate = new Map(stats.resolvedDurationsByDay.map((r) => [r.date, r]))
    return last14.map((d) => {
      const m = byDate.get(d.date)
      return m && m.count > 0 ? Math.round(m.avgSec) : 0
    })
  }, [stats, last14])

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
        value={avgMttrSec > 0 ? formatDuration(avgMttrSec) : '—'}
        delta={avgMttrSec > 0 ? 'across 7d' : 'no resolved incidents'}
        deltaTone={avgMttrSec > 0 ? 'success' : 'muted'}
        deltaLabel=""
        spark={mttrSpark}
        sparkStroke="var(--wd-primary)"
        sparkLabels={sparkLabels}
        sparkFormat={(n) => (n > 0 ? `${formatDuration(n)} avg` : 'no resolved')}
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
        tile={flappingToday > 0 ? 'warning' : 'success'}
        title="Flapping Endpoints"
        value={flappingToday}
        delta={flappingToday === 0 ? 'stable' : 'opened ≥3× today'}
        deltaTone={flappingToday === 0 ? 'success' : 'warning'}
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
