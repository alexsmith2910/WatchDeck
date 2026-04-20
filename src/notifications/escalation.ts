/**
 * Deferred escalation scheduler.
 *
 * When `incident:opened` fires and the endpoint has `escalationDelay > 0`
 * and an `escalationChannelId` set, the incident is scheduled for an
 * escalation dispatch after the delay. The scheduler keeps the timers in
 * memory only; on resolve / cancel the timer is cleared.
 *
 * On process restart (`init()`), active incidents are scanned and any that
 * are still within their escalation window are re-scheduled. Incidents that
 * already have a dispatched escalation log row are skipped — the log is the
 * source of truth for "did we already escalate this one".
 */

import { ObjectId } from 'mongodb'
import { eventBus } from '../core/eventBus.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { EndpointDoc, IncidentDoc } from '../storage/types.js'

export interface EscalationRequest {
  incidentId: string
  endpointId: string
  channelId: string
  /** Absolute ms timestamp at which escalation should fire. */
  firesAt: number
}

/** Callback invoked when an escalation timer fires. */
export type EscalationFireHandler = (req: {
  incidentId: string
  endpointId: string
  channelId: string
}) => void | Promise<void>

interface Pending {
  req: EscalationRequest
  timer: ReturnType<typeof setTimeout>
}

export class EscalationScheduler {
  private readonly pending = new Map<string, Pending>()
  private unsubscribes: Array<() => void> = []

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly onFire: EscalationFireHandler,
  ) {}

  async init(): Promise<void> {
    this.subscribe()
    await this.recoverActive()
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
  }

  size(): number {
    return this.pending.size
  }

  /** Snapshot of currently scheduled escalations. Safe to call from API routes. */
  list(): EscalationRequest[] {
    return [...this.pending.values()].map((p) => p.req)
  }

  /** Schedule (or reschedule) escalation for one incident. */
  schedule(req: EscalationRequest): void {
    this.cancel(req.incidentId, 'resolved') // sentinel reason; silent if not pending
    const delay = Math.max(0, req.firesAt - Date.now())
    const timer = setTimeout(() => {
      this.pending.delete(req.incidentId)
      eventBus.emit('notification:escalationFired', {
        timestamp: new Date(),
        incidentId: req.incidentId,
        endpointId: req.endpointId,
        channelId: req.channelId,
      })
      void Promise.resolve(
        this.onFire({
          incidentId: req.incidentId,
          endpointId: req.endpointId,
          channelId: req.channelId,
        }),
      ).catch(() => {
        // Dispatcher records its own failure log; nothing to do here.
      })
    }, delay)
    this.pending.set(req.incidentId, { req, timer })
    eventBus.emit('notification:escalationScheduled', {
      timestamp: new Date(),
      incidentId: req.incidentId,
      endpointId: req.endpointId,
      channelId: req.channelId,
      firesAt: new Date(req.firesAt),
    })
  }

  cancel(
    incidentId: string,
    reason: 'resolved' | 'acknowledged' | 'muted' | 'channel_gone',
  ): void {
    const p = this.pending.get(incidentId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(incidentId)
    eventBus.emit('notification:escalationCancelled', {
      timestamp: new Date(),
      incidentId,
      reason,
    })
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private subscribe(): void {
    this.unsubscribes.push(
      eventBus.subscribe('incident:resolved', ({ incidentId }) => {
        this.cancel(incidentId, 'resolved')
      }, 'standard'),
      eventBus.subscribe('incident:opened', (payload) => {
        void this.maybeScheduleForIncident(payload.incident).catch(() => {
          /* swallow — dispatcher surfaces its own errors */
        })
      }, 'standard'),
    )
  }

  /** Load active incidents and reschedule any that still need escalation. */
  private async recoverActive(): Promise<void> {
    let active: IncidentDoc[] = []
    try {
      active = await this.adapter.listActiveIncidents()
    } catch {
      return
    }
    for (const inc of active) {
      await this.maybeScheduleForIncident(inc)
    }
  }

  private async maybeScheduleForIncident(incident: IncidentDoc): Promise<void> {
    if (incident.status !== 'active') return
    const incidentId = incident._id.toHexString()
    const endpointId = incident.endpointId.toHexString()

    const endpoint = await this.adapter.getEndpointById(endpointId).catch(() => null)
    if (!endpoint) return
    const target = this.resolveTarget(endpoint)
    if (!target) return

    const alreadyDispatched = await this.alreadyEscalated(incidentId)
    if (alreadyDispatched) return

    const firesAt = incident.startedAt.getTime() + target.delaySeconds * 1000
    this.schedule({
      incidentId,
      endpointId,
      channelId: target.channelId,
      firesAt,
    })
  }

  private resolveTarget(endpoint: EndpointDoc): { channelId: string; delaySeconds: number } | null {
    const delaySeconds = endpoint.escalationDelay
    const channel = endpoint.escalationChannelId
    if (!delaySeconds || delaySeconds <= 0) return null
    if (!channel) return null
    const channelId = channel instanceof ObjectId ? channel.toHexString() : String(channel)
    return { channelId, delaySeconds }
  }

  private async alreadyEscalated(incidentId: string): Promise<boolean> {
    const rows = await this.adapter.listNotificationLogForIncident(incidentId).catch(() => [])
    return rows.some(
      (r) => r.kind === 'incident_escalated' && r.deliveryStatus === 'sent',
    )
  }
}
