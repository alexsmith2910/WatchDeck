import type { WatchDeckConfig } from '../config/types.js'
import type {
  CheckDoc,
  CheckWritePayload,
  DbPage,
  DbPaginationOpts,
  DailySummaryDoc,
  EndpointDoc,
  HealthStateDoc,
  HourlySummaryDoc,
  IncidentDoc,
  InternalIncidentDoc,
  MaintenanceWindow,
  NotificationChannelDoc,
  NotificationDeliveryStatus,
  NotificationKind,
  NotificationLogDoc,
  NotificationMuteDoc,
  NotificationPreferencesDoc,
  NotificationSeverity,
  SettingsDefaultsOverride,
  SettingsDoc,
  SettingsSloOverride,
  SystemEventDoc,
} from './types.js'

// ---------------------------------------------------------------------------
// Effective-config shapes (config + mx_settings override merge results)
// ---------------------------------------------------------------------------

/**
 * The per-endpoint defaults that new endpoints inherit at creation time, after
 * the runtime override stored in `mx_settings.defaults` is layered on top of
 * `ctx.config.defaults`.
 *
 * The `notifications` sub-tree is deliberately excluded — that gets its own
 * edit surface via `mx_notification_preferences` / the Notifications panel.
 */
export interface EffectiveDefaults {
  checkInterval: number
  timeout: number
  expectedStatusCodes: number[]
  latencyThreshold: number
  sslWarningDays: number
  failureThreshold: number
  alertCooldown: number
  recoveryAlert: boolean
  escalationDelay: number
}

export interface EffectiveSlo {
  target: number
  windowDays: number
}

// ---------------------------------------------------------------------------
// Notification query/stat shapes (used by several adapter methods)
// ---------------------------------------------------------------------------

export interface NotificationLogFilter {
  endpointId?: string
  channelId?: string
  incidentId?: string
  severity?: NotificationSeverity
  kind?: NotificationKind
  status?: NotificationDeliveryStatus
  from?: Date
  to?: Date
  /** Substring match on messageSummary. */
  search?: string
  /** Return rows that are retries of the given log id — oldest first by sentAt. */
  retryOf?: string
}

export interface NotificationStatsWindow {
  from: Date
  to: Date
}

// ---------------------------------------------------------------------------
// Incident stats (aggregation for dashboard trends)
// ---------------------------------------------------------------------------

export interface IncidentStatsFilter {
  from: Date
  to: Date
  endpointId?: string
  /** IANA timezone used to bucket days (e.g. 'America/Los_Angeles'). Falls
   *  back to UTC when absent. Clients that render calendar-day charts must
   *  pass their own zone so bucket boundaries match what the user sees. */
  tz?: string
}

export interface IncidentStatsDay {
  date: string
  total: number
  causes: Record<string, number>
}

export interface IncidentStatsCause {
  cause: string
  count: number
}

export interface IncidentStatsEndpoint {
  endpointId: string
  total: number
  totalDurationSec: number
  lastStartedAt: string
  /** Count over the equally-long window immediately preceding [from, to). */
  prevTotal: number
}

export interface IncidentStatsEndpointDay {
  endpointId: string
  date: string
  count: number
}

export interface IncidentStatsMttrDay {
  date: string
  avgSec: number
  count: number
}

export interface IncidentStats {
  totals: {
    total: number
    active: number
    resolved: number
    /** Sum of `notificationsSent` across all incidents in the window. */
    notificationsSent: number
  }
  /** One entry per calendar day in [from, to], zero-filled. */
  byDay: IncidentStatsDay[]
  byCause: IncidentStatsCause[]
  byEndpoint: IncidentStatsEndpoint[]
  byEndpointDay: IncidentStatsEndpointDay[]
  resolvedDurationsByDay: IncidentStatsMttrDay[]
}

export interface NotificationStats {
  total: number
  sent: number
  failed: number
  suppressed: number
  pending: number
  byChannel: Array<{ channelId: string; sent: number; failed: number; suppressed: number }>
  bySuppressedReason: Record<string, number>
  byKind: Record<NotificationKind, number>
  lastDispatchAt: Date | null
  lastFailureAt: Date | null
}

/**
 * Abstract storage adapter.
 *
 * All application code references StorageAdapter — never MongoDBAdapter
 * or any other concrete implementation directly.  This keeps database
 * dependencies isolated and makes future adapter swaps (Postgres, SQLite)
 * a drop-in replacement.
 *
 * Connection lifecycle methods are defined here.
 * CRUD methods are added as abstract stubs when each step needs them.
 */

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'down'
  latencyMs: number
}

