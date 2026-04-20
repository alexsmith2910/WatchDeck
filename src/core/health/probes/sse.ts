/**
 * `sse` probe — passive heartbeat liveness.
 *
 * Reads the broker's last heartbeat timestamp and connected client count.
 * The broker maintains a global heartbeat that ticks even with zero clients
 * so 0 clients reads as `standby`, not `down`.
 */

import type { ProbeFn } from '../probeTypes.js'
import { getClientCount, lastHeartbeatAt, heartbeatIntervalMs } from '../../../api/sse.js'

export function createSseProbe(): ProbeFn {
  return async () => {
    const now = Date.now()
    const intervalMs = heartbeatIntervalMs()
    const ageMs = Math.max(0, now - lastHeartbeatAt())
    const clients = getClientCount()

    let status: 'healthy' | 'degraded' | 'down' | 'standby'
    let error: string | undefined

    if (intervalMs > 0 && ageMs > intervalMs * 3) {
      status = 'down'
      error = `no heartbeat for ${Math.round(ageMs / 1000)}s`
    } else if (intervalMs > 0 && ageMs > intervalMs * 1.5) {
      status = 'degraded'
    } else if (clients === 0) {
      status = 'standby'
    } else {
      status = 'healthy'
    }

    return {
      subsystemId: 'sse',
      status,
      latencyMs: null,
      details: {
        clients,
        lastHeartbeatAgeMs: ageMs,
        heartbeatIntervalMs: intervalMs,
      },
      probedAt: now,
      error,
    }
  }
}
