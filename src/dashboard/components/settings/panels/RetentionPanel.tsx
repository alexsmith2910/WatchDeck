/**
 * Retention panel — read-only view of `ctx.config.retention` and
 * `ctx.config.aggregation`. These values drive MongoDB TTL indexes (raw
 * checks, notification log) and the daily roll-up cron, both set up at
 * migration time, so edits require restarting the process.
 *
 *   GET /settings/retention
 *   GET /settings/aggregation
 */
import { useCallback, useEffect, useState } from 'react'
import { Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { SectionHead } from '../../endpoint-detail/primitives'
import { useApi } from '../../../hooks/useApi'

interface RetentionConfig {
  detailedDays: number
  hourlyDays: number
  daily: string
  notificationLogDays: number
}

interface AggregationConfig {
  time: string
}

const FALLBACK_RETENTION: RetentionConfig = {
  detailedDays: 30,
  hourlyDays: 90,
  daily: '1year',
  notificationLogDays: 60,
}

const FALLBACK_AGGREGATION: AggregationConfig = { time: '03:00' }

export function RetentionPanel() {
  const { request } = useApi()
  const [retention, setRetention] = useState<RetentionConfig | null>(null)
  const [aggregation, setAggregation] = useState<AggregationConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [r, a] = await Promise.all([
      request<{ data: RetentionConfig }>('/settings/retention'),
      request<{ data: AggregationConfig }>('/settings/aggregation'),
    ])
    setRetention(r.data?.data ?? FALLBACK_RETENTION)
    setAggregation(a.data?.data ?? FALLBACK_AGGREGATION)
    setLoading(false)
  }, [request])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex items-center justify-center min-h-[200px]">
        <Spinner size="sm" />
      </div>
    )
  }

  const r = retention ?? FALLBACK_RETENTION
  const a = aggregation ?? FALLBACK_AGGREGATION

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:archive-down-minimlistic-outline"
        title="Retention"
        sub="How long each kind of data is kept. TTL indexes enforce these at the Mongo layer."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RetentionRow
          icon="solar:pulse-linear"
          label="Detailed checks"
          value={`${r.detailedDays} days`}
          hint="Raw check results (one row per probe) in mx_checks."
        />
        <RetentionRow
          icon="solar:chart-2-linear"
          label="Hourly summaries"
          value={`${r.hourlyDays} days`}
          hint="Aggregated hourly rollups in mx_hourly_summaries."
        />
        <RetentionRow
          icon="solar:calendar-linear"
          label="Daily summaries"
          value={formatDailyRetention(r.daily)}
          hint="Per-endpoint daily rows in mx_daily_summaries."
        />
        <RetentionRow
          icon="solar:bell-outline"
          label="Notification log"
          value={`${r.notificationLogDays} days`}
          hint="Notification delivery history in mx_notification_log."
        />
      </div>

      <div className="mt-5 pt-4 border-t border-wd-border/40">
        <SectionHead
          icon="solar:clock-square-linear"
          title="Aggregation"
          sub="Scheduled roll-up of raw checks into hourly and daily summaries."
          className="mb-3"
        />
        <RetentionRow
          icon="solar:clock-square-linear"
          label="Daily aggregation time"
          value={`${a.time} UTC`}
          hint="Runs once per day. Rolls hourly summaries into daily and applies TTL cleanup."
        />
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-wd-border/40 bg-wd-surface-hover/20 px-3 py-2 text-[11.5px] text-wd-muted">
        <Icon icon="solar:info-circle-linear" width={14} className="mt-0.5 shrink-0" />
        <span>
          TTL indexes are created at migration time. Edit <span className="font-mono text-foreground">watchdeck.config.js</span>{' '}
          under <span className="font-mono text-foreground">retention.*</span> or{' '}
          <span className="font-mono text-foreground">aggregation.*</span> and restart to change.
        </span>
      </div>
    </div>
  )
}

function RetentionRow({
  icon,
  label,
  value,
  hint,
}: {
  icon: string
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-wd-border/40 bg-wd-surface-hover/30 px-3 py-2.5">
      <div className={cn('flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-wd-primary/10 text-wd-primary')}>
        <Icon icon={icon} width={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-wd-muted">{hint}</div>
      </div>
      <span className="font-mono text-[12px] text-foreground shrink-0 pt-1">{value}</span>
    </div>
  )
}

function formatDailyRetention(value: string): string {
  switch (value) {
    case '6months': return '6 months'
    case '1year': return '1 year'
    case 'indefinite': return 'Indefinite'
    default: return value
  }
}
