/**
 * Rolling, in-memory metrics for the notification dispatcher.
 *
 * Consumed by the `notifications` health probe (see `src/core/health/probes/notifications.ts`)
 * and by the forthcoming Notifications page KPI cards. Every counter resets
 * on process restart — persistent counts should always be sourced from
 * `mx_notification_log` queries.
 *
 * Rolling windows use a monotonically-sorted ring of timestamps so they can
 * answer "how many dispatches in the last N ms" without scanning the whole log.
 */

import type { NotificationKind } from '../storage/types.js'

interface Event {
  ts: number
  kind: NotificationKind | 'unknown'
  channelId: string | null
}

class RollingWindow {
  private readonly events: Event[] = []

  constructor(private readonly windowMs: number) {}

  push(ev: Event): void {
    this.events.push(ev)
    this.trim(ev.ts - this.windowMs)
  }

  count(sinceMs?: number): number {
    if (sinceMs !== undefined) this.trim(sinceMs)
    return this.events.length
  }

  /** Lazy pruning — drop events older than `cutoffMs`. */
  private trim(cutoffMs: number): void {
    while (this.events.length > 0 && this.events[0]!.ts < cutoffMs) {
      this.events.shift()
    }
  }
}

class NotificationMetrics {
  totalSent = 0
  totalFailed = 0
  totalSuppressed = 0

  lastDispatchAt: number | null = null
  lastFailureAt: number | null = null

  private readonly sent5m = new RollingWindow(5 * 60_000)
  private readonly failed5m = new RollingWindow(5 * 60_000)
  private readonly sent24h = new RollingWindow(24 * 60 * 60_000)
  private readonly failed24h = new RollingWindow(24 * 60 * 60_000)

  recordSent(ev: { kind: NotificationKind; channelId: string }): void {
    const now = Date.now()
    this.totalSent += 1
    this.lastDispatchAt = now
    this.sent5m.push({ ts: now, kind: ev.kind, channelId: ev.channelId })
    this.sent24h.push({ ts: now, kind: ev.kind, channelId: ev.channelId })
  }

  recordFailed(ev: { kind: NotificationKind; channelId: string }): void {
    const now = Date.now()
    this.totalFailed += 1
    this.lastFailureAt = now
    this.failed5m.push({ ts: now, kind: ev.kind, channelId: ev.channelId })
    this.failed24h.push({ ts: now, kind: ev.kind, channelId: ev.channelId })
  }

  recordSuppressed(): void {
    this.totalSuppressed += 1
  }

  last24hSent(): number {
    return this.sent24h.count(Date.now() - 24 * 60 * 60_000)
  }

  last24hFailed(): number {
    return this.failed24h.count(Date.now() - 24 * 60 * 60_000)
  }

  /** Failure rate over the last 5 minutes; 0 when there have been no attempts. */
  failureRate5m(): number {
    const sent = this.sent5m.count(Date.now() - 5 * 60_000)
    const failed = this.failed5m.count(Date.now() - 5 * 60_000)
    const total = sent + failed
    if (total === 0) return 0
    return failed / total
  }

  reset(): void {
    this.totalSent = 0
    this.totalFailed = 0
    this.totalSuppressed = 0
    this.lastDispatchAt = null
    this.lastFailureAt = null
    // RollingWindows self-trim; force-drop by emitting a far-future cutoff.
    const far = Date.now() + 365 * 24 * 60 * 60_000
    this.sent5m.count(far)
    this.failed5m.count(far)
    this.sent24h.count(far)
    this.failed24h.count(far)
  }
}

export const notificationMetrics = new NotificationMetrics()
