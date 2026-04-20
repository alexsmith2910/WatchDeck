/**
 * Shared helpers for the Notifications page.
 *
 * Keeps derivation of channel status, channel target display, and chart
 * bucketing in one place so every panel agrees on the same logic.
 */
import type { ApiChannel, ApiNotificationLogRow, ApiNotificationStats, ChannelType } from '../../types/notifications'

export type OverallDeliveryState = 'operational' | 'degraded' | 'outage'
export type ChannelUiStatus = 'healthy' | 'degraded' | 'paused'

export interface ChannelStats {
  sent: number
  failed: number
  suppressed: number
}

export interface ChartBucket {
  label: string
  tsMs: number
  slack: number
  discord: number
  email: number
  webhook: number
  failed: number
  p50: number | null
  p95: number | null
}

/**
 * A short, user-recognizable routing target for a channel (e.g. `#ops-alerts`,
 * `events.pagerduty.com`). Falls back to the channel's type name if nothing
 * specific is configured.
 */
export function channelTargetLabel(ch: ApiChannel): string {
  switch (ch.type) {
    case 'slack':
      return ch.slackChannelId ?? ch.slackWorkspaceName ?? 'slack webhook'
    case 'discord':
      if (ch.discordChannelId) return ch.discordChannelId
      if (ch.discordGuildId) return `guild ${ch.discordGuildId.slice(-4)}`
      return 'discord webhook'
    case 'email':
      return ch.emailRecipients?.[0] ?? ch.emailEndpoint ?? 'email'
    case 'webhook':
      try {
        if (ch.webhookUrl) return new URL(ch.webhookUrl).hostname
      } catch { /* ignore */ }
      return 'webhook'
  }
}

export function statsByChannel(stats: ApiNotificationStats | null): Map<string, ChannelStats> {
  const m = new Map<string, ChannelStats>()
  for (const row of stats?.byChannel ?? []) {
    m.set(row.channelId, { sent: row.sent, failed: row.failed, suppressed: row.suppressed })
  }
  return m
}

/**
 * Per-channel UI health. We can't see recent DB write failures from the
 * client, so we derive health from what we have: the enabled bit, the
 * connection flag set by the last test, and the 24h failure rate.
 */
export function deriveChannelStatus(
  ch: ApiChannel,
  s: ChannelStats | undefined,
): ChannelUiStatus {
  if (!ch.enabled) return 'paused'
  const total = (s?.sent ?? 0) + (s?.failed ?? 0)
  const failureRate = total > 0 ? (s?.failed ?? 0) / total : 0
  if (!ch.isConnected && total > 0) return 'degraded'
  if (failureRate > 0.05) return 'degraded'
  return 'healthy'
}

/**
 * Overall banner state — aggregates enabled channels + 24h totals. Outage is
 * reserved for >15% failure or zero connected channels with traffic present.
 */
export function deriveOverallState(
  channels: ApiChannel[],
  stats: ApiNotificationStats | null,
  byChannel: Map<string, ChannelStats>,
): OverallDeliveryState {
  const active = channels.filter((c) => c.enabled)
  if (active.length === 0) return 'operational'
  const total = (stats?.sent ?? 0) + (stats?.failed ?? 0)
  if (total === 0) return 'operational'
  const failureRate = (stats?.failed ?? 0) / total
  if (failureRate > 0.15) return 'outage'
  const hasDegradedChannel = active.some((c) => deriveChannelStatus(c, byChannel.get(c._id)) === 'degraded')
  if (failureRate > 0.05 || hasDegradedChannel) return 'degraded'
  return 'operational'
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 'never'
  const diff = Date.now() - t
  const abs = Math.abs(diff)
  const secs = Math.round(abs / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function formatCountdown(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(hrs / 24)}d`
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

/**
 * Time-bucket the recent delivery log for charts + sparklines.
 *
 * Buckets are evenly spaced across the chosen window. Each bucket holds a
 * per-channel-type count (for the stacked-bar chart) and a p50/p95 latency
 * summary (for the latency chart).
 */
export function bucketLog(
  log: ApiNotificationLogRow[],
  windowMs: number,
  bucketCount: number,
): ChartBucket[] {
  const now = Date.now()
  const windowStart = now - windowMs
  const step = windowMs / bucketCount
  const buckets: ChartBucket[] = []
  const latencyByBucket: number[][] = []

  for (let i = 0; i < bucketCount; i++) {
    const tsMs = windowStart + i * step
    buckets.push({
      label: new Date(tsMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      tsMs,
      slack: 0,
      discord: 0,
      email: 0,
      webhook: 0,
      failed: 0,
      p50: null,
      p95: null,
    })
    latencyByBucket.push([])
  }

  for (const row of log) {
    const t = new Date(row.sentAt).getTime()
    if (!Number.isFinite(t) || t < windowStart || t > now) continue
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - windowStart) / step)))
    const b = buckets[idx]
    if (row.deliveryStatus === 'failed') {
      b.failed += 1
    } else if (row.deliveryStatus === 'sent') {
      b[row.channelType as ChannelType] += 1
      if (typeof row.latencyMs === 'number') latencyByBucket[idx].push(row.latencyMs)
    }
  }

  for (let i = 0; i < bucketCount; i++) {
    buckets[i].p50 = median(latencyByBucket[i])
    buckets[i].p95 = percentile(latencyByBucket[i], 95)
  }

  return buckets
}

/** Median latency across all `sent` entries in the log (for the KPI tile). */
export function medianLatency(log: ApiNotificationLogRow[]): number | null {
  const vals: number[] = []
  for (const r of log) {
    if (r.deliveryStatus === 'sent' && typeof r.latencyMs === 'number') vals.push(r.latencyMs)
  }
  return median(vals)
}

/** A 24-point sparkline of per-bucket channel throughput. */
export function channelSparkline(
  log: ApiNotificationLogRow[],
  channelId: string,
  windowMs: number,
  bucketCount = 24,
): number[] {
  const now = Date.now()
  const start = now - windowMs
  const step = windowMs / bucketCount
  const out = new Array<number>(bucketCount).fill(0)
  for (const r of log) {
    if (r.channelId !== channelId) continue
    const t = new Date(r.sentAt).getTime()
    if (!Number.isFinite(t) || t < start || t > now) continue
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - start) / step)))
    if (r.deliveryStatus === 'sent' || r.deliveryStatus === 'failed') out[idx] += 1
  }
  return out
}

/** Friendly label for the suppressed-reason pie. */
export function readableReason(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export const SUPPRESSION_COLORS: Record<string, string> = {
  cooldown:         'var(--wd-warning)',
  coalesced:        'var(--wd-primary)',
  severity_filter:  '#a78bfa',
  quiet_hours:      '#b19cd9',
  rate_limit:       'var(--wd-danger)',
  muted:            'var(--wd-muted)',
  channel_disabled: 'var(--wd-muted)',
  maintenance:      '#22d3ee',
  event_filter:     '#34d399',
  module_disabled:  'var(--wd-muted)',
}

export function colorForReason(reason: string): string {
  return SUPPRESSION_COLORS[reason] ?? 'var(--wd-muted)'
}
