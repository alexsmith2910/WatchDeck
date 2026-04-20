/**
 * `notifications` probe — combined readout of channel configuration and
 * recent dispatcher activity.
 *
 * Status mapping:
 *  - no channels configured              → disabled
 *  - channels configured, no recent send → healthy (quiet but wired)
 *  - failure rate over the last 5 min
 *     >= 50%                              → down
 *     >= 10%                              → degraded
 *     <  10%                              → healthy
 *
 * Counters are sourced from the `notificationMetrics` singleton so the
 * probe is a cheap read — the DB is only touched to count channels.
 */

import type { ProbeFn } from '../probeTypes.js'
import type { StorageAdapter } from '../../../storage/adapter.js'
import type { NotificationChannelDoc } from '../../../storage/types.js'
import { notificationMetrics } from '../../../notifications/metrics.js'

function groupByType(channels: NotificationChannelDoc[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const ch of channels) {
    out[ch.type] = (out[ch.type] ?? 0) + 1
  }
  return out
}

export function createNotificationsProbe(adapter: StorageAdapter): ProbeFn {
  return async () => {
    let channels: NotificationChannelDoc[] = []
    try {
      channels = await adapter.listNotificationChannels()
    } catch {
      // The db probe owns reporting DB health — treat as disabled here.
      return {
        subsystemId: 'notifications',
        status: 'disabled',
        latencyMs: null,
        details: { channelCount: 0, dbUnavailable: true },
        probedAt: Date.now(),
      }
    }

    if (channels.length === 0) {
      return {
        subsystemId: 'notifications',
        status: 'disabled',
        latencyMs: null,
        details: { channelCount: 0 },
        probedAt: Date.now(),
      }
    }

    const failureRate = notificationMetrics.failureRate5m()
    const last24hSent = notificationMetrics.last24hSent()
    const last24hFailed = notificationMetrics.last24hFailed()

    let status: 'healthy' | 'degraded' | 'down' = 'healthy'
    if (failureRate >= 0.5) status = 'down'
    else if (failureRate >= 0.1) status = 'degraded'

    return {
      subsystemId: 'notifications',
      status,
      latencyMs: null,
      details: {
        channelCount: channels.length,
        byType: groupByType(channels),
        totalSent: notificationMetrics.totalSent,
        totalFailed: notificationMetrics.totalFailed,
        totalSuppressed: notificationMetrics.totalSuppressed,
        last24hSent,
        last24hFailed,
        failureRate5m: Number(failureRate.toFixed(3)),
        lastDispatchAt: notificationMetrics.lastDispatchAt,
        lastFailureAt: notificationMetrics.lastFailureAt,
      },
      probedAt: Date.now(),
    }
  }
}
