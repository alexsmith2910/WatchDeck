/**
 * `scheduler` probe — passive readout of the 1-second tick loop's health.
 *
 * Reads the most recent five samples from the scheduler's tick-drift ring
 * buffer (the difference between when each tick was scheduled to fire and
 * when it actually did) and uses the worst absolute value as the latency
 * signal.
 *
 * An empty queue with nothing running is `standby` — that is the resting
 * state, not a fault.
 */

import type { ProbeFn } from '../probeTypes.js'
import type { CheckScheduler } from '../../scheduler.js'

export function createSchedulerProbe(scheduler: CheckScheduler): ProbeFn {
  return async () => {
    const samples = scheduler.driftSamples()
    const recent = samples.slice(-5)
    const maxDrift = recent.length === 0
      ? 0
      : Math.max(0, ...recent.map((s) => Math.abs(s.driftMs)))

    const queueSize = scheduler.queueSize
    const runningChecks = scheduler.runningChecks
    const peak = scheduler.runningChecksPeakLastSecond()

    let status: 'healthy' | 'degraded' | 'down' | 'standby'
    let error: string | undefined
    if (maxDrift > 1000) {
      status = 'down'
      error = `tick drift ${maxDrift}ms`
    } else if (maxDrift > 100) {
      status = 'degraded'
    } else if (queueSize === 0 && runningChecks === 0 && peak === 0) {
      status = 'standby'
    } else {
      status = 'healthy'
    }

    return {
      subsystemId: 'scheduler',
      status,
      latencyMs: maxDrift,
      details: {
        queueSize,
        runningChecks,
        runningChecksPeakLastSecond: peak,
        recentDriftMs: recent.map((s) => s.driftMs),
        nextDueInMs: scheduler.nextDueInMs(),
        sampleCount: samples.length,
      },
      probedAt: Date.now(),
      error,
    }
  }
}
