/**
 * Incident Manager — listens to check:complete events and creates/resolves
 * incidents when an endpoint crosses its `failureThreshold` consecutive failures
 * or its `recoveryThreshold` consecutive healthy checks.
 *
 * Flow:
 *   1. check:complete fires with status = 'down' or 'degraded'
 *   2. If no active incident exists AND consecutiveFailures >= failureThreshold
 *      → create one, emit incident:opened
 *   3. If an active incident already exists → append the check to the timeline
 *   4. When a previously-failing endpoint returns status = 'healthy',
 *      we require `recoveryThreshold` consecutive healthy checks before
 *      resolving. A single healthy probe logs a timeline entry but does not
 *      close the incident unless the streak has met the threshold.
 *
 * Decision logic is purely in-memory (activeIncidents + endpointMeta maps) — no
 * DB reads needed to decide whether to open/resolve. Seeded from DB at init,
 * kept fresh via endpoint:created / endpoint:updated / endpoint:deleted events.
 */

import { eventBus } from '../core/eventBus.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { IncidentDoc } from '../storage/types.js'

interface EndpointMeta {
  failureThreshold: number
  recoveryThreshold: number
  consecutiveFailures: number
  consecutiveHealthy: number
}

export class IncidentManager {
  private adapter: StorageAdapter

  // In-memory map: endpointId → active incident _id (string).
  // Populated at init() from DB, then kept in sync by open/resolve.
  private activeIncidents = new Map<string, string>()

