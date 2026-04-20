/**
 * `checkers` probe — strongest probe in the system: it dispatches a real
 * HTTP request through the same undici client that handles user endpoints,
 * targeting our own `/api/health/ping` route.
 *
 * Success means: scheduler-side dispatch ➝ HTTP client ➝ Fastify ➝ ping
 * handler all worked end-to-end. Failure points anywhere in that chain
 * surface here first.
 */

import { performance } from 'node:perf_hooks'
import type { ProbeFn } from '../probeTypes.js'
import type { CheckScheduler } from '../../scheduler.js'
import { dispatchSyntheticCheck } from '../../../checks/syntheticCheck.js'
import { activity } from '../activity.js'

function avgChecksPerSec(windowSec = 60): number {
  const buckets = activity.recentPerSecond(windowSec)
  if (buckets.length === 0) return 0
  let sum = 0
  for (const b of buckets) sum += b.checksPerSec
  return sum / buckets.length
}

export interface CheckersProbeDeps {
  scheduler: CheckScheduler
  /** Resolves the URL of our own ping route at probe time so port changes are picked up. */
  pingUrl: () => string
  /** Per-call timeout for the loopback request. */
  timeoutMs?: number
}

export function createCheckersProbe(deps: CheckersProbeDeps): ProbeFn {
  const { scheduler, pingUrl, timeoutMs = 5_000 } = deps

  return async () => {
    const start = performance.now()
    let latencyMs = 0
    try {
      const result = await dispatchSyntheticCheck({
        url: pingUrl(),
        timeoutMs,
      })
      latencyMs = Math.round(performance.now() - start)

      let status: 'healthy' | 'degraded' | 'down'
      let error: string | undefined
      if (!result.ok) {
        status = 'down'
        error = result.error ?? 'loopback failed'
      } else if (latencyMs > 1000) {
        status = 'degraded'
      } else {
        status = 'healthy'
      }

      return {
        subsystemId: 'checkers',
        status,
        latencyMs,
        details: {
          httpStatus: result.statusCode,
          dispatchQueueDepth: scheduler.queueSize,
          concurrentInFlightPeakLastSecond: scheduler.runningChecksPeakLastSecond(),
          checksPerSecAvg: avgChecksPerSec(60),
        },
        probedAt: Date.now(),
        error,
      }
    } catch (err) {
      latencyMs = Math.round(performance.now() - start)
      return {
        subsystemId: 'checkers',
        status: 'down',
        latencyMs,
        details: {
          dispatchQueueDepth: scheduler.queueSize,
          checksPerSecAvg: avgChecksPerSec(60),
        },
        probedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
