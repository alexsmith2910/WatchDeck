/**
 * KPI row for NotificationsPage. Four tiles, each with an iconified accent,
 * primary value + unit, delta chip with tone, and optional 24-point sparkline.
 *
 * Values are derived from:
 *   - `ApiNotificationStats` (24h totals: sent, failed, suppressed, pending)
 *   - the recent delivery log (median latency + throughput sparks)
 *   - scheduled escalations list (pending count)
 */
import { useMemo } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import { WideSpark } from '../health/HealthCharts'
import type {
  ApiChannel,
  ApiNotificationLogRow,
  ApiNotificationStats,
  ApiScheduledEscalation,
} from '../../types/notifications'
import { bucketLog, medianLatency } from './notificationHelpers'
import { useFormat } from '../../hooks/useFormat'

interface Props {
  stats: ApiNotificationStats | null
  channels: ApiChannel[]
  recentLog: ApiNotificationLogRow[]
  escalations: ApiScheduledEscalation[]
}

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'muted'

function toneClasses(tone: Tone): string {
  switch (tone) {
    case 'primary': return 'bg-wd-primary/15 text-wd-primary'
    case 'success': return 'bg-wd-success/15 text-wd-success'
    case 'warning': return 'bg-wd-warning/15 text-wd-warning'
    case 'danger':  return 'bg-wd-danger/15 text-wd-danger'
    case 'muted':   return 'bg-wd-muted/15 text-wd-muted'
  }
}

function toneStroke(tone: Tone): string {
  switch (tone) {
    case 'primary': return 'var(--wd-primary)'
    case 'success': return 'var(--wd-success)'
    case 'warning': return 'var(--wd-warning)'
    case 'danger':  return 'var(--wd-danger)'
    case 'muted':   return 'var(--wd-muted)'
  }
}

function deltaClass(tone: Tone): string {
  switch (tone) {
    case 'success': return 'text-wd-success'
    case 'warning': return 'text-wd-warning'
    case 'danger':  return 'text-wd-danger'
    case 'primary': return 'text-wd-primary'
    case 'muted':   return 'text-wd-muted'
  }
}

export function NotificationKpis({ stats, recentLog, escalations }: Props) {
  const { prefs } = useFormat()
  // Single bucketLog call — all three sparks share the same 24h × 24-bucket window.
  const sparks = useMemo(() => {
    const buckets = bucketLog(recentLog, 24 * 60 * 60 * 1000, 24, prefs)
    const labels = buckets.map((b) => b.label)
    const throughput = buckets.map((b) => b.slack + b.discord + b.email + b.webhook)
    const latency = buckets.map((b) => b.p50 ?? 0)
    const success = buckets.map((b) => {
      const good = b.slack + b.discord + b.email + b.webhook
      const total = good + b.failed
      return total === 0 ? 100 : (good / total) * 100
    })
    return { labels, throughput, latency, success }
  }, [recentLog, prefs])

  const sent = stats?.sent ?? 0
  const failed = stats?.failed ?? 0
  const suppressed = stats?.suppressed ?? 0
  const pending = stats?.pending ?? 0

  const totalAttempts = sent + failed
  const successPct = totalAttempts > 0 ? (sent / totalAttempts) * 100 : 100
  const median = medianLatency(recentLog)
  const queued = pending + escalations.length

  const successTone: Tone = successPct >= 99 ? 'success' : successPct >= 95 ? 'warning' : 'danger'
  const latencyTone: Tone = median === null ? 'muted' : median < 400 ? 'success' : median < 1000 ? 'warning' : 'danger'
  const queuedTone: Tone = queued === 0 ? 'success' : queued > 20 ? 'danger' : queued > 5 ? 'warning' : 'success'

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        icon="solar:bell-bing-outline"
        tone="primary"
        title="Dispatched · 24h"
        value={sent.toLocaleString()}
        delta={failed > 0 ? `+${failed} failed` : 'no failures'}
        deltaTone={failed > 0 ? 'warning' : 'success'}
        deltaLabel={failed > 0 ? 'retry inflight' : 'clean run'}
        spark={sparks.throughput}
        sparkLabels={sparks.labels}
        sparkFormat={(n) => `${n} sent`}
      />
      <KpiCard
        icon="solar:check-circle-outline"
        tone={successTone}
        title="Delivery Success"
        value={successPct.toFixed(1)}
        unit="%"
        delta={
          totalAttempts === 0
            ? 'no traffic'
            : successPct >= 99
              ? 'healthy'
              : successPct >= 95
                ? 'elevated failures'
                : 'provider problems'
        }
        deltaTone={successTone}
        deltaLabel={`of ${totalAttempts.toLocaleString()} attempts`}
        spark={sparks.success}
        sparkLabels={sparks.labels}
        sparkFormat={(n) => `${n.toFixed(1)}%`}
        sparkYMin={0}
        sparkYMax={100}
      />
      <KpiCard
        icon="solar:stopwatch-outline"
        tone={latencyTone}
        title="Median Delivery Latency"
        value={median === null ? '—' : Math.round(median).toString()}
        unit={median === null ? '' : 'ms'}
        delta={
          median === null
            ? 'no samples'
            : median < 400
              ? 'within SLO'
              : median < 1000
                ? 'elevated'
                : 'slow path'
        }
        deltaTone={latencyTone}
        deltaLabel="event → provider ack"
        spark={sparks.latency}
        sparkLabels={sparks.labels}
        sparkFormat={(n) => `${Math.round(n)}ms`}
      />
      <KpiCard
        icon="solar:inbox-outline"
        tone={queuedTone}
        title="Queued + Escalating"
        value={queued.toString()}
        delta={
          queued === 0
            ? 'queue is clear'
            : `${pending} pending · ${escalations.length} escalations`
        }
        deltaTone={queuedTone}
        deltaLabel={queued === 0 ? undefined : 'awaiting delivery'}
        spark={null}
      />
      <div className="hidden">
        {/* suppressed is shown in the banner + Suppression panel; keep here
           for future tile-swap without losing wiring */}
        {suppressed}
      </div>
    </div>
  )
}

function KpiCard({
  icon,
  tone,
  title,
  value,
  unit,
  delta,
  deltaTone = 'muted',
  deltaLabel,
  spark,
  sparkLabels,
  sparkFormat,
  sparkYMin,
  sparkYMax,
}: {
  icon: string
  tone: Tone
  title: string
  value: string
  unit?: string
  delta?: string
  deltaTone?: Tone
  deltaLabel?: string
  spark?: number[] | null
  sparkLabels?: string[]
  sparkFormat?: (n: number) => string
  sparkYMin?: number
  sparkYMax?: number
}) {
  return (
    <div className="relative flex flex-col gap-2.5 rounded-xl border border-wd-border/50 bg-wd-surface px-4 py-3.5 min-h-[118px] overflow-hidden">
      <div className="flex items-center gap-2.5">
        <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center', toneClasses(tone))}>
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
          <div className={cn('mt-1.5 text-[11px] font-medium', deltaClass(deltaTone))}>
            {delta}
            {deltaLabel && (
              <span className="ml-1 text-wd-muted/70 font-normal">{deltaLabel}</span>
            )}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && spark.some((v) => v > 0) && (
        <div className="mt-auto -mx-4">
          <WideSpark
            data={spark}
            color={toneStroke(tone)}
            height={46}
            labels={sparkLabels}
            formatValue={sparkFormat}
            yMin={sparkYMin}
            yMax={sparkYMax}
          />
        </div>
      )}
    </div>
  )
}
