/**
 * `aggregator` probe — passive readout of the aggregation scheduler.
 *
 * Reports last/next run timestamps and durations. The aggregator is mostly
 * idle (one run per hour, one per day) so the resting state is `standby`.
 *
 * The probe goes `degraded` if the scheduler appears to have missed a run:
 *   - the next hourly run was due more than a minute ago AND we haven't
 *     run an hourly rollup in the last 90 minutes, OR
 *   - we've been up for more than 90 minutes and never ran any hourly.
 */

import type { ProbeFn } from '../probeTypes.js'
import type { AggregationScheduler } from '../../../aggregation/scheduler.js'

export function createAggregatorProbe(aggregator: AggregationScheduler): ProbeFn {
  return async () => {
    const now = Date.now()
    const lastH = aggregator.lastHourlyRunAt
    const lastD = aggregator.lastDailyRunAt
    const nextH = aggregator.nextHourlyRunAt
    const nextD = aggregator.nextDailyRunAt
    const uptimeSec = aggregator.uptimeSeconds

    const ninetyMinMs = 90 * 60 * 1000
    let status: 'healthy' | 'degraded' | 'standby' = 'standby'
    let error: string | undefined

    const hourlyOverdue =
      nextH > 0 && nextH < now - 60_000 && (lastH === 0 || now - lastH > ninetyMinMs)
    const neverRanButShould = lastH === 0 && uptimeSec > 90 * 60

    if (hourlyOverdue || neverRanButShould) {
      status = 'degraded'
      error = neverRanButShould
        ? 'no hourly rollup in 90+ minutes since boot'
        : 'hourly rollup is overdue'
    }

    return {
      subsystemId: 'aggregator',
      status,
      latencyMs: null,
      details: {
        lastHourlyRunAt: lastH || null,
        lastHourlyDurationMs: aggregator.lastHourlyDurationMs,
        nextHourlyRunAt: nextH,
        lastDailyRunAt: lastD || null,
        lastDailyDurationMs: aggregator.lastDailyDurationMs,
        nextDailyRunAt: nextD,
        uptimeSeconds: uptimeSec,
      },
      probedAt: now,
      error,
    }
  }
}
