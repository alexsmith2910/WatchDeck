/**
 * `eventbus` probe — emits a single `system:heartbeat` with a unique token
 * and waits for a one-shot listener to receive it. Measures the round-trip
 * latency of an emit ➝ on cycle.
 *
 * Cadence: 5s active.
 */

import { performance } from 'node:perf_hooks'
import type { ProbeFn } from '../probeTypes.js'
import { eventBus } from '../../eventBus.js'

const ROUND_TRIP_TIMEOUT_MS = 500

export function createEventBusProbe(): ProbeFn {
  return () => new Promise((resolve) => {
    const start = performance.now()
    const token = Math.random().toString(36).slice(2)
    let settled = false

    const handler = (p: { token: string }): void => {
      if (p.token !== token || settled) return
      settled = true
      clearTimeout(timer)
      eventBus.off('system:heartbeat', handler)
      const latencyMs = Math.round(performance.now() - start)
      resolve({
        subsystemId: 'eventbus',
        status: latencyMs > 5 ? 'degraded' : 'healthy',
        latencyMs,
        details: {
          historySize: eventBus.historySize(),
          subscriberCount: eventBus.totalListeners(),
        },
        probedAt: Date.now(),
      })
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      eventBus.off('system:heartbeat', handler)
      resolve({
        subsystemId: 'eventbus',
        status: 'down',
        latencyMs: Math.round(performance.now() - start),
        details: {
          historySize: eventBus.historySize(),
          subscriberCount: eventBus.totalListeners(),
        },
        probedAt: Date.now(),
        error: 'emit round-trip timed out',
      })
    }, ROUND_TRIP_TIMEOUT_MS)

    eventBus.on('system:heartbeat', handler)
    eventBus.emit('system:heartbeat', { timestamp: new Date(), token })
  })
}
