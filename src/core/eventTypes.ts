import type { EndpointDoc, IncidentDoc } from '../storage/types.js'

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
}
