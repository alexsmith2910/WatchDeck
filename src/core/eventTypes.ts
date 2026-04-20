import type {
  EndpointDoc,
  IncidentDoc,
  NotificationKind,
  NotificationSeverity,
  NotificationSuppressedReason,
} from '../storage/types.js'
import type { ProbeResult } from './health/probeTypes.js'

/**
 * Typed event map for the WatchDeck event bus.
 * Every event name maps to its payload shape.
 */
export interface EventMap {
  // -------------------------------------------------------------------------
  // Database lifecycle
  // -------------------------------------------------------------------------
  'db:connected': { timestamp: Date; latencyMs: number }
  'db:disconnected': { timestamp: Date; error: string | Error }
  'db:reconnecting': {
    timestamp: Date
    attempt: number
    maxAttempts: number
    nextRetryInSeconds: number
  }
  'db:reconnected': {
    timestamp: Date
    outageDurationSeconds: number
    bufferedResults: number
  }
  'db:error': { timestamp: Date; error: string | Error; context: string }
  'db:fatal': { timestamp: Date; totalAttempts: number; totalOutageDuration: number }

  // -------------------------------------------------------------------------
  // Check engine
  // -------------------------------------------------------------------------
  'check:complete': {
    timestamp: Date
    endpointId: string
    status: 'healthy' | 'degraded' | 'down'
    responseTime: number
    statusCode: number | null
    errorMessage: string | null
  }

  // -------------------------------------------------------------------------
  // Endpoint CRUD
  // -------------------------------------------------------------------------
  'endpoint:created': { timestamp: Date; endpoint: EndpointDoc }
  'endpoint:updated': { timestamp: Date; endpointId: string; changes: Partial<EndpointDoc> }
  'endpoint:deleted': { timestamp: Date; endpointId: string; name: string }

  // -------------------------------------------------------------------------
  // Incident lifecycle (alerts)
  // -------------------------------------------------------------------------
  'incident:opened': { timestamp: Date; incident: IncidentDoc }
  'incident:resolved': { timestamp: Date; incidentId: string; durationSeconds: number }

  // -------------------------------------------------------------------------
  // System (used by event bus error handling)
  // -------------------------------------------------------------------------
  'system:critical': {
    timestamp: Date
    module: string
    error: string | Error
    suggestedFix: string
  }
  'system:warning': { timestamp: Date; module: string; message: string }

  // -------------------------------------------------------------------------
  // Health / maintenance / replay
  // -------------------------------------------------------------------------
  'health:update': {
    timestamp: Date
    component: string
    status: 'healthy' | 'degraded' | 'down'
  }
  'maintenance:started': {
    timestamp: Date
    endpointId: string
    windowId: string
    reason: string
  }
  'maintenance:ended': { timestamp: Date; endpointId: string; windowId: string }
  'replay:progress': {
    timestamp: Date
    status: 'running' | 'complete' | 'failed'
    batchCurrent: number
    batchTotal: number
    resultsCurrent: number
    resultsTotal: number
    errors: number
    percentComplete: number
  }

  // -------------------------------------------------------------------------
  // Aggregation lifecycle — structured payloads keep the aggregator probe
  // out of the business of string-matching `system:warning` messages.
  // -------------------------------------------------------------------------
  'aggregation:run': {
    timestamp: Date
    kind: 'hourly' | 'daily' | 'cleanup'
    durationMs: number
    rowsIn: number
    rowsOut: number
    ok: boolean
    error?: string
  }

  // -------------------------------------------------------------------------
  // Probe lifecycle (system-plane health). Emitted by ProbeRegistry on every
  // probe completion; transition events fire when a probe changes category
  // between healthy/standby/disabled and degraded/down.
  // -------------------------------------------------------------------------
  'probe:completed': { timestamp: Date; result: ProbeResult }
  'probe:degraded': { timestamp: Date; result: ProbeResult }
  'probe:recovered': { timestamp: Date; result: ProbeResult }

  // -------------------------------------------------------------------------
  // Internal event-bus round-trip probe.
  // -------------------------------------------------------------------------
  'system:heartbeat': { timestamp: Date; token: string }

  // -------------------------------------------------------------------------
  // Notification dispatcher — every dispatch outcome is observable on the bus
  // so the dashboard (via SSE), the health probe, and the event trace can all
  // react to the same stream of truth.
  // -------------------------------------------------------------------------
  'notification:dispatched': {
    timestamp: Date
    logId: string
    channelId: string
    endpointId?: string
    incidentId?: string
    kind: NotificationKind
    severity: NotificationSeverity
    latencyMs: number
  }
  'notification:failed': {
    timestamp: Date
    logId: string
    channelId: string
    endpointId?: string
    incidentId?: string
    kind: NotificationKind
    reason: string
  }
  'notification:suppressed': {
    timestamp: Date
    channelId: string
    endpointId?: string
    incidentId?: string
    suppressedReason: NotificationSuppressedReason
  }

  // Channel CRUD — the registry listens to these to refresh its cache.
  'notification:channelCreated': { timestamp: Date; channelId: string }
  'notification:channelUpdated': { timestamp: Date; channelId: string }
  'notification:channelDeleted': { timestamp: Date; channelId: string }

  // Mute lifecycle
  'notification:muted': {
    timestamp: Date
    scope: 'endpoint' | 'channel' | 'global'
    targetId?: string
    expiresAt: Date
  }
  'notification:unmuted': {
    timestamp: Date
    scope: 'endpoint' | 'channel' | 'global'
    targetId?: string
  }

  // Channel test fired
  'notification:test': {
    timestamp: Date
    channelId: string
    ok: boolean
    reason?: string
  }

  // Escalation scheduler
  'notification:escalationScheduled': {
    timestamp: Date
    incidentId: string
    endpointId: string
    channelId: string
    firesAt: Date
  }
  'notification:escalationCancelled': {
    timestamp: Date
    incidentId: string
    reason: 'resolved' | 'acknowledged' | 'muted' | 'channel_gone'
  }
  'notification:escalationFired': {
    timestamp: Date
    incidentId: string
    endpointId: string
    channelId: string
  }

  // Burst coalescing (see plan §1.5 / finalized decision #5)
  'notification:coalescingOpened': {
    timestamp: Date
    channelId: string
    endpointId?: string
    windowMs: number
  }
  'notification:coalescingFlushed': {
    timestamp: Date
    channelId: string
    endpointId?: string
    count: number
    logId: string
  }
}