export abstract class StorageAdapter {
  /**
   * Establish the initial database connection.
   * Implementations should retry with the boot strategy (3 attempts, 5s gaps)
   * and throw on total failure so the process can exit cleanly.
   */
  abstract connect(): Promise<void>

  /**
   * Gracefully close all connections.
   * Called during shutdown or before process exit.
   */
  abstract disconnect(): Promise<void>

  /**
   * Ping the database and return connection health + round-trip latency.
   * Safe to call at any time — returns { status: 'down' } if not connected.
   */
  abstract healthCheck(): Promise<HealthCheckResult>

  /**
   * Returns true if the adapter currently has an active connection.
   */
  abstract isConnected(): boolean

  /**
   * If the adapter is currently disconnected, how long in seconds (floor) it
   * has been that way; 0 when connected. Used by the db health probe.
   */
  abstract currentOutageDuration(): number

  /**
   * Current reconnect attempt number if a reconnect loop is in progress, or
   * null when connected / not reconnecting. Used by the db health probe.
   */
  abstract reconnectAttempt(): number | null

  /**
   * Run idempotent collection and index migrations.
   * Creates missing collections and indexes; never drops or alters existing data.
   * Should be called once after a successful connect().
   */
  abstract migrate(): Promise<{ collectionCount: number }>

  // ---------------------------------------------------------------------------
  // Buffer pipeline
  // ---------------------------------------------------------------------------

  /**
   * Persist a single check result.
   * Called by the buffer pipeline during live (DB-connected) operation.
   */
  abstract saveCheck(payload: CheckWritePayload): Promise<void>

  /**
   * Persist multiple check results in one operation.
   * Called during buffer replay (reconnect and startup).
   */
  abstract saveManyChecks(payloads: CheckWritePayload[]): Promise<void>

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  /**
   * Persist a system event record (e.g. a DB outage summary).
   */
  abstract saveSystemEvent(event: Omit<SystemEventDoc, '_id'>): Promise<void>

  /**
   * Retrieve recent system event records, newest first.
   */
  abstract getSystemEvents(limit?: number): Promise<SystemEventDoc[]>

  // ---------------------------------------------------------------------------
  // Check engine
  // ---------------------------------------------------------------------------

  /**
   * Return all endpoints with status 'active' or 'paused'.
   * Used by the scheduler on boot to populate the min-heap.
   */
  abstract listEnabledEndpoints(): Promise<EndpointDoc[]>

  /**
   * Persist an endpoint's runtime state after a check completes.
   * Updates lastCheckAt, lastStatus, check result fields, and updatedAt.
   * Called by the scheduler as a fire-and-forget after each check:complete event.
   */
  abstract updateEndpointAfterCheck(
    endpointId: string,
    status: 'healthy' | 'degraded' | 'down',
    timestamp: Date,
    consecutiveFailures: number,
    responseTime: number,
    statusCode: number | null,
    errorMessage: string | null,
    sslIssuer?: { o?: string; cn?: string } | null,
  ): Promise<void>

  // ---------------------------------------------------------------------------
  // Endpoints API
  // ---------------------------------------------------------------------------

