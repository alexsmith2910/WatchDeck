import type {
  CheckDoc,
  CheckWritePayload,
  DbPage,
  DbPaginationOpts,
  DailySummaryDoc,
  EndpointDoc,
  HourlySummaryDoc,
  IncidentDoc,
  MaintenanceWindow,
  NotificationChannelDoc,
  NotificationLogDoc,
  SettingsDoc,
  SystemEventDoc,
} from './types.js'

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
   * Run idempotent collection and index migrations.
   * Creates missing collections and indexes; never drops or alters existing data.
   * Should be called once after a successful connect().
   */
  abstract migrate(): Promise<void>

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
    '24h': number
    '7d': number
    '30d': number
    '90d': number
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

  abstract listNotificationLog(opts: DbPaginationOpts): Promise<DbPage<NotificationLogDoc>>

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
  // Settings API
  // ---------------------------------------------------------------------------

  abstract getSettings(): Promise<SettingsDoc>

  abstract updateSettings(changes: Record<string, unknown>): Promise<SettingsDoc>
}
