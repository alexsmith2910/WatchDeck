/**
 * Overall delivery banner — mirrors HealthPage's OverallBanner layout. Derives
 * copy and tone from the `OverallDeliveryState` we compute in
 * notificationHelpers, and lays out the 24h KPIs in the metric row.
 */
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiChannel, ApiNotificationStats } from '../../types/notifications'
import type { OverallDeliveryState } from './notificationHelpers'

interface Props {
  state: OverallDeliveryState
  stats: ApiNotificationStats | null
  channels: ApiChannel[]
  healthyChannels: number
  lastUpdatedLabel: string
}

function labelFor(state: OverallDeliveryState, healthy: number, active: number): string {
  if (state === 'operational') {
    if (active === 0) return 'No channels configured'
    return 'All channels delivering'
  }
  const failing = Math.max(0, active - healthy)
  if (state === 'degraded') return `Delivery degraded on ${failing || 1} ${(failing || 1) === 1 ? 'channel' : 'channels'}`
  return 'Delivery is failing'
}

function subFor(
  state: OverallDeliveryState,
  stats: ApiNotificationStats | null,
  active: number,
): string {
  if (state === 'operational') {
    if (active === 0) return 'Add a channel above to start routing alerts.'
    if (!stats || stats.sent + stats.failed === 0) return 'No traffic in the last 24h — send a test to confirm wiring.'
    return `${active} active · no delivery failures in the last 24h.`
  }
  if (state === 'degraded') {
    return 'Some providers are returning errors. Retries are in flight — inspect the failing channels below.'
  }
  return 'Most dispatches are failing. Likely auth or rate-limit rejection — check the delivery log.'
}

export function DeliveryBanner({ state, stats, channels, healthyChannels, lastUpdatedLabel }: Props) {
  const activeCount = channels.filter((c) => c.enabled).length
  const label = labelFor(state, healthyChannels, activeCount)
  const sub = subFor(state, stats, activeCount)
  const iconName =
    state === 'operational'
      ? 'solar:bell-bing-bold'
      : state === 'degraded'
        ? 'solar:bell-bing-bold'
        : 'solar:bell-off-bold'

  const borderTint =
    state === 'operational'
      ? 'border-wd-border/50'
      : state === 'degraded'
        ? 'border-wd-warning/30'
        : 'border-wd-danger/30'
  const bgTint =
    state === 'operational'
      ? 'bg-wd-surface'
      : state === 'degraded'
        ? 'bg-wd-warning/5'
        : 'bg-wd-danger/5'
  const pulseColor =
    state === 'operational'
      ? 'bg-wd-success/15 text-wd-success'
      : state === 'degraded'
        ? 'bg-wd-warning/15 text-wd-warning'
        : 'bg-wd-danger/15 text-wd-danger'

  const sent = stats?.sent ?? 0
  const failed = stats?.failed ?? 0
  const suppressed = stats?.suppressed ?? 0

  return (
    <div
      className={cn(
        'grid items-center gap-6 rounded-xl border px-5 py-4.5',
        'grid-cols-1 lg:grid-cols-[auto_1fr_auto]',
        borderTint,
        bgTint,
      )}
    >
      <div className="flex items-center gap-4">
        <div className={cn('relative h-12 w-12 rounded-2xl flex items-center justify-center', pulseColor)}>
          <span className="absolute inset-[-4px] rounded-[18px] bg-current opacity-10 animate-ping" />
          <Icon icon={iconName} width={26} />
        </div>
        <div>
          <div className="text-[21px] font-semibold leading-tight tracking-tight text-foreground">
            {label}
          </div>
          <div className="text-xs text-wd-muted mt-0.5">{sub}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <BannerMetric
          label="Channels"
          value={String(healthyChannels)}
          unit={`/ ${activeCount} delivering`}
          tone={
            activeCount === 0
              ? 'muted'
              : healthyChannels === activeCount
                ? 'success'
                : healthyChannels === 0
                  ? 'danger'
                  : 'warning'
          }
        />
        <BannerMetric
          label="Sent (24h)"
          value={sent.toLocaleString()}
          unit="notifications"
          tone={sent > 0 ? 'success' : 'muted'}
        />
        <BannerMetric
          label="Failed (24h)"
          value={failed.toLocaleString()}
          unit={failed > 0 ? 'retrying' : ''}
          tone={failed > 0 ? 'danger' : 'muted'}
        />
        <BannerMetric
          label="Suppressed (24h)"
          value={suppressed.toLocaleString()}
          unit="by rules"
          tone={suppressed > 0 ? 'warning' : 'muted'}
        />
      </div>
      <div className="inline-flex items-center gap-2 rounded-full border border-wd-border/50 bg-wd-surface-hover/40 px-3 py-1.5 text-[11px] text-wd-muted font-mono self-start lg:self-auto">
        <span className="h-1.5 w-1.5 rounded-full bg-wd-success animate-pulse" />
        Updated {lastUpdatedLabel}
      </div>
    </div>
  )
}

type MetricTone = 'success' | 'warning' | 'danger' | 'muted'

const TONE_VALUE: Record<MetricTone, string> = {
  success: 'text-wd-success',
  warning: 'text-wd-warning',
  danger:  'text-wd-danger',
  muted:   'text-foreground',
}

function BannerMetric({
  label,
  value,
  unit,
  tone = 'muted',
}: {
  label: string
  value: string
  unit?: string
  tone?: MetricTone
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80">
        {label}
      </span>
      <span className={cn('text-[15px] font-semibold font-mono', TONE_VALUE[tone])}>
        {value}
        {unit && <span className="ml-1 text-[11px] text-wd-muted font-medium">{unit}</span>}
      </span>
    </div>
  )
}
