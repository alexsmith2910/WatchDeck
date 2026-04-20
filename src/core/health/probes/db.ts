/**
 * `db` probe — proves the configured MongoDB connection is reachable and
 * responsive. Calls the storage adapter's healthCheck() (which runs
 * `admin.command('ping')`) and times the round trip.
 *
 * Cadence: 15s active.
 */

import { performance } from 'node:perf_hooks'
import type { ProbeFn } from '../probeTypes.js'
import type { StorageAdapter } from '../../../storage/adapter.js'

export function createDbProbe(adapter: StorageAdapter): ProbeFn {
  return async () => {
    const start = performance.now()
    const ping = await adapter.healthCheck()
    const latencyMs = Math.round(performance.now() - start)

    const connected = adapter.isConnected()
    const isHealthyPing = ping.status === 'healthy' || ping.status === 'degraded'

    let status: 'healthy' | 'degraded' | 'down'
    let error: string | undefined
    if (!connected || !isHealthyPing) {
      status = 'down'
      error = !connected ? 'adapter reports disconnected' : 'ping failed'
    } else if (latencyMs > 500 || ping.status === 'degraded') {
      status = 'degraded'
    } else {
      status = 'healthy'
    }

    return {
      subsystemId: 'db',
      status,
      latencyMs,
      details: {
        connected,
        currentOutageSeconds: adapter.currentOutageDuration(),
        reconnectAttempt: adapter.reconnectAttempt(),
        pingStatus: ping.status,
      },
      probedAt: Date.now(),
      error,
    }
  }
}
