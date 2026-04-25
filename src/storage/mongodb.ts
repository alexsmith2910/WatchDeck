import { MongoClient, ObjectId, type Db } from 'mongodb'
import { eventBus } from '../core/eventBus.js'
import type { WatchDeckConfig } from '../config/types.js'
import {
  StorageAdapter,
  type HealthCheckResult,
  type IncidentStats,
  type IncidentStatsFilter,
  type NotificationLogFilter,
  type NotificationStats,
  type NotificationStatsWindow,
} from './adapter.js'
import { runMigrations } from './migrations.js'
import type {
  CheckDoc,
  CheckWritePayload,
  DailySummaryDoc,
  DbPage,
  DbPaginationOpts,
  EndpointDoc,
  HealthStateDoc,
  HourlySummaryDoc,
  IncidentDoc,
  IncidentTimelineEvent,
  InternalIncidentDoc,
  NotificationChannelDoc,
  NotificationKind,
  NotificationLogDoc,
  NotificationLogPayload,
  NotificationLogRequest,
  NotificationLogResponse,
  NotificationMuteDoc,
  NotificationPreferencesDoc,
  SettingsDoc,
  SystemEventDoc,
  SystemEventTimelineEntry,
} from './types.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Wire (BSON) doc shapes — mirror the contract types but with ObjectId where
// the contract uses string. Every method in this adapter reads/writes wire
// docs and maps at the boundary so no other file in the codebase ever sees
// an ObjectId.
// ---------------------------------------------------------------------------

interface WireEndpointDoc {
  _id: ObjectId
  name: string
  description?: string
  type: 'http' | 'port'
  url?: string
  method?: EndpointDoc['method']
  headers?: Record<string, string>
  expectedStatusCodes?: number[]
  assertions?: EndpointDoc['assertions']
  host?: string
  port?: number
  checkInterval: number
  timeout: number
  enabled: boolean
  status: 'active' | 'paused' | 'archived'
  latencyThreshold: number
  sslWarningDays: number
  failureThreshold: number
  recoveryThreshold: number
  alertCooldown: number
  recoveryAlert: boolean
  escalationDelay: number
  escalationChannelId?: ObjectId
  notificationChannelIds: ObjectId[]
  pausedNotificationChannelIds?: ObjectId[]
  lastCheckAt?: Date
  lastStatus?: EndpointDoc['lastStatus']
  lastResponseTime?: number
  lastStatusCode?: number | null
  lastErrorMessage?: string | null
  lastSslIssuer?: EndpointDoc['lastSslIssuer']
  currentIncidentId?: ObjectId
  consecutiveFailures: number
  consecutiveHealthy: number
  createdAt: Date
  updatedAt: Date
}

interface WireCheckDoc {
  _id: ObjectId
  endpointId: ObjectId
  timestamp: Date
  responseTime: number
  statusCode?: number
  sslDaysRemaining?: number
  bodyBytes?: number
  bodyBytesTruncated?: boolean
  assertionResult?: CheckDoc['assertionResult']
  portOpen?: boolean
  status: 'healthy' | 'degraded' | 'down'
  statusReason?: string
  errorMessage?: string
  createdAt: Date
}

interface WireHourlySummaryDoc {
  _id: ObjectId
  endpointId: ObjectId
  hour: Date
  totalChecks: number
  successCount: number
  failCount: number
  degradedCount: number
  uptimePercent: number
  avgResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  errorTypes: Record<string, number>
  hadActiveIncident: boolean
  createdAt: Date
}

interface WireDailySummaryDoc {
  _id: ObjectId
  endpointId: ObjectId
  date: Date
  totalChecks: number
  uptimePercent: number
  avgResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  incidentCount: number
  totalDowntimeMinutes: number
  createdAt: Date
}

interface WireIncidentDoc {
  _id: ObjectId
  endpointId: ObjectId
  status: 'active' | 'resolved'
  cause: string
  causeDetail?: string
  startedAt: Date
  resolvedAt?: Date
  durationSeconds?: number
  timeline: IncidentTimelineEvent[]
  notificationsSent: number
  createdAt: Date
  updatedAt: Date
}

interface WireNotificationChannelDoc extends Omit<NotificationChannelDoc, 'id'> {
  _id: ObjectId
}

interface WireNotificationLogDoc {
  _id: ObjectId
  endpointId?: ObjectId
  incidentId?: ObjectId
  channelId: ObjectId
  type: string
  channelType: NotificationLogDoc['channelType']
  channelTarget: string
  messageSummary: string
  severity: NotificationLogDoc['severity']
  kind: NotificationKind
  deliveryStatus: NotificationLogDoc['deliveryStatus']
  failureReason?: string
  suppressedReason?: NotificationLogDoc['suppressedReason']
  latencyMs?: number
  idempotencyKey?: string
  retryOf?: ObjectId
  coalescedIntoLogId?: ObjectId
  coalescedCount?: number
  coalescedIncidentIds?: ObjectId[]
  payload?: NotificationLogPayload
  request?: NotificationLogRequest
  response?: NotificationLogResponse
  sentAt: Date
  createdAt: Date
}

interface WireNotificationMuteDoc {
  _id: ObjectId
  scope: 'endpoint' | 'channel' | 'global'
  targetId?: ObjectId
  mutedBy: string
  mutedAt: Date
  expiresAt: Date
  reason?: string
}

interface WireNotificationPreferencesDoc {
  _id: 'global'
  globalMuteUntil?: Date
  defaultSeverityFilter: NotificationPreferencesDoc['defaultSeverityFilter']
  defaultEventFilters: NotificationPreferencesDoc['defaultEventFilters']
  lastEditedBy?: string
  updatedAt: Date
}

interface WireSettingsDoc {
  _id: 'global'
  defaults?: SettingsDoc['defaults']
  slo?: SettingsDoc['slo']
  [key: string]: unknown
}

interface WireSystemEventDoc {
  _id: ObjectId
  type: 'db_outage'
  startedAt: Date
  resolvedAt?: Date
  durationSeconds?: number
  reconnectAttempts: number
  severity: SystemEventDoc['severity']
  cause: string
  causeDetail?: string
  bufferedToMemory: number
  bufferedToDisk: number
  replayStatus: SystemEventDoc['replayStatus']
  replayedCount: number
  replayErrors: number
  timeline: SystemEventTimelineEntry[]
}

interface WireHealthStateDoc {
  _id: 'snapshot'
  savedAt: Date
  probeHistory: HealthStateDoc['probeHistory']
  heatmap: HealthStateDoc['heatmap']
}

interface WireInternalIncidentDoc {
  _id: string
  subsystem: string
  severity: InternalIncidentDoc['severity']
  status: InternalIncidentDoc['status']
  title: string
  cause: string
  startedAt: Date
  resolvedAt?: Date
  durationSeconds?: number
  commits: number
  timeline: InternalIncidentDoc['timeline']
  expiresAt?: Date
}

// ---------------------------------------------------------------------------
// ID validation + helpers
// ---------------------------------------------------------------------------

/**
 * List every yyyy-MM-dd string between `from` and `to` (inclusive) as seen
 * in the given IANA timezone. DST-resilient: steps at 12h so skipped/doubled
 * days during transitions resolve via the de-duplication Set.
 */
