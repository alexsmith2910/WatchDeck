/**
 * `incidents` probe — passive readout of the internal incident tracker.
 *
 * Reports the number of currently-active internal incidents, the duration
 * of the longest one, and the timestamp of the most recent open/resolve.
 * This subsystem reports `standby` (no active work) or `healthy` (currently
 * tracking at least one incident). It never reports `degraded`/`down` —
 * the tracker itself is reporting on other subsystems' issues.
 */

import type { ProbeFn } from '../probeTypes.js'
import { internalIncidents } from '../../../alerts/internalIncidents.js'

export function createIncidentsProbe(): ProbeFn {
  return async () => {
    const active = internalIncidents.activeCount()
    const longestMs = internalIncidents.longestActiveDurationMs()
    const lastTransitionAt = internalIncidents.lastTransitionAt()

    return {
      subsystemId: 'incidents',
      status: active === 0 ? 'standby' : 'healthy',
      latencyMs: null,
      details: {
        active,
        longestActiveDurationMs: longestMs,
        lastTransitionAt: lastTransitionAt || null,
      },
      probedAt: Date.now(),
    }
  }
}