  abstract createEndpoint(
    data: Omit<EndpointDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<EndpointDoc>

  abstract getEndpointById(id: string): Promise<EndpointDoc | null>

  abstract listEndpoints(opts: DbPaginationOpts & {
    status?: 'active' | 'paused' | 'archived'
    type?: 'http' | 'port'
  }): Promise<DbPage<EndpointDoc>>

  abstract updateEndpoint(
    id: string,
    changes: Partial<EndpointDoc>,
  ): Promise<EndpointDoc | null>

  abstract deleteEndpoint(id: string): Promise<boolean>

  abstract getLatestCheck(endpointId: string): Promise<CheckDoc | null>

  // ---------------------------------------------------------------------------
  // Checks API
  // ---------------------------------------------------------------------------

  abstract listChecks(
    endpointId: string,
    opts: DbPaginationOpts & {
      from?: Date
      to?: Date
      status?: 'healthy' | 'degraded' | 'down'
    },
  ): Promise<DbPage<CheckDoc>>

  abstract listHourlySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<HourlySummaryDoc[]>

  abstract listDailySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<DailySummaryDoc[]>

  abstract getUptimeStats(endpointId: string): Promise<{
    '24h': number | null
    '7d': number | null
    '30d': number | null
    '90d': number | null
  }>

  // ---------------------------------------------------------------------------
  // Incidents API
  // ---------------------------------------------------------------------------

  abstract listIncidents(opts: DbPaginationOpts & {
    status?: 'active' | 'resolved'
    endpointId?: string
    from?: Date
    to?: Date
  }): Promise<DbPage<IncidentDoc>>

  abstract getIncidentById(id: string): Promise<IncidentDoc | null>

  abstract listActiveIncidents(): Promise<IncidentDoc[]>

  abstract createIncident(
    data: Omit<IncidentDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IncidentDoc>

  abstract resolveIncident(
    id: string,
    resolvedAt: Date,
    durationSeconds: number,
  ): Promise<IncidentDoc | null>

  abstract addIncidentTimelineEvent(
    incidentId: string,
    event: { at: Date; event: string; detail?: string },
  ): Promise<void>

  abstract setEndpointCurrentIncident(
    endpointId: string,
    incidentId: string | null,
  ): Promise<void>

  /**
   * Aggregate incident counts for the given window, pre-bucketed by day,
   * cause, and endpoint. A single DB roundtrip that powers the incident-page
   * trend charts and KPIs without requiring the client to paginate through
   * individual incident documents.
   */
  abstract getIncidentStats(filter: IncidentStatsFilter): Promise<IncidentStats>

  // ---------------------------------------------------------------------------
  // Notification channels API
  // ---------------------------------------------------------------------------

  abstract listNotificationChannels(): Promise<NotificationChannelDoc[]>

  abstract createNotificationChannel(
    data: Omit<NotificationChannelDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationChannelDoc>

  abstract updateNotificationChannel(
    id: string,
    changes: Partial<NotificationChannelDoc>,
  ): Promise<NotificationChannelDoc | null>

  abstract deleteNotificationChannel(id: string): Promise<boolean>

  abstract getNotificationChannelById(id: string): Promise<NotificationChannelDoc | null>

  // ---------------------------------------------------------------------------
  // Notification log API
  // ---------------------------------------------------------------------------

  /** Cursor-paginated list with server-side filters. */
  abstract listNotificationLog(
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>>

  /** Convenience: paginated log scoped to a single endpoint. */
  abstract listNotificationLogForEndpoint(
    endpointId: string,
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>>

  /** Convenience: paginated log scoped to a single channel. */
  abstract listNotificationLogForChannel(
    channelId: string,
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>>

  /** All dispatches (any status) for a single incident, newest first. */
  abstract listNotificationLogForIncident(incidentId: string): Promise<NotificationLogDoc[]>

  /**
   * Coalesced summary log rows whose `coalescedIncidentIds` array contains
   * the given incident. Used by the dispatcher to find the channels that
   * received this incident's open as part of a folded batch — so it can
   * decide whether to emit a recovery message.
   */
  abstract findCoalescedDeliveriesFor(incidentId: string): Promise<NotificationLogDoc[]>

  abstract getNotificationLogById(id: string): Promise<NotificationLogDoc | null>

  /** Persist a single log row. Returns the inserted doc. */
  abstract writeNotificationLog(
    row: Omit<NotificationLogDoc, '_id' | 'createdAt'>,
  ): Promise<NotificationLogDoc>

  /**
   * Clear the sensitive capture fields (payload / request / response) on log
   * rows older than `before`. Outcome metadata (status, latency, reason) is
   * preserved so the history remains auditable until the TTL deletes the row.
   * Returns the number of rows modified.
   */
  abstract redactOldNotificationLogs(before: Date): Promise<number>

  /** Aggregate stats for the given window — KPI cards and health probe. */
  abstract countNotificationStats(window: NotificationStatsWindow): Promise<NotificationStats>

  // ---------------------------------------------------------------------------
  // Notification mutes API
  // ---------------------------------------------------------------------------

  abstract recordMute(
    data: Omit<NotificationMuteDoc, '_id' | 'mutedAt'>,
  ): Promise<NotificationMuteDoc>

  abstract listActiveMutes(): Promise<NotificationMuteDoc[]>

  abstract getMuteById(id: string): Promise<NotificationMuteDoc | null>

  abstract deleteMute(id: string): Promise<boolean>

  // ---------------------------------------------------------------------------
  // Notification preferences (singleton, _id = "global")
  // ---------------------------------------------------------------------------

  abstract getNotificationPreferences(): Promise<NotificationPreferencesDoc>

  abstract updateNotificationPreferences(
    changes: Partial<Omit<NotificationPreferencesDoc, '_id'>>,
  ): Promise<NotificationPreferencesDoc>

  // ---------------------------------------------------------------------------
  // Maintenance API
  // ---------------------------------------------------------------------------

  /** Add a maintenance window to each of the given endpoints. Returns one window per endpointId. */
  abstract addMaintenanceWindows(
    endpointIds: string[],
    window: Omit<MaintenanceWindow, '_id'>,
  ): Promise<MaintenanceWindow[]>

  /** Remove a maintenance window (by its ObjectId) from whichever endpoint owns it. */
  abstract removeMaintenanceWindow(windowId: string): Promise<boolean>

  /** All active (now between start/end) and scheduled (start > now) windows across all endpoints. */
  abstract listMaintenanceWindows(): Promise<
    Array<{ endpoint: EndpointDoc; window: MaintenanceWindow }>
  >

  // ---------------------------------------------------------------------------
  // Aggregation write API
  // ---------------------------------------------------------------------------

  /**
   * Return raw checks for a given endpoint within an hour bucket.
   * Used by the hourly aggregation worker.
   */
  abstract getChecksInHour(endpointId: string, hourStart: Date, hourEnd: Date): Promise<CheckDoc[]>

  /**
   * Upsert a single hourly summary document (keyed by endpointId + hour).
   * If a summary already exists for that hour it is replaced.
   */
  abstract upsertHourlySummary(
    summary: Omit<HourlySummaryDoc, '_id' | 'createdAt'>,
  ): Promise<void>

  /**
   * Upsert a single daily summary document (keyed by endpointId + date).
   * If a summary already exists for that date it is replaced.
   */
  abstract upsertDailySummary(
    summary: Omit<DailySummaryDoc, '_id' | 'createdAt'>,
  ): Promise<void>

  /**
   * Delete hourly summaries older than the given date.
   * Returns the number of documents removed.
   */
  abstract deleteHourlySummariesBefore(before: Date): Promise<number>

  /**
   * Delete daily summaries older than the given date.
   * Returns the number of documents removed.
   */
  abstract deleteDailySummariesBefore(before: Date): Promise<number>

  /**
   * Return all distinct endpointIds that have checks in the given time range.
   */
  abstract getEndpointIdsWithChecks(from: Date, to: Date): Promise<string[]>

  // ---------------------------------------------------------------------------
  // Settings API
  // ---------------------------------------------------------------------------

  abstract getSettings(): Promise<SettingsDoc>

  abstract updateSettings(changes: Record<string, unknown>): Promise<SettingsDoc>

  /**
   * Wipe every mx_-prefixed collection (deleteMany — keeps indexes intact).
   * Callers are responsible for pausing the scheduler / dispatcher first so
   * no writes race the delete. Returns per-collection counts for UI display.
   */
  abstract hardReset(): Promise<Record<string, number>>

  /**
   * Merge `mx_settings.defaults` over `config.defaults` and return the effective
   * per-endpoint defaults. Undefined override keys fall through to the config
   * value; present keys replace it. Concrete (non-abstract) so every backend
   * shares the same precedence.
   */
  async getEffectiveDefaults(config: WatchDeckConfig): Promise<EffectiveDefaults> {
    const doc = await this.getSettings()
    const override: SettingsDefaultsOverride = doc.defaults ?? {}
    const base = config.defaults
    return {
      checkInterval: override.checkInterval ?? base.checkInterval,
      timeout: override.timeout ?? base.timeout,
      expectedStatusCodes: override.expectedStatusCodes ?? base.expectedStatusCodes,
      latencyThreshold: override.latencyThreshold ?? base.latencyThreshold,
      sslWarningDays: override.sslWarningDays ?? base.sslWarningDays,
      failureThreshold: override.failureThreshold ?? base.failureThreshold,
      alertCooldown: override.alertCooldown ?? base.alertCooldown,
      recoveryAlert: override.recoveryAlert ?? base.recoveryAlert,
      escalationDelay: override.escalationDelay ?? base.escalationDelay,
    }
  }

  /**
   * Merge `mx_settings.slo` over `config.slo` and return the effective SLO.
   */
  async getEffectiveSlo(config: WatchDeckConfig): Promise<EffectiveSlo> {
    const doc = await this.getSettings()
    const override: SettingsSloOverride = doc.slo ?? {}
    return {
      target: override.target ?? config.slo.target,
      windowDays: override.windowDays ?? config.slo.windowDays,
    }
  }

  // ---------------------------------------------------------------------------
  // System Health persistence
  // ---------------------------------------------------------------------------

  /** Persist (or replace) the single health-state snapshot document. */
  abstract saveHealthState(state: Omit<HealthStateDoc, '_id'>): Promise<void>

  /** Load the health-state snapshot, or null if none has been saved yet. */
  abstract loadHealthState(): Promise<HealthStateDoc | null>

  /** Internal-incident history (most recent first, capped to a sane number). */
  abstract listInternalIncidents(): Promise<InternalIncidentDoc[]>

  /** Upsert a single internal-incident document keyed by its synthesized _id. */
  abstract upsertInternalIncident(doc: InternalIncidentDoc): Promise<void>
}