function enumerateDayKeys(from: Date, to: Date, tz: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const toKey = fmt.format(to)
  const step = 12 * 60 * 60 * 1000
  const seen = new Set<string>()
  const keys: string[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += step) {
    const key = fmt.format(new Date(t))
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  if (!seen.has(toKey)) keys.push(toKey)
  return keys.filter((k) => k <= toKey).sort()
}

/**
 * Validate a user-supplied ObjectId hex string.
 * Throws a 400-shaped error when invalid so the Fastify error handler can
 * serialise it as { code: 'INVALID_ID', … } instead of leaking BSONTypeError.
 */
function toObjectId(id: string, field: string): ObjectId {
  if (!ObjectId.isValid(id)) {
    const err = new Error(`Invalid ${field}: must be a 24-character hex ObjectId`) as Error & {
      statusCode?: number
      code?: string
    }
    err.statusCode = 400
    err.code = 'INVALID_ID'
    throw err
  }
  return new ObjectId(id)
}

/**
 * Wire-side id → contract string. Legacy documents may have strings stored in
 * what the current schema types as ObjectId (older route code that skipped
 * the coercion). Handle both shapes so one stale row doesn't crash a read.
 */
function oidStr(oid: ObjectId | string): string {
  if (typeof oid === 'string') return oid
  return oid.toHexString()
}

function oidArrStr(oids: Array<ObjectId | string> | undefined): string[] {
  return oids ? oids.map(oidStr) : []
}

// ---------------------------------------------------------------------------
// Wire → contract mappers (one per doc type)
// ---------------------------------------------------------------------------

function endpointFromWire(w: WireEndpointDoc): EndpointDoc {
  const out: EndpointDoc = {
    id: oidStr(w._id),
    name: w.name,
    type: w.type,
    checkInterval: w.checkInterval,
    timeout: w.timeout,
    enabled: w.enabled,
    status: w.status,
    latencyThreshold: w.latencyThreshold,
    sslWarningDays: w.sslWarningDays,
    failureThreshold: w.failureThreshold,
    recoveryThreshold: w.recoveryThreshold,
    alertCooldown: w.alertCooldown,
    recoveryAlert: w.recoveryAlert,
    escalationDelay: w.escalationDelay,
    notificationChannelIds: oidArrStr(w.notificationChannelIds),
    consecutiveFailures: w.consecutiveFailures,
    consecutiveHealthy: w.consecutiveHealthy,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
  if (w.description !== undefined) out.description = w.description
  if (w.url !== undefined) out.url = w.url
  if (w.method !== undefined) out.method = w.method
  if (w.headers !== undefined) out.headers = w.headers
  if (w.expectedStatusCodes !== undefined) out.expectedStatusCodes = w.expectedStatusCodes
  if (w.assertions !== undefined) out.assertions = w.assertions
  if (w.host !== undefined) out.host = w.host
  if (w.port !== undefined) out.port = w.port
  if (w.escalationChannelId) out.escalationChannelId = oidStr(w.escalationChannelId)
  if (w.pausedNotificationChannelIds) {
    out.pausedNotificationChannelIds = oidArrStr(w.pausedNotificationChannelIds)
  }
  if (w.lastCheckAt !== undefined) out.lastCheckAt = w.lastCheckAt
  if (w.lastStatus !== undefined) out.lastStatus = w.lastStatus
  if (w.lastResponseTime !== undefined) out.lastResponseTime = w.lastResponseTime
  if (w.lastStatusCode !== undefined) out.lastStatusCode = w.lastStatusCode
  if (w.lastErrorMessage !== undefined) out.lastErrorMessage = w.lastErrorMessage
  if (w.lastSslIssuer !== undefined) out.lastSslIssuer = w.lastSslIssuer
  if (w.currentIncidentId) out.currentIncidentId = oidStr(w.currentIncidentId)
  return out
}

/**
 * Build a Mongo `$set` payload from a partial contract-shaped update.
 * Strips immutable fields (`id`, `createdAt`) and converts string ID fields
 * to ObjectIds.
 */
function endpointPatchToWire(changes: Partial<EndpointDoc>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...changes }
  delete out.id
  delete out.createdAt
  if (changes.escalationChannelId !== undefined) {
    out.escalationChannelId = changes.escalationChannelId
      ? toObjectId(changes.escalationChannelId, 'escalationChannelId')
      : undefined
  }
  if (changes.notificationChannelIds !== undefined) {
    out.notificationChannelIds = changes.notificationChannelIds.map((id) =>
      toObjectId(id, 'channelId'),
    )
  }
  if (changes.pausedNotificationChannelIds !== undefined) {
    out.pausedNotificationChannelIds = changes.pausedNotificationChannelIds.map((id) =>
      toObjectId(id, 'channelId'),
    )
  }
  if (changes.currentIncidentId !== undefined) {
    out.currentIncidentId = changes.currentIncidentId
      ? toObjectId(changes.currentIncidentId, 'incidentId')
      : undefined
  }
  return out
}

function checkFromWire(w: WireCheckDoc): CheckDoc {
  const out: CheckDoc = {
    id: oidStr(w._id),
    endpointId: oidStr(w.endpointId),
    timestamp: w.timestamp,
    responseTime: w.responseTime,
    status: w.status,
    createdAt: w.createdAt,
  }
  if (w.statusCode !== undefined) out.statusCode = w.statusCode
  if (w.sslDaysRemaining !== undefined) out.sslDaysRemaining = w.sslDaysRemaining
  if (w.bodyBytes !== undefined) out.bodyBytes = w.bodyBytes
  if (w.bodyBytesTruncated !== undefined) out.bodyBytesTruncated = w.bodyBytesTruncated
  if (w.assertionResult !== undefined) out.assertionResult = w.assertionResult
  if (w.portOpen !== undefined) out.portOpen = w.portOpen
  if (w.statusReason !== undefined) out.statusReason = w.statusReason
  if (w.errorMessage !== undefined) out.errorMessage = w.errorMessage
  return out
}

function hourlySummaryFromWire(w: WireHourlySummaryDoc): HourlySummaryDoc {
  return {
    id: oidStr(w._id),
    endpointId: oidStr(w.endpointId),
    hour: w.hour,
    totalChecks: w.totalChecks,
    successCount: w.successCount,
    failCount: w.failCount,
    degradedCount: w.degradedCount,
    uptimePercent: w.uptimePercent,
    avgResponseTime: w.avgResponseTime,
    minResponseTime: w.minResponseTime,
    maxResponseTime: w.maxResponseTime,
    p95ResponseTime: w.p95ResponseTime,
    p99ResponseTime: w.p99ResponseTime,
    errorTypes: w.errorTypes,
    hadActiveIncident: w.hadActiveIncident,
    createdAt: w.createdAt,
  }
}

function dailySummaryFromWire(w: WireDailySummaryDoc): DailySummaryDoc {
  return {
    id: oidStr(w._id),
    endpointId: oidStr(w.endpointId),
    date: w.date,
    totalChecks: w.totalChecks,
    uptimePercent: w.uptimePercent,
    avgResponseTime: w.avgResponseTime,
    minResponseTime: w.minResponseTime,
    maxResponseTime: w.maxResponseTime,
    p95ResponseTime: w.p95ResponseTime,
    p99ResponseTime: w.p99ResponseTime,
    incidentCount: w.incidentCount,
    totalDowntimeMinutes: w.totalDowntimeMinutes,
    createdAt: w.createdAt,
  }
}

function incidentFromWire(w: WireIncidentDoc): IncidentDoc {
  const out: IncidentDoc = {
    id: oidStr(w._id),
    endpointId: oidStr(w.endpointId),
    status: w.status,
    cause: w.cause,
    startedAt: w.startedAt,
    timeline: w.timeline,
    notificationsSent: w.notificationsSent,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
  if (w.causeDetail !== undefined) out.causeDetail = w.causeDetail
  if (w.resolvedAt !== undefined) out.resolvedAt = w.resolvedAt
  if (w.durationSeconds !== undefined) out.durationSeconds = w.durationSeconds
  return out
}

function notificationChannelFromWire(w: WireNotificationChannelDoc): NotificationChannelDoc {
  const { _id, ...rest } = w
  return { id: oidStr(_id), ...rest }
}

function notificationLogFromWire(w: WireNotificationLogDoc): NotificationLogDoc {
  const out: NotificationLogDoc = {
    id: oidStr(w._id),
    channelId: oidStr(w.channelId),
    type: w.type,
    channelType: w.channelType,
    channelTarget: w.channelTarget,
    messageSummary: w.messageSummary,
    severity: w.severity,
    kind: w.kind,
    deliveryStatus: w.deliveryStatus,
    sentAt: w.sentAt,
    createdAt: w.createdAt,
  }
  if (w.endpointId) out.endpointId = oidStr(w.endpointId)
  if (w.incidentId) out.incidentId = oidStr(w.incidentId)
  if (w.failureReason !== undefined) out.failureReason = w.failureReason
  if (w.suppressedReason !== undefined) out.suppressedReason = w.suppressedReason
  if (w.latencyMs !== undefined) out.latencyMs = w.latencyMs
  if (w.idempotencyKey !== undefined) out.idempotencyKey = w.idempotencyKey
  if (w.retryOf) out.retryOf = oidStr(w.retryOf)
  if (w.coalescedIntoLogId) out.coalescedIntoLogId = oidStr(w.coalescedIntoLogId)
  if (w.coalescedCount !== undefined) out.coalescedCount = w.coalescedCount
  if (w.coalescedIncidentIds) out.coalescedIncidentIds = oidArrStr(w.coalescedIncidentIds)
  if (w.payload !== undefined) out.payload = w.payload
  if (w.request !== undefined) out.request = w.request
  if (w.response !== undefined) out.response = w.response
  return out
}

function notificationMuteFromWire(w: WireNotificationMuteDoc): NotificationMuteDoc {
  const out: NotificationMuteDoc = {
    id: oidStr(w._id),
    scope: w.scope,
    mutedBy: w.mutedBy,
    mutedAt: w.mutedAt,
    expiresAt: w.expiresAt,
  }
  if (w.targetId) out.targetId = oidStr(w.targetId)
  if (w.reason !== undefined) out.reason = w.reason
  return out
}

function notificationPreferencesFromWire(
  w: WireNotificationPreferencesDoc,
): NotificationPreferencesDoc {
  const out: NotificationPreferencesDoc = {
    id: 'global',
    defaultSeverityFilter: w.defaultSeverityFilter,
    defaultEventFilters: w.defaultEventFilters,
    updatedAt: w.updatedAt,
  }
  if (w.globalMuteUntil !== undefined) out.globalMuteUntil = w.globalMuteUntil
  if (w.lastEditedBy !== undefined) out.lastEditedBy = w.lastEditedBy
  return out
}

function settingsFromWire(w: WireSettingsDoc): SettingsDoc {
  const { _id, ...rest } = w
  void _id
  return { id: 'global', ...rest }
}

function systemEventFromWire(w: WireSystemEventDoc): SystemEventDoc {
  const out: SystemEventDoc = {
    id: oidStr(w._id),
    type: w.type,
    startedAt: w.startedAt,
    reconnectAttempts: w.reconnectAttempts,
    severity: w.severity,
    cause: w.cause,
    bufferedToMemory: w.bufferedToMemory,
    bufferedToDisk: w.bufferedToDisk,
    replayStatus: w.replayStatus,
    replayedCount: w.replayedCount,
    replayErrors: w.replayErrors,
    timeline: w.timeline,
  }
  if (w.resolvedAt !== undefined) out.resolvedAt = w.resolvedAt
  if (w.durationSeconds !== undefined) out.durationSeconds = w.durationSeconds
  if (w.causeDetail !== undefined) out.causeDetail = w.causeDetail
  return out
}

function healthStateFromWire(w: WireHealthStateDoc): HealthStateDoc {
  return {
    id: 'snapshot',
    savedAt: w.savedAt,
    probeHistory: w.probeHistory,
    heatmap: w.heatmap,
  }
}

function internalIncidentFromWire(w: WireInternalIncidentDoc): InternalIncidentDoc {
  const out: InternalIncidentDoc = {
    id: w._id,
    subsystem: w.subsystem,
    severity: w.severity,
    status: w.status,
    title: w.title,
    cause: w.cause,
    startedAt: w.startedAt,
    commits: w.commits,
    timeline: w.timeline,
  }
  if (w.resolvedAt !== undefined) out.resolvedAt = w.resolvedAt
  if (w.durationSeconds !== undefined) out.durationSeconds = w.durationSeconds
  if (w.expiresAt !== undefined) out.expiresAt = w.expiresAt
  return out
}

// ---------------------------------------------------------------------------
// Write builders
// ---------------------------------------------------------------------------

function buildCheckDoc(payload: CheckWritePayload): WireCheckDoc {
  const doc: WireCheckDoc = {
    _id: new ObjectId(),
    endpointId: toObjectId(payload.endpointId, 'endpointId'),
    timestamp: payload.timestamp instanceof Date ? payload.timestamp : new Date(payload.timestamp),
    responseTime: payload.responseTime,
    status: payload.status,
    createdAt: new Date(),
  }
  if (payload.statusCode !== null) doc.statusCode = payload.statusCode
  if (payload.errorMessage !== null) doc.errorMessage = payload.errorMessage
  if (payload.sslDaysRemaining !== null) doc.sslDaysRemaining = payload.sslDaysRemaining
  if (payload.bodyBytes != null) doc.bodyBytes = payload.bodyBytes
  if (payload.bodyBytesTruncated) doc.bodyBytesTruncated = true
  if (payload.assertionResult) doc.assertionResult = payload.assertionResult
  return doc
}

/**
 * MongoDB implementation of StorageAdapter.
 *
 * Boot strategy  : 3 connection attempts with 5-second gaps. Throws on total failure.
 * Runtime reconnect: exponential backoff starting at 30s, doubling up to a 5-minute cap.
 *                    Controlled by config.rateLimits.dbReconnectAttempts (0 = unlimited).
 *
 * Events emitted (via eventBus):
 *   db:connected, db:disconnected, db:reconnecting, db:reconnected, db:error, db:fatal
 */
export class MongoDBAdapter extends StorageAdapter {
  private client: MongoClient | null = null
  private db: Db | null = null
  private _connected = false
  /** Set before an intentional close to prevent the topology handler from starting a reconnect loop. */
  private _intentionalDisconnect = false
  private disconnectedAt: number | null = null
  private reconnectAttemptCount: number | null = null

  constructor(
    private readonly uri: string,
    private readonly dbPrefix: string,
    private readonly config: WatchDeckConfig,
  ) {
    super()
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  isConnected(): boolean {
    return this._connected
  }

  currentOutageDuration(): number {
    if (this._connected || this.disconnectedAt === null) return 0
    return Math.max(0, Math.floor((Date.now() - this.disconnectedAt) / 1000))
  }

  reconnectAttempt(): number | null {
    return this.reconnectAttemptCount
  }

  async connect(): Promise<void> {
    const BOOT_ATTEMPTS = 3
    const BOOT_GAP_MS = 5_000
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
      try {
        await this.openConnection()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: lastError,
          context: `boot attempt ${attempt}/${BOOT_ATTEMPTS}`,
        })
        if (attempt < BOOT_ATTEMPTS) {
          await sleep(BOOT_GAP_MS)
        }
      }
    }

    throw lastError ?? new Error('MongoDB connection failed after 3 attempts')
  }

  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true
    this._connected = false
    await this.closeClient()
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.db || !this._connected) {
      return { status: 'down', latencyMs: 0 }
    }
    try {
      const start = Date.now()
      await this.db.command({ ping: 1 })
      const latencyMs = Date.now() - start
      return {
        status: latencyMs > 2_000 ? 'degraded' : 'healthy',
        latencyMs,
      }
    } catch {
      return { status: 'down', latencyMs: 0 }
    }
  }

  async migrate(): Promise<{ collectionCount: number }> {
    if (!this.db) throw new Error('Cannot run migrations: not connected to MongoDB')
    return runMigrations(
      this.db,
      this.dbPrefix,
      this.config.retention.detailedDays,
      this.config.retention.notificationLogDays,
    )
  }

  // ---------------------------------------------------------------------------
  // Internal connection logic
  // ---------------------------------------------------------------------------

  private async openConnection(): Promise<void> {
    const start = Date.now()

    const client = new MongoClient(this.uri, {
      maxPoolSize: this.config.rateLimits.dbPoolSize,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    })

    await client.connect()

    const db = client.db()
    await db.command({ ping: 1 })
    const latencyMs = Date.now() - start

    await this.closeClient()

    this.client = client
    this.db = db
    this._connected = true
    this.disconnectedAt = null
    this.reconnectAttemptCount = null

    this.registerTopologyHandler(client)

    eventBus.emit('db:connected', { timestamp: new Date(), latencyMs })
  }

  private registerTopologyHandler(client: MongoClient): void {
    client.once('topologyClosed', () => {
      if (this._intentionalDisconnect || !this._connected) return

      this._connected = false
      this.disconnectedAt = Date.now()

      eventBus.emit('db:disconnected', {
        timestamp: new Date(),
        error: 'MongoDB topology closed unexpectedly',
      })

      void this.reconnectLoop()
    })
  }

  private async reconnectLoop(): Promise<void> {
    const { dbReconnectAttempts } = this.config.rateLimits
    const unlimited = dbReconnectAttempts === 0
    const outageStart = this.disconnectedAt ?? Date.now()

    let attempt = 0
    let delay = 30_000
    const MAX_DELAY = 300_000

    while (!this._intentionalDisconnect && (unlimited || attempt < dbReconnectAttempts)) {
      attempt++
      this.reconnectAttemptCount = attempt

      eventBus.emit('db:reconnecting', {
        timestamp: new Date(),
        attempt,
        maxAttempts: dbReconnectAttempts,
        nextRetryInSeconds: delay / 1000,
      })

      await sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY)

      if (this._intentionalDisconnect) break

      try {
        await this.openConnection()
        const outageDurationSeconds = Math.round((Date.now() - outageStart) / 1000)
        eventBus.emit('db:reconnected', {
          timestamp: new Date(),
          outageDurationSeconds,
          bufferedResults: 0,
        })
        return
      } catch (err) {
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: err instanceof Error ? err : new Error(String(err)),
          context: `reconnect attempt ${attempt}`,
        })
      }
    }

    if (!this._intentionalDisconnect) {
      const outageDurationSeconds = Math.round((Date.now() - outageStart) / 1000)
      eventBus.emit('db:fatal', {
        timestamp: new Date(),
        totalAttempts: attempt,
        totalOutageDuration: outageDurationSeconds,
      })
    }
    this.reconnectAttemptCount = null
  }

  private async closeClient(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners()
      try {
        await this.client.close()
      } catch {
        // Ignore errors during close — the client may already be broken.
      }
      this.client = null
      this.db = null
    }
  }

  // ---------------------------------------------------------------------------
  // Buffer pipeline
  // ---------------------------------------------------------------------------

  async saveCheck(payload: CheckWritePayload): Promise<void> {
    const db = this.getDb()
    const doc = buildCheckDoc(payload)
    await db.collection<WireCheckDoc>(`${this.dbPrefix}checks`).insertOne(doc)
  }

  async saveManyChecks(payloads: CheckWritePayload[]): Promise<void> {
    if (payloads.length === 0) return
    const db = this.getDb()
    const docs = payloads.map(buildCheckDoc)
    await db.collection<WireCheckDoc>(`${this.dbPrefix}checks`).insertMany(docs)
  }

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  async saveSystemEvent(event: Omit<SystemEventDoc, 'id'>): Promise<void> {
    const db = this.getDb()
    await db
      .collection<WireSystemEventDoc>(`${this.dbPrefix}system_events`)
      .insertOne({ _id: new ObjectId(), ...event })
  }

  async getSystemEvents(limit = 50): Promise<SystemEventDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireSystemEventDoc>(`${this.dbPrefix}system_events`)
      .find()
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray()
    return wires.map(systemEventFromWire)
  }

  // ---------------------------------------------------------------------------
  // Check engine
  // ---------------------------------------------------------------------------

  async listEnabledEndpoints(): Promise<EndpointDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`)
      .find({ status: { $in: ['active', 'paused'] } })
      .toArray()
    return wires.map(endpointFromWire)
  }

  async updateEndpointAfterCheck(
    endpointId: string,
    status: 'healthy' | 'degraded' | 'down',
    timestamp: Date,
    consecutiveFailures: number,
    consecutiveHealthy: number,
    responseTime: number,
    statusCode: number | null,
    errorMessage: string | null,
    sslIssuer?: { o?: string; cn?: string } | null,
  ): Promise<void> {
    const db = this.getDb()
    const $set: Record<string, unknown> = {
      lastCheckAt: timestamp,
      lastStatus: status,
      lastResponseTime: responseTime,
      lastStatusCode: statusCode,
      lastErrorMessage: errorMessage,
      consecutiveFailures,
      consecutiveHealthy,
      updatedAt: new Date(),
    }
    if (sslIssuer && (sslIssuer.o || sslIssuer.cn)) {
      $set.lastSslIssuer = { ...sslIssuer, capturedAt: timestamp }
    }
    await db.collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`).updateOne(
      { _id: toObjectId(endpointId, 'endpointId') },
      { $set },
    )
  }

  // ---------------------------------------------------------------------------
  // Endpoints API
  // ---------------------------------------------------------------------------

  async createEndpoint(
    data: Omit<EndpointDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<EndpointDoc> {
    const db = this.getDb()
    const now = new Date()
    const wire: WireEndpointDoc = {
      _id: new ObjectId(),
      name: data.name,
      type: data.type,
      checkInterval: data.checkInterval,
      timeout: data.timeout,
      enabled: data.enabled,
      status: data.status,
      latencyThreshold: data.latencyThreshold,
      sslWarningDays: data.sslWarningDays,
      failureThreshold: data.failureThreshold,
      recoveryThreshold: data.recoveryThreshold,
      alertCooldown: data.alertCooldown,
      recoveryAlert: data.recoveryAlert,
      escalationDelay: data.escalationDelay,
      notificationChannelIds: data.notificationChannelIds.map((id) =>
        toObjectId(id, 'channelId'),
      ),
      consecutiveFailures: data.consecutiveFailures,
      consecutiveHealthy: data.consecutiveHealthy,
      createdAt: now,
      updatedAt: now,
    }
    if (data.description !== undefined) wire.description = data.description
    if (data.url !== undefined) wire.url = data.url
    if (data.method !== undefined) wire.method = data.method
    if (data.headers !== undefined) wire.headers = data.headers
    if (data.expectedStatusCodes !== undefined) wire.expectedStatusCodes = data.expectedStatusCodes
    if (data.assertions !== undefined) wire.assertions = data.assertions
    if (data.host !== undefined) wire.host = data.host
    if (data.port !== undefined) wire.port = data.port
    if (data.escalationChannelId) {
      wire.escalationChannelId = toObjectId(data.escalationChannelId, 'escalationChannelId')
    }
    if (data.pausedNotificationChannelIds) {
      wire.pausedNotificationChannelIds = data.pausedNotificationChannelIds.map((id) =>
        toObjectId(id, 'channelId'),
      )
    }
    if (data.lastCheckAt !== undefined) wire.lastCheckAt = data.lastCheckAt
    if (data.lastStatus !== undefined) wire.lastStatus = data.lastStatus
    if (data.lastResponseTime !== undefined) wire.lastResponseTime = data.lastResponseTime
    if (data.lastStatusCode !== undefined) wire.lastStatusCode = data.lastStatusCode
    if (data.lastErrorMessage !== undefined) wire.lastErrorMessage = data.lastErrorMessage
    if (data.lastSslIssuer !== undefined) wire.lastSslIssuer = data.lastSslIssuer
    if (data.currentIncidentId) {
      wire.currentIncidentId = toObjectId(data.currentIncidentId, 'incidentId')
    }
    await db.collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`).insertOne(wire)
    return endpointFromWire(wire)
  }

  async getEndpointById(id: string): Promise<EndpointDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(id)) return null
    const wire = await this.db
      .collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`)
      .findOne({ _id: new ObjectId(id) })
    return wire ? endpointFromWire(wire) : null
  }

  async listEndpoints(
    opts: DbPaginationOpts & { status?: 'active' | 'paused' | 'archived'; type?: 'http' | 'port' },
  ): Promise<DbPage<EndpointDoc>> {
    const filter: Record<string, unknown> = {}
    if (opts.status) {
      filter.status = opts.status
    } else {
      filter.status = { $in: ['active', 'paused'] }
    }
    if (opts.type) filter.type = opts.type
    const page = await this.paginate<WireEndpointDoc>('endpoints', filter, opts, { _id: 1 })
    return {
      ...page,
      items: page.items.map(endpointFromWire),
    }
  }

  async updateEndpoint(
    id: string,
    changes: Partial<EndpointDoc>,
  ): Promise<EndpointDoc | null> {
    const db = this.getDb()
    const patch = endpointPatchToWire(changes)
    const result = await db
      .collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`)
      .findOneAndUpdate(
        { _id: toObjectId(id, 'endpointId') },
        { $set: { ...patch, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
    return result ? endpointFromWire(result) : null
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const db = this.getDb()
    const r = await db
      .collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`)
      .deleteOne({ _id: toObjectId(id, 'endpointId') })
    return r.deletedCount > 0
  }

  async getLatestCheck(endpointId: string): Promise<CheckDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(endpointId)) return null
    const wire = await this.db
      .collection<WireCheckDoc>(`${this.dbPrefix}checks`)
      .findOne(
        { endpointId: new ObjectId(endpointId) },
        { sort: { timestamp: -1 } },
      )
    return wire ? checkFromWire(wire) : null
  }

  // ---------------------------------------------------------------------------
  // Checks API
  // ---------------------------------------------------------------------------

  async listChecks(
    endpointId: string,
    opts: DbPaginationOpts & { from?: Date; to?: Date; status?: 'healthy' | 'degraded' | 'down' },
  ): Promise<DbPage<CheckDoc>> {
    const filter: Record<string, unknown> = { endpointId: toObjectId(endpointId, 'endpointId') }
    if (opts.from || opts.to) {
      const ts: Record<string, Date> = {}
      if (opts.from) ts.$gte = opts.from
      if (opts.to) ts.$lte = opts.to
      filter.timestamp = ts
    }
    if (opts.status) filter.status = opts.status
    const page = await this.paginate<WireCheckDoc>('checks', filter, opts, { _id: -1 })
    return { ...page, items: page.items.map(checkFromWire) }
  }

  async listHourlySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<HourlySummaryDoc[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 48, 1000)
    const wires = await this.db
      .collection<WireHourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .find({ endpointId: toObjectId(endpointId, 'endpointId') })
      .sort({ hour: -1 })
      .limit(limit)
      .toArray()
    return wires.map(hourlySummaryFromWire)
  }

  async listDailySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<DailySummaryDoc[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 90, 365)
    const wires = await this.db
      .collection<WireDailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .find({ endpointId: toObjectId(endpointId, 'endpointId') })
      .sort({ date: -1 })
      .limit(limit)
      .toArray()
    return wires.map(dailySummaryFromWire)
  }

  async getUptimeStats(
    endpointId: string,
  ): Promise<{ '24h': number | null; '7d': number | null; '30d': number | null; '90d': number | null }> {
    if (!this.db) return { '24h': null, '7d': null, '30d': null, '90d': null }

    const oid = toObjectId(endpointId, 'endpointId')
    const now = new Date()
    const coll = this.db.collection<WireCheckDoc>(`${this.dbPrefix}checks`)

    const oldest = await coll
      .findOne({ endpointId: oid }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } })
    if (!oldest) return { '24h': null, '7d': null, '30d': null, '90d': null }

    const dataAgeMs = now.getTime() - oldest.timestamp.getTime()

    const calcUptime = async (sinceMs: number): Promise<number | null> => {
      if (dataAgeMs < sinceMs * 0.5) return null
      const since = new Date(now.getTime() - sinceMs)
      const [total, healthy] = await Promise.all([
        coll.countDocuments({ endpointId: oid, timestamp: { $gte: since } }),
        coll.countDocuments({ endpointId: oid, timestamp: { $gte: since }, status: 'healthy' }),
      ])
      if (total === 0) return null
      return Math.round((healthy / total) * 10000) / 100
    }

    const [h24, d7, d30, d90] = await Promise.all([
      calcUptime(86_400_000),
      calcUptime(7 * 86_400_000),
      calcUptime(30 * 86_400_000),
      calcUptime(90 * 86_400_000),
    ])
    return { '24h': h24, '7d': d7, '30d': d30, '90d': d90 }
  }

  // ---------------------------------------------------------------------------
  // Incidents API
  // ---------------------------------------------------------------------------

  async listIncidents(
    opts: DbPaginationOpts & {
      status?: 'active' | 'resolved'
      endpointId?: string
      from?: Date
      to?: Date
    },
  ): Promise<DbPage<IncidentDoc>> {
    const filter: Record<string, unknown> = {}
    if (opts.status) filter.status = opts.status
    if (opts.endpointId) filter.endpointId = toObjectId(opts.endpointId, 'endpointId')
    if (opts.from || opts.to) {
      const ts: Record<string, Date> = {}
      if (opts.from) ts.$gte = opts.from
      if (opts.to) ts.$lte = opts.to
      filter.startedAt = ts
    }
    const page = await this.paginate<WireIncidentDoc>('incidents', filter, opts, { _id: -1 })
    return { ...page, items: page.items.map(incidentFromWire) }
  }

  async getIncidentById(id: string): Promise<IncidentDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(id)) return null
    const wire = await this.db
      .collection<WireIncidentDoc>(`${this.dbPrefix}incidents`)
      .findOne({ _id: new ObjectId(id) })
    return wire ? incidentFromWire(wire) : null
  }

  async listActiveIncidents(): Promise<IncidentDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireIncidentDoc>(`${this.dbPrefix}incidents`)
      .find({ status: 'active' })
      .sort({ startedAt: -1 })
      .toArray()
    return wires.map(incidentFromWire)
  }

  async createIncident(
    data: Omit<IncidentDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IncidentDoc> {
    const db = this.getDb()
    const now = new Date()
    const wire: WireIncidentDoc = {
      _id: new ObjectId(),
      endpointId: toObjectId(data.endpointId, 'endpointId'),
      status: data.status,
      cause: data.cause,
      startedAt: data.startedAt,
      timeline: data.timeline,
      notificationsSent: data.notificationsSent,
      createdAt: now,
      updatedAt: now,
    }
    if (data.causeDetail !== undefined) wire.causeDetail = data.causeDetail
    if (data.resolvedAt !== undefined) wire.resolvedAt = data.resolvedAt
    if (data.durationSeconds !== undefined) wire.durationSeconds = data.durationSeconds
    await db.collection<WireIncidentDoc>(`${this.dbPrefix}incidents`).insertOne(wire)
    return incidentFromWire(wire)
  }

  async resolveIncident(
    id: string,
    resolvedAt: Date,
    durationSeconds: number,
  ): Promise<IncidentDoc | null> {
    const db = this.getDb()
    const result = await db
      .collection<WireIncidentDoc>(`${this.dbPrefix}incidents`)
      .findOneAndUpdate(
        { _id: toObjectId(id, 'incidentId'), status: 'active' },
        {
          $set: {
            status: 'resolved',
            resolvedAt,
            durationSeconds,
            updatedAt: new Date(),
          },
          $push: {
            timeline: { at: resolvedAt, event: 'resolved', detail: `Resolved after ${durationSeconds}s` },
          },
        },
        { returnDocument: 'after' },
      )
    return result ? incidentFromWire(result) : null
  }

  async addIncidentTimelineEvent(
    incidentId: string,
    event: { at: Date; event: string; detail?: string },
  ): Promise<void> {
    const db = this.getDb()
    await db.collection<WireIncidentDoc>(`${this.dbPrefix}incidents`).updateOne(
      { _id: toObjectId(incidentId, 'incidentId') },
      { $push: { timeline: event }, $set: { updatedAt: new Date() } },
    )
  }

  async setEndpointCurrentIncident(
    endpointId: string,
    incidentId: string | null,
  ): Promise<void> {
    const db = this.getDb()
    const filter = { _id: toObjectId(endpointId, 'endpointId') }
    const coll = db.collection<WireEndpointDoc>(`${this.dbPrefix}endpoints`)
    if (incidentId === null) {
      await coll.updateOne(filter, {
        $unset: { currentIncidentId: 1 },
        $set: { updatedAt: new Date() },
      })
      return
    }
    await coll.updateOne(filter, {
      $set: {
        currentIncidentId: toObjectId(incidentId, 'incidentId'),
        updatedAt: new Date(),
      },
    })
  }

  async getIncidentStats(filter: IncidentStatsFilter): Promise<IncidentStats> {
    const db = this.getDb()
    const coll = db.collection<WireIncidentDoc>(`${this.dbPrefix}incidents`)

    const tz = filter.tz ?? 'UTC'
    const windowMs = filter.to.getTime() - filter.from.getTime()
    const prevFrom = new Date(filter.from.getTime() - windowMs)

    const match: Record<string, unknown> = {
      startedAt: { $gte: filter.from, $lte: filter.to },
    }
    if (filter.endpointId) {
      match.endpointId = toObjectId(filter.endpointId, 'endpointId')
    }

    const dayFormat = { $dateToString: { date: '$startedAt', format: '%Y-%m-%d', timezone: tz } }

    const [raw] = await coll
      .aggregate<{
        totals: Array<{
          total: number
          active: number
          resolved: number
          notificationsSent: number
        }>
        byDayCause: Array<{ _id: { date: string; cause: string }; count: number }>
        byCause: Array<{ _id: string; count: number }>
        byEndpoint: Array<{
          _id: ObjectId
          total: number
          totalDurationSec: number
          lastStartedAt: Date
        }>
        byEndpointDay: Array<{ _id: { endpointId: ObjectId; date: string }; count: number }>
        resolvedDurationsByDay: Array<{ _id: string; avgSec: number; count: number }>
      }>([
        { $match: match },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                  resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
                  notificationsSent: { $sum: { $ifNull: ['$notificationsSent', 0] } },
                },
              },
              {
                $project: {
                  _id: 0,
                  total: 1,
                  active: 1,
                  resolved: 1,
                  notificationsSent: 1,
                },
              },
            ],
            byDayCause: [
              {
                $group: {
                  _id: { date: dayFormat, cause: '$cause' },
                  count: { $sum: 1 },
                },
              },
            ],
            byCause: [
              { $group: { _id: '$cause', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byEndpoint: [
              {
                $group: {
                  _id: '$endpointId',
                  total: { $sum: 1 },
                  totalDurationSec: { $sum: { $ifNull: ['$durationSeconds', 0] } },
                  lastStartedAt: { $max: '$startedAt' },
                },
              },
            ],
            byEndpointDay: [
              {
                $group: {
                  _id: { endpointId: '$endpointId', date: dayFormat },
                  count: { $sum: 1 },
                },
              },
            ],
            resolvedDurationsByDay: [
              { $match: { status: 'resolved', durationSeconds: { $gt: 0 } } },
              {
                $group: {
                  _id: dayFormat,
                  avgSec: { $avg: '$durationSeconds' },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .toArray()

    const prevAgg = await coll
      .aggregate<{ _id: ObjectId; count: number }>([
        {
          $match: {
            startedAt: { $gte: prevFrom, $lt: filter.from },
            ...(filter.endpointId
              ? { endpointId: toObjectId(filter.endpointId, 'endpointId') }
              : {}),
          },
        },
        { $group: { _id: '$endpointId', count: { $sum: 1 } } },
      ])
      .toArray()
    const prevByEndpoint = new Map<string, number>()
    for (const r of prevAgg) prevByEndpoint.set(r._id.toHexString(), r.count)

    const totals = raw?.totals[0] ?? {
      total: 0,
      active: 0,
      resolved: 0,
      notificationsSent: 0,
    }

    const dates = enumerateDayKeys(filter.from, filter.to, tz)
    const byDayMap = new Map<string, { date: string; total: number; causes: Record<string, number> }>()
    for (const d of dates) byDayMap.set(d, { date: d, total: 0, causes: {} })
    for (const row of raw?.byDayCause ?? []) {
      const bucket = byDayMap.get(row._id.date)
      if (!bucket) continue
      bucket.causes[row._id.cause] = (bucket.causes[row._id.cause] ?? 0) + row.count
      bucket.total += row.count
    }
    const byDay = dates.map((d) => byDayMap.get(d)!)

    const byCause = (raw?.byCause ?? []).map((r) => ({ cause: r._id, count: r.count }))

    const byEndpoint = (raw?.byEndpoint ?? [])
      .map((r) => ({
        endpointId: r._id.toHexString(),
        total: r.total,
        totalDurationSec: r.totalDurationSec,
        lastStartedAt: r.lastStartedAt.toISOString(),
        prevTotal: prevByEndpoint.get(r._id.toHexString()) ?? 0,
      }))
      .sort((a, b) => b.total - a.total)

    const byEndpointDay = (raw?.byEndpointDay ?? []).map((r) => ({
      endpointId: r._id.endpointId.toHexString(),
      date: r._id.date,
      count: r.count,
    }))

    const mttrMap = new Map<string, { avgSec: number; count: number }>()
    for (const row of raw?.resolvedDurationsByDay ?? []) {
      mttrMap.set(row._id, { avgSec: Math.round(row.avgSec), count: row.count })
    }
    const resolvedDurationsByDay = dates.map((d) => {
      const hit = mttrMap.get(d)
      return { date: d, avgSec: hit?.avgSec ?? 0, count: hit?.count ?? 0 }
    })

    return {
      totals,
      byDay,
      byCause,
      byEndpoint,
      byEndpointDay,
      resolvedDurationsByDay,
    }
  }

  // ---------------------------------------------------------------------------
  // Notification channels API
  // ---------------------------------------------------------------------------

  async listNotificationChannels(): Promise<NotificationChannelDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireNotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .find()
      .sort({ createdAt: 1 })
      .toArray()
    return wires.map(notificationChannelFromWire)
  }

  async createNotificationChannel(
    data: Omit<NotificationChannelDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationChannelDoc> {
    const db = this.getDb()
    const now = new Date()
    const wire: WireNotificationChannelDoc = {
      _id: new ObjectId(),
      ...data,
      createdAt: now,
      updatedAt: now,
    }
    await db
      .collection<WireNotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .insertOne(wire)
    return notificationChannelFromWire(wire)
  }

  async updateNotificationChannel(
    id: string,
    changes: Partial<NotificationChannelDoc>,
  ): Promise<NotificationChannelDoc | null> {
    const db = this.getDb()
    const safe: Record<string, unknown> = { ...changes }
    delete safe.id
    delete safe.createdAt
    const result = await db
      .collection<WireNotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .findOneAndUpdate(
        { _id: toObjectId(id, 'channelId') },
        { $set: { ...safe, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
    return result ? notificationChannelFromWire(result) : null
  }

  async deleteNotificationChannel(id: string): Promise<boolean> {
    const db = this.getDb()
    const r = await db
      .collection<WireNotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .deleteOne({ _id: toObjectId(id, 'channelId') })
    return r.deletedCount > 0
  }

  async getNotificationChannelById(id: string): Promise<NotificationChannelDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(id)) return null
    const wire = await this.db
      .collection<WireNotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .findOne({ _id: new ObjectId(id) })
    return wire ? notificationChannelFromWire(wire) : null
  }

  // ---------------------------------------------------------------------------
  // Notification log API
  // ---------------------------------------------------------------------------

  async listNotificationLog(
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>> {
    const filter = this.buildNotificationLogFilter(opts)
    const page = await this.paginate<WireNotificationLogDoc>(
      'notification_log',
      filter,
      opts,
      { _id: -1 },
    )
    return { ...page, items: page.items.map(notificationLogFromWire) }
  }

  async listNotificationLogForEndpoint(
    endpointId: string,
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>> {
    return this.listNotificationLog({ ...opts, endpointId })
  }

  async listNotificationLogForChannel(
    channelId: string,
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>> {
    return this.listNotificationLog({ ...opts, channelId })
  }

  async listNotificationLogForIncident(incidentId: string): Promise<NotificationLogDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
      .find({ incidentId: toObjectId(incidentId, 'incidentId') })
      .sort({ sentAt: -1 })
      .limit(500)
      .toArray()
    return wires.map(notificationLogFromWire)
  }

  async findCoalescedDeliveriesFor(incidentId: string): Promise<NotificationLogDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
      .find({ coalescedIncidentIds: toObjectId(incidentId, 'incidentId') })
      .sort({ sentAt: -1 })
      .limit(100)
      .toArray()
    return wires.map(notificationLogFromWire)
  }

  async getNotificationLogById(id: string): Promise<NotificationLogDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(id)) return null
    const wire = await this.db
      .collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
      .findOne({ _id: new ObjectId(id) })
    return wire ? notificationLogFromWire(wire) : null
  }

  async writeNotificationLog(
    row: Omit<NotificationLogDoc, 'id' | 'createdAt'>,
  ): Promise<NotificationLogDoc> {
    const db = this.getDb()
    const wire: WireNotificationLogDoc = {
      _id: new ObjectId(),
      channelId: toObjectId(row.channelId, 'channelId'),
      type: row.type,
      channelType: row.channelType,
      channelTarget: row.channelTarget,
      messageSummary: row.messageSummary,
      severity: row.severity,
      kind: row.kind,
      deliveryStatus: row.deliveryStatus,
      sentAt: row.sentAt,
      createdAt: new Date(),
    }
    if (row.endpointId) wire.endpointId = toObjectId(row.endpointId, 'endpointId')
    if (row.incidentId) wire.incidentId = toObjectId(row.incidentId, 'incidentId')
    if (row.failureReason !== undefined) wire.failureReason = row.failureReason
    if (row.suppressedReason !== undefined) wire.suppressedReason = row.suppressedReason
    if (row.latencyMs !== undefined) wire.latencyMs = row.latencyMs
    if (row.idempotencyKey !== undefined) wire.idempotencyKey = row.idempotencyKey
    if (row.retryOf) wire.retryOf = toObjectId(row.retryOf, 'retryOf')
    if (row.coalescedIntoLogId) {
      wire.coalescedIntoLogId = toObjectId(row.coalescedIntoLogId, 'coalescedIntoLogId')
    }
    if (row.coalescedCount !== undefined) wire.coalescedCount = row.coalescedCount
    if (row.coalescedIncidentIds) {
      wire.coalescedIncidentIds = row.coalescedIncidentIds.map((id) =>
        toObjectId(id, 'incidentId'),
      )
    }
    if (row.payload !== undefined) wire.payload = row.payload
    if (row.request !== undefined) wire.request = row.request
    if (row.response !== undefined) wire.response = row.response
    await db
      .collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
      .insertOne(wire)
    return notificationLogFromWire(wire)
  }

  async redactOldNotificationLogs(before: Date): Promise<number> {
    const db = this.getDb()
    const result = await db
      .collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
      .updateMany(
        {
          sentAt: { $lt: before },
          $or: [
            { payload: { $exists: true } },
            { request: { $exists: true } },
            { response: { $exists: true } },
          ],
        },
        { $unset: { payload: 1, request: 1, response: 1 } },
      )
    return result.modifiedCount
  }

  async countNotificationStats(window: NotificationStatsWindow): Promise<NotificationStats> {
    const empty: NotificationStats = {
      total: 0,
      sent: 0,
      failed: 0,
      suppressed: 0,
      pending: 0,
      byChannel: [],
      bySuppressedReason: {},
      byKind: {
        incident_opened: 0,
        incident_resolved: 0,
        incident_escalated: 0,
        channel_test: 0,
        custom: 0,
      },
      lastDispatchAt: null,
      lastFailureAt: null,
    }
    if (!this.db) return empty

    const coll = this.db.collection<WireNotificationLogDoc>(`${this.dbPrefix}notification_log`)
    const match = { sentAt: { $gte: window.from, $lte: window.to } }

    const [statusAgg, channelAgg, reasonAgg, kindAgg, lastSent, lastFailed] = await Promise.all([
      coll.aggregate<{ _id: NotificationLogDoc['deliveryStatus']; count: number }>([
        { $match: match },
        { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
      ]).toArray(),
      coll.aggregate<{ _id: { channelId: ObjectId; deliveryStatus: NotificationLogDoc['deliveryStatus'] }; count: number }>([
        { $match: match },
        { $group: { _id: { channelId: '$channelId', deliveryStatus: '$deliveryStatus' }, count: { $sum: 1 } } },
      ]).toArray(),
      coll.aggregate<{ _id: string; count: number }>([
        { $match: { ...match, deliveryStatus: 'suppressed', suppressedReason: { $ne: null } } },
        { $group: { _id: '$suppressedReason', count: { $sum: 1 } } },
      ]).toArray(),
      coll.aggregate<{ _id: NotificationKind; count: number }>([
        { $match: match },
        { $group: { _id: '$kind', count: { $sum: 1 } } },
      ]).toArray(),
      coll.findOne(
        { ...match, deliveryStatus: 'sent' },
        { sort: { sentAt: -1 }, projection: { sentAt: 1 } },
      ),
      coll.findOne(
        { ...match, deliveryStatus: 'failed' },
        { sort: { sentAt: -1 }, projection: { sentAt: 1 } },
      ),
    ])

    const stats = { ...empty, byKind: { ...empty.byKind } }

    for (const row of statusAgg) {
      if (row._id === 'sent') stats.sent = row.count
      else if (row._id === 'failed') stats.failed = row.count
      else if (row._id === 'suppressed') stats.suppressed = row.count
      else if (row._id === 'pending') stats.pending = row.count
    }
    stats.total = stats.sent + stats.failed + stats.suppressed + stats.pending

    const byChannelMap = new Map<string, { sent: number; failed: number; suppressed: number }>()
    for (const row of channelAgg) {
      const key = row._id.channelId.toHexString()
      const entry = byChannelMap.get(key) ?? { sent: 0, failed: 0, suppressed: 0 }
      if (row._id.deliveryStatus === 'sent') entry.sent += row.count
      else if (row._id.deliveryStatus === 'failed') entry.failed += row.count
      else if (row._id.deliveryStatus === 'suppressed') entry.suppressed += row.count
      byChannelMap.set(key, entry)
    }
    stats.byChannel = Array.from(byChannelMap.entries()).map(([channelId, counts]) => ({
      channelId,
      ...counts,
    }))

    for (const row of reasonAgg) {
      if (row._id) stats.bySuppressedReason[row._id] = row.count
    }
    for (const row of kindAgg) {
      if (row._id && row._id in stats.byKind) {
        stats.byKind[row._id] = row.count
      }
    }

    stats.lastDispatchAt = lastSent?.sentAt ?? null
    stats.lastFailureAt = lastFailed?.sentAt ?? null
    return stats
  }

  private buildNotificationLogFilter(f: NotificationLogFilter): Record<string, unknown> {
    const filter: Record<string, unknown> = {}
    if (f.endpointId) filter.endpointId = toObjectId(f.endpointId, 'endpointId')
    if (f.channelId) filter.channelId = toObjectId(f.channelId, 'channelId')
    if (f.incidentId) filter.incidentId = toObjectId(f.incidentId, 'incidentId')
    if (f.retryOf && ObjectId.isValid(f.retryOf)) {
      filter.retryOf = new ObjectId(f.retryOf)
    }
    if (f.severity) filter.severity = f.severity
    if (f.kind) filter.kind = f.kind
    if (f.status) filter.deliveryStatus = f.status
    if (f.from || f.to) {
      const ts: Record<string, Date> = {}
      if (f.from) ts.$gte = f.from
      if (f.to) ts.$lte = f.to
      filter.sentAt = ts
    }
    if (f.search && f.search.trim() !== '') {
      const escaped = f.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.messageSummary = { $regex: escaped, $options: 'i' }
    }
    return filter
  }

  // ---------------------------------------------------------------------------
  // Notification mutes
  // ---------------------------------------------------------------------------

  async recordMute(
    data: Omit<NotificationMuteDoc, 'id' | 'mutedAt'>,
  ): Promise<NotificationMuteDoc> {
    const db = this.getDb()
    const wire: WireNotificationMuteDoc = {
      _id: new ObjectId(),
      scope: data.scope,
      mutedBy: data.mutedBy,
      mutedAt: new Date(),
      expiresAt: data.expiresAt,
    }
    if (data.targetId) wire.targetId = toObjectId(data.targetId, 'targetId')
    if (data.reason !== undefined) wire.reason = data.reason
    await db
      .collection<WireNotificationMuteDoc>(`${this.dbPrefix}notification_mutes`)
      .insertOne(wire)
    return notificationMuteFromWire(wire)
  }

  async listActiveMutes(): Promise<NotificationMuteDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireNotificationMuteDoc>(`${this.dbPrefix}notification_mutes`)
      .find({ expiresAt: { $gt: new Date() } })
      .sort({ expiresAt: 1 })
      .toArray()
    return wires.map(notificationMuteFromWire)
  }

  async getMuteById(id: string): Promise<NotificationMuteDoc | null> {
    if (!this.db) return null
    if (!ObjectId.isValid(id)) return null
    const wire = await this.db
      .collection<WireNotificationMuteDoc>(`${this.dbPrefix}notification_mutes`)
      .findOne({ _id: new ObjectId(id) })
    return wire ? notificationMuteFromWire(wire) : null
  }

  async deleteMute(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const db = this.getDb()
    const r = await db
      .collection<WireNotificationMuteDoc>(`${this.dbPrefix}notification_mutes`)
      .deleteOne({ _id: new ObjectId(id) })
    return r.deletedCount > 0
  }

  // ---------------------------------------------------------------------------
  // Notification preferences (singleton)
  // ---------------------------------------------------------------------------

  async getNotificationPreferences(): Promise<NotificationPreferencesDoc> {
    const db = this.getDb()
    const coll = db.collection<WireNotificationPreferencesDoc>(
      `${this.dbPrefix}notification_preferences`,
    )
    const existing = await coll.findOne({ _id: 'global' })
    if (existing) return notificationPreferencesFromWire(existing)
    const seed: WireNotificationPreferencesDoc = {
      _id: 'global',
      defaultSeverityFilter: 'warning+',
      defaultEventFilters: { sendOpen: true, sendResolved: true, sendEscalation: true },
      updatedAt: new Date(),
    }
    await coll.updateOne({ _id: 'global' }, { $setOnInsert: seed }, { upsert: true })
    return notificationPreferencesFromWire(seed)
  }

  async updateNotificationPreferences(
    changes: Partial<Omit<NotificationPreferencesDoc, 'id'>>,
  ): Promise<NotificationPreferencesDoc> {
    const db = this.getDb()
    const coll = db.collection<WireNotificationPreferencesDoc>(
      `${this.dbPrefix}notification_preferences`,
    )
    const patch = { ...changes, updatedAt: new Date() }
    const result = await coll.findOneAndUpdate(
      { _id: 'global' },
      { $set: patch },
      { upsert: true, returnDocument: 'after' },
    )
    if (result) return notificationPreferencesFromWire(result)
    return notificationPreferencesFromWire({
      _id: 'global',
      defaultSeverityFilter: 'warning+',
      defaultEventFilters: { sendOpen: true, sendResolved: true, sendEscalation: true },
      updatedAt: new Date(),
      ...changes,
    })
  }

  // ---------------------------------------------------------------------------
  // Aggregation write API
  // ---------------------------------------------------------------------------

  async getChecksInHour(endpointId: string, hourStart: Date, hourEnd: Date): Promise<CheckDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireCheckDoc>(`${this.dbPrefix}checks`)
      .find({
        endpointId: toObjectId(endpointId, 'endpointId'),
        timestamp: { $gte: hourStart, $lt: hourEnd },
      })
      .sort({ timestamp: 1 })
      .toArray()
    return wires.map(checkFromWire)
  }

  async upsertHourlySummary(
    summary: Omit<HourlySummaryDoc, 'id' | 'createdAt'>,
  ): Promise<void> {
    const db = this.getDb()
    const endpointOid = toObjectId(summary.endpointId, 'endpointId')
    const wireDoc = { ...summary, endpointId: endpointOid, createdAt: new Date() }
    await db
      .collection<WireHourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .updateOne(
        { endpointId: endpointOid, hour: summary.hour },
        { $set: wireDoc },
        { upsert: true },
      )
  }

  async upsertDailySummary(
    summary: Omit<DailySummaryDoc, 'id' | 'createdAt'>,
  ): Promise<void> {
    const db = this.getDb()
    const endpointOid = toObjectId(summary.endpointId, 'endpointId')
    const wireDoc = { ...summary, endpointId: endpointOid, createdAt: new Date() }
    await db
      .collection<WireDailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .updateOne(
        { endpointId: endpointOid, date: summary.date },
        { $set: wireDoc },
        { upsert: true },
      )
  }

  async deleteHourlySummariesBefore(before: Date): Promise<number> {
    const db = this.getDb()
    const result = await db
      .collection<WireHourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .deleteMany({ hour: { $lt: before } })
    return result.deletedCount
  }

  async deleteDailySummariesBefore(before: Date): Promise<number> {
    const db = this.getDb()
    const result = await db
      .collection<WireDailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .deleteMany({ date: { $lt: before } })
    return result.deletedCount
  }

  async getEndpointIdsWithChecks(from: Date, to: Date): Promise<string[]> {
    if (!this.db) return []
    const results = await this.db
      .collection<WireCheckDoc>(`${this.dbPrefix}checks`)
      .distinct('endpointId', { timestamp: { $gte: from, $lt: to } })
    return results.map((id: ObjectId) => id.toHexString())
  }

  // ---------------------------------------------------------------------------
  // Settings API
  // ---------------------------------------------------------------------------

  async getSettings(): Promise<SettingsDoc> {
    const db = this.getDb()
    const existing = await db
      .collection<WireSettingsDoc>(`${this.dbPrefix}settings`)
      .findOne({ _id: 'global' })
    if (existing) return settingsFromWire(existing)
    const seed: WireSettingsDoc = { _id: 'global' }
    await db
      .collection<WireSettingsDoc>(`${this.dbPrefix}settings`)
      .updateOne({ _id: 'global' }, { $setOnInsert: seed }, { upsert: true })
    return settingsFromWire(seed)
  }

  async updateSettings(changes: Record<string, unknown>): Promise<SettingsDoc> {
    const db = this.getDb()
    const { _id: _d, id: _id2, ...safe } = changes
    void _d
    void _id2
    const result = await db
      .collection<WireSettingsDoc>(`${this.dbPrefix}settings`)
      .findOneAndUpdate(
        { _id: 'global' },
        { $set: safe },
        { upsert: true, returnDocument: 'after' },
      )
    return result ? settingsFromWire(result) : settingsFromWire({ _id: 'global', ...safe })
  }

  async hardReset(): Promise<Record<string, number>> {
    const db = this.getDb()
    const suffixes = [
      'endpoints',
      'checks',
      'hourly_summaries',
      'daily_summaries',
      'incidents',
      'notification_channels',
      'notification_log',
      'notification_mutes',
      'notification_preferences',
      'settings',
      'system_events',
      'health_state',
      'internal_incidents',
    ] as const

    const counts: Record<string, number> = {}
    for (const suffix of suffixes) {
      const res = await db.collection(`${this.dbPrefix}${suffix}`).deleteMany({})
      counts[suffix] = res.deletedCount ?? 0
    }
    return counts
  }

  // ---------------------------------------------------------------------------
  // System Health persistence
  // ---------------------------------------------------------------------------

  async saveHealthState(state: Omit<HealthStateDoc, 'id'>): Promise<void> {
    const db = this.getDb()
    await db.collection<WireHealthStateDoc>(`${this.dbPrefix}health_state`).updateOne(
      { _id: 'snapshot' },
      { $set: { ...state, _id: 'snapshot' } },
      { upsert: true },
    )
  }

  async loadHealthState(): Promise<HealthStateDoc | null> {
    if (!this.db) return null
    const wire = await this.db
      .collection<WireHealthStateDoc>(`${this.dbPrefix}health_state`)
      .findOne({ _id: 'snapshot' })
    return wire ? healthStateFromWire(wire) : null
  }

  async listInternalIncidents(): Promise<InternalIncidentDoc[]> {
    if (!this.db) return []
    const wires = await this.db
      .collection<WireInternalIncidentDoc>(`${this.dbPrefix}internal_incidents`)
      .find()
      .sort({ startedAt: -1 })
      .limit(500)
      .toArray()
    return wires.map(internalIncidentFromWire)
  }

  async upsertInternalIncident(doc: InternalIncidentDoc): Promise<void> {
    const db = this.getDb()
    const wire: WireInternalIncidentDoc = {
      _id: doc.id,
      subsystem: doc.subsystem,
      severity: doc.severity,
      status: doc.status,
      title: doc.title,
      cause: doc.cause,
      startedAt: doc.startedAt,
      commits: doc.commits,
      timeline: doc.timeline,
    }
    if (doc.resolvedAt !== undefined) wire.resolvedAt = doc.resolvedAt
    if (doc.durationSeconds !== undefined) wire.durationSeconds = doc.durationSeconds
    if (doc.expiresAt !== undefined) wire.expiresAt = doc.expiresAt
    await db
      .collection<WireInternalIncidentDoc>(`${this.dbPrefix}internal_incidents`)
      .updateOne({ _id: wire._id }, { $set: wire }, { upsert: true })
  }

  // ---------------------------------------------------------------------------
  // Package-internal accessor
  // ---------------------------------------------------------------------------

  protected getDb(): Db {
    if (!this.db) throw new Error('MongoDBAdapter.getDb() called before connect()')
    return this.db
  }

  // ---------------------------------------------------------------------------
  // Shared pagination helper (operates on wire docs)
  // ---------------------------------------------------------------------------

  private async paginate<T extends { _id: ObjectId }>(
    collSuffix: string,
    filter: Record<string, unknown>,
    opts: DbPaginationOpts,
    sort: Record<string, 1 | -1>,
  ): Promise<DbPage<T>> {
    if (!this.db) return { items: [], total: 0, hasMore: false, nextCursor: null, prevCursor: null }

    const limit = Math.min(opts.limit ?? 20, 5000)
    const coll = this.db.collection<T>(`${this.dbPrefix}${collSuffix}`)
    const sortDir = Object.values(sort)[0] ?? 1

    const q: Record<string, unknown> = { ...filter }
    if (opts.cursor) {
      if (!ObjectId.isValid(opts.cursor)) {
        const err = new Error('Invalid pagination cursor') as Error & {
          statusCode?: number
          code?: string
        }
        err.statusCode = 400
        err.code = 'INVALID_CURSOR'
        throw err
      }
      const cursorOid = new ObjectId(opts.cursor)
      q._id = sortDir === 1 ? { $gt: cursorOid } : { $lt: cursorOid }
    }

    const [rawItems, total] = await Promise.all([
      coll.find(q as Parameters<typeof coll.find>[0]).sort(sort).limit(limit + 1).toArray(),
      coll.countDocuments(filter as Parameters<typeof coll.countDocuments>[0]),
    ])

    const items = rawItems as unknown as T[]
    const hasMore = items.length > limit
    if (hasMore) items.pop()

    return {
      items,
      total,
      hasMore,
      nextCursor: hasMore ? items.at(-1)!._id.toHexString() : null,
      prevCursor: items.length > 0 ? items[0]!._id.toHexString() : null,
    }
  }
}