  // Per-endpoint threshold + running failure count. Populated at init() and
  // kept fresh by endpoint lifecycle events.
  private endpointMeta = new Map<string, EndpointMeta>()

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter
  }

  /** Load existing state from DB, then wire up event subscriptions. */
  async init(): Promise<void> {
    const [active, endpoints] = await Promise.all([
      this.adapter.listActiveIncidents(),
      this.adapter.listEnabledEndpoints(),
    ])
    for (const inc of active) {
      this.activeIncidents.set(inc.endpointId.toString(), inc.id.toString())
    }
    for (const ep of endpoints) {
      this.endpointMeta.set(ep.id.toString(), {
        failureThreshold: ep.failureThreshold,
        recoveryThreshold: ep.recoveryThreshold,
        consecutiveFailures: ep.consecutiveFailures,
        consecutiveHealthy: ep.consecutiveHealthy,
      })
    }

    this.subscribeToEndpointEvents()
    this.subscribeToCheckComplete()
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  private subscribeToEndpointEvents(): void {
    eventBus.subscribe(
      'endpoint:created',
      ({ endpoint }) => {
        if (endpoint.status === 'archived' || !endpoint.enabled) return
        this.endpointMeta.set(endpoint.id.toString(), {
          failureThreshold: endpoint.failureThreshold,
          recoveryThreshold: endpoint.recoveryThreshold,
          consecutiveFailures: endpoint.consecutiveFailures,
          consecutiveHealthy: endpoint.consecutiveHealthy,
        })
      },
      'critical',
    )

    eventBus.subscribe(
      'endpoint:updated',
      ({ endpointId, changes }) => {
        const existing = this.endpointMeta.get(endpointId)
        if (!existing) return
        if (typeof changes.failureThreshold === 'number') {
          existing.failureThreshold = changes.failureThreshold
        }
        if (typeof changes.recoveryThreshold === 'number') {
          existing.recoveryThreshold = changes.recoveryThreshold
        }
      },
      'critical',
    )

    eventBus.subscribe(
      'endpoint:deleted',
      ({ endpointId }) => {
        this.endpointMeta.delete(endpointId)
        this.activeIncidents.delete(endpointId)
      },
      'critical',
    )
  }

  private subscribeToCheckComplete(): void {
    eventBus.subscribe(
      'check:complete',
      (payload) => {
        // Fire-and-forget — errors logged but never crash the subscriber.
        void this.handleCheck(payload).catch((err: unknown) => {
          eventBus.emit('system:warning', {
            timestamp: new Date(),
            module: 'incidentManager',
            message: `handleCheck failed for ${payload.endpointId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        })
      },
      'standard',
    )
  }

  // ---------------------------------------------------------------------------
  // Core logic
  // ---------------------------------------------------------------------------

  private async handleCheck(payload: {
    timestamp: Date
    endpointId: string
    status: 'healthy' | 'degraded' | 'down'
    responseTime: number
    statusCode: number | null
    errorMessage: string | null
  }): Promise<void> {
    const { endpointId, status, timestamp, responseTime, statusCode, errorMessage } = payload
    const hasActiveIncident = this.activeIncidents.has(endpointId)
    const meta = await this.ensureMeta(endpointId)
    if (!meta) return

    if (status === 'healthy') {
      // Reset the failure streak and extend the healthy streak.
      meta.consecutiveFailures = 0
      meta.consecutiveHealthy = meta.consecutiveHealthy + 1

      if (hasActiveIncident) {
        const incidentId = this.activeIncidents.get(endpointId)!
        // Log every healthy probe while the incident is still open so the
        // recovery progression is visible on the timeline.
        const detail = `healthy — ${statusCode ?? 'no status code'} — ${responseTime}ms (${meta.consecutiveHealthy}/${meta.recoveryThreshold})`
        await this.adapter.addIncidentTimelineEvent(incidentId, {
          at: timestamp,
          event: 'check',
          detail,
        })
        // Gate on recoveryThreshold: only resolve once the healthy streak
        // crosses the threshold.
        if (meta.consecutiveHealthy >= meta.recoveryThreshold) {
          await this.resolveIncident(endpointId, timestamp)
        }
      }
      return
    }

    // ── Failure (down or degraded) ──
    meta.consecutiveFailures = meta.consecutiveFailures + 1
    meta.consecutiveHealthy = 0

    if (hasActiveIncident) {
      // Already tracking — log this check to the incident timeline.
      const incidentId = this.activeIncidents.get(endpointId)!
      const detail = errorMessage
        ? `${status} — ${errorMessage}`
        : `${status} — ${statusCode ?? 'no status code'} — ${responseTime}ms`
      await this.adapter.addIncidentTimelineEvent(incidentId, {
        at: timestamp,
        event: 'check',
        detail,
      })
      return
    }

    // Gate on failureThreshold: only open once the streak crosses the threshold.
    if (meta.consecutiveFailures < meta.failureThreshold) return

    await this.openIncident(endpointId, status, timestamp, errorMessage)
  }

  /**
   * Get or hydrate the meta entry for an endpoint. If the in-memory cache is
   * cold (init race, endpoint re-enabled after an archive, etc.) we re-read
   * from the DB so the gate always uses the endpoint's REAL failureThreshold —
   * never a fail-fast default that would open an incident on a single failure.
   * Returns null only if the endpoint no longer exists.
   */
  private async ensureMeta(endpointId: string): Promise<EndpointMeta | null> {
    const cached = this.endpointMeta.get(endpointId)
    if (cached) return cached

    const ep = await this.adapter.getEndpointById(endpointId).catch(() => null)
    if (!ep) {
      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'incidentManager',
        message: `ensureMeta: endpoint ${endpointId} not found — skipping incident gate`,
      })
      return null
    }

    const meta: EndpointMeta = {
      failureThreshold: ep.failureThreshold,
      recoveryThreshold: ep.recoveryThreshold,
      consecutiveFailures: ep.consecutiveFailures,
      consecutiveHealthy: ep.consecutiveHealthy,
    }
    this.endpointMeta.set(endpointId, meta)
    return meta
  }

  // ---------------------------------------------------------------------------
  // Open / Resolve
  // ---------------------------------------------------------------------------

  private async openIncident(
    endpointId: string,
    status: 'healthy' | 'degraded' | 'down',
    timestamp: Date,
    errorMessage: string | null,
  ): Promise<void> {
    // Double-check no race — another tick may have already opened one.
    if (this.activeIncidents.has(endpointId)) return

    const cause = status === 'down' ? 'endpoint_down' : 'endpoint_degraded'
    const causeDetail = errorMessage ?? `Endpoint is ${status}`

    const incident: Omit<IncidentDoc, 'id' | 'createdAt' | 'updatedAt'> = {
      endpointId,
      status: 'active',
      cause,
      causeDetail,
      startedAt: timestamp,
      timeline: [{ at: timestamp, event: 'opened', detail: causeDetail }],
      notificationsSent: 0,
    }

    const doc = await this.adapter.createIncident(incident)
    const incidentId = doc.id.toString()

    this.activeIncidents.set(endpointId, incidentId)

    // Link incident to endpoint
    await this.adapter.setEndpointCurrentIncident(endpointId, incidentId).catch(() => {
      // Non-critical — the incident is already created
    })

    eventBus.emit('incident:opened', { timestamp, incident: doc })
  }

  private async resolveIncident(endpointId: string, timestamp: Date): Promise<void> {
    const incidentId = this.activeIncidents.get(endpointId)
    if (!incidentId) return

    // Look up the incident to compute duration.
    const existing = await this.adapter.getIncidentById(incidentId)
    if (!existing) {
      this.activeIncidents.delete(endpointId)
      return
    }

    const durationSeconds = Math.round(
      (timestamp.getTime() - existing.startedAt.getTime()) / 1000,
    )

    const resolved = await this.adapter.resolveIncident(incidentId, timestamp, durationSeconds)
    this.activeIncidents.delete(endpointId)

    // Unlink incident from endpoint
    await this.adapter.setEndpointCurrentIncident(endpointId, null).catch(() => {
      // Non-critical
    })

    if (resolved) {
      eventBus.emit('incident:resolved', { timestamp, incidentId, durationSeconds })
    }
  }
}
