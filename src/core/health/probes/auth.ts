/**
 * `auth` probe — passive readout of the auth middleware.
 *
 * Reports:
 *   - `disabled` when no authMiddleware is configured (the resting state for
 *     a single-user local install).
 *   - `degraded` when the rolling-5-minute failure rate is above 50%.
 *   - `healthy` otherwise.
 */

import type { ProbeFn } from '../probeTypes.js'
import { authMetrics } from '../../../api/middleware/auth.js'
import type { WatchDeckConfig } from '../../../config/types.js'

const DEGRADED_FAILURE_RATE = 0.5

export function createAuthProbe(config: WatchDeckConfig): ProbeFn {
  return async () => {
    if (config.authMiddleware === null) {
      return {
        subsystemId: 'auth',
        status: 'disabled',
        latencyMs: null,
        details: { enabled: false },
        probedAt: Date.now(),
      }
    }

    const failureRate = authMetrics.failureRate()
    const status: 'healthy' | 'degraded' = failureRate >= DEGRADED_FAILURE_RATE ? 'degraded' : 'healthy'

    return {
      subsystemId: 'auth',
      status,
      latencyMs: null,
      details: {
        enabled: true,
        totalAttempts: authMetrics.totalAttempts,
        totalFailures: authMetrics.totalFailures,
        failureRate,
      },
      probedAt: Date.now(),
    }
  }
}
