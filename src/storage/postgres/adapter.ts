import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { eventBus } from '../../core/eventBus.js'
import type { WatchDeckConfig } from '../../config/types.js'
import {
  StorageAdapter,
  type HealthCheckResult,
  type IncidentStats,
  type IncidentStatsFilter,
  type NotificationLogFilter,
  type NotificationStats,
  type NotificationStatsWindow,
} from '../adapter.js'
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
  InternalIncidentDoc,
  NotificationChannelDoc,
  NotificationDeliveryStatus,
  NotificationKind,
  NotificationLogDoc,
  NotificationMuteDoc,
  NotificationPreferencesDoc,
  NotificationSeverity,
  NotificationSuppressedReason,
  SettingsDoc,
  SystemEventDoc,
} from '../types.js'
import { ensureSchema } from './migrator.js'
import { isUuid, newId } from './id.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// ID validation — mirrors the shaped INVALID_ID error the Mongo adapter throws
// so the Fastify error handler serialises both identically.
// ---------------------------------------------------------------------------

function assertUuid(id: string, field: string): string {
  if (!isUuid(id)) {
    const err = new Error(`Invalid ${field}: must be a UUID`) as Error & {
      statusCode?: number
      code?: string
    }
    err.statusCode = 400
    err.code = 'INVALID_ID'
    throw err
  }
  return id
}

// ---------------------------------------------------------------------------
// Row → contract mappers. Postgres returns snake_case; contract is camelCase.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function toDate(v: unknown): Date {
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') return new Date(v)
  throw new Error(`Cannot coerce ${String(v)} to Date`)
}

function optDate(v: unknown): Date | undefined {
  if (v === null || v === undefined) return undefined
  return toDate(v)
}

function rowToEndpoint(r: Row): EndpointDoc {
  const out: EndpointDoc = {
    id: r.id as string,
    name: r.name as string,
    type: r.type as EndpointDoc['type'],
    checkInterval: r.check_interval as number,
    timeout: r.timeout as number,
    enabled: r.enabled as boolean,
    status: r.status as EndpointDoc['status'],
    latencyThreshold: r.latency_threshold as number,
    sslWarningDays: r.ssl_warning_days as number,
    failureThreshold: r.failure_threshold as number,
    recoveryThreshold: r.recovery_threshold as number,
    alertCooldown: r.alert_cooldown as number,
    recoveryAlert: r.recovery_alert as boolean,
    escalationDelay: r.escalation_delay as number,
    notificationChannelIds: (r.notification_channel_ids as string[] | null) ?? [],
    consecutiveFailures: r.consecutive_failures as number,
    consecutiveHealthy: r.consecutive_healthy as number,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
  if (r.description !== null && r.description !== undefined) {
    out.description = r.description as string
  }
  if (r.url !== null && r.url !== undefined) out.url = r.url as string
  if (r.method !== null && r.method !== undefined) out.method = r.method as EndpointDoc['method']
  if (r.headers !== null && r.headers !== undefined) out.headers = r.headers as Record<string, string>
  if (r.expected_status_codes !== null && r.expected_status_codes !== undefined) {
    out.expectedStatusCodes = r.expected_status_codes as number[]
  }
  if (r.assertions !== null && r.assertions !== undefined) {
    out.assertions = r.assertions as EndpointDoc['assertions']
  }
  if (r.host !== null && r.host !== undefined) out.host = r.host as string
  if (r.port !== null && r.port !== undefined) out.port = r.port as number
  if (r.escalation_channel_id !== null && r.escalation_channel_id !== undefined) {
    out.escalationChannelId = r.escalation_channel_id as string
  }
  if (r.paused_notification_channel_ids !== null && r.paused_notification_channel_ids !== undefined) {
    const arr = r.paused_notification_channel_ids as string[]
    if (arr.length > 0) out.pausedNotificationChannelIds = arr
  }
  if (r.last_check_at !== null && r.last_check_at !== undefined) {
    out.lastCheckAt = toDate(r.last_check_at)
  }
  if (r.last_status !== null && r.last_status !== undefined) {
    out.lastStatus = r.last_status as EndpointDoc['lastStatus']
  }
  if (r.last_response_time !== null && r.last_response_time !== undefined) {
    out.lastResponseTime = r.last_response_time as number
  }
  if (r.last_status_code !== null && r.last_status_code !== undefined) {
    out.lastStatusCode = r.last_status_code as number
  }
  if (r.last_error_message !== null && r.last_error_message !== undefined) {
    out.lastErrorMessage = r.last_error_message as string
  }
  if (r.last_ssl_issuer !== null && r.last_ssl_issuer !== undefined) {
    const raw = r.last_ssl_issuer as { o?: string; cn?: string; capturedAt: string | Date }
    out.lastSslIssuer = { ...raw, capturedAt: toDate(raw.capturedAt) }
  }
  if (r.current_incident_id !== null && r.current_incident_id !== undefined) {
    out.currentIncidentId = r.current_incident_id as string
  }
  return out
}

function rowToCheck(r: Row): CheckDoc {
  const out: CheckDoc = {
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    timestamp: toDate(r.timestamp),
    responseTime: r.response_time as number,
    status: r.status as CheckDoc['status'],
    createdAt: toDate(r.created_at),
  }
  if (r.status_code !== null && r.status_code !== undefined) out.statusCode = r.status_code as number
  if (r.ssl_days_remaining !== null && r.ssl_days_remaining !== undefined) {
    out.sslDaysRemaining = r.ssl_days_remaining as number
  }
  if (r.body_bytes !== null && r.body_bytes !== undefined) out.bodyBytes = r.body_bytes as number
  if (r.body_bytes_truncated !== null && r.body_bytes_truncated !== undefined) {
    out.bodyBytesTruncated = r.body_bytes_truncated as boolean
  }
  if (r.assertion_result !== null && r.assertion_result !== undefined) {
    out.assertionResult = r.assertion_result as CheckDoc['assertionResult']
  }
  if (r.port_open !== null && r.port_open !== undefined) out.portOpen = r.port_open as boolean
  if (r.status_reason !== null && r.status_reason !== undefined) {
    out.statusReason = r.status_reason as string
  }
  if (r.error_message !== null && r.error_message !== undefined) {
    out.errorMessage = r.error_message as string
  }
  return out
}

function rowToHourlySummary(r: Row): HourlySummaryDoc {
  return {
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    hour: toDate(r.hour),
    totalChecks: r.total_checks as number,
    successCount: r.success_count as number,
    failCount: r.fail_count as number,
    degradedCount: r.degraded_count as number,
    uptimePercent: Number(r.uptime_percent),
    avgResponseTime: Number(r.avg_response_time),
    minResponseTime: r.min_response_time as number,
    maxResponseTime: r.max_response_time as number,
    p95ResponseTime: r.p95_response_time as number,
    p99ResponseTime: r.p99_response_time as number,
    errorTypes: (r.error_types as Record<string, number> | null) ?? {},
    hadActiveIncident: r.had_active_incident as boolean,
    createdAt: toDate(r.created_at),
  }
}

function rowToDailySummary(r: Row): DailySummaryDoc {
  return {
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    date: toDate(r.date),
    totalChecks: r.total_checks as number,
    uptimePercent: Number(r.uptime_percent),
    avgResponseTime: Number(r.avg_response_time),
    minResponseTime: r.min_response_time as number,
    maxResponseTime: r.max_response_time as number,
    p95ResponseTime: r.p95_response_time as number,
    p99ResponseTime: r.p99_response_time as number,
    incidentCount: r.incident_count as number,
    totalDowntimeMinutes: Number(r.total_downtime_minutes),
    createdAt: toDate(r.created_at),
  }
}

function rowToIncident(r: Row): IncidentDoc {
  const out: IncidentDoc = {
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    status: r.status as IncidentDoc['status'],
    cause: r.cause as string,
    startedAt: toDate(r.started_at),
    timeline: ((r.timeline as Array<{ at: string | Date; event: string; detail?: string }> | null) ?? []).map(
      (t) => ({ at: toDate(t.at), event: t.event, ...(t.detail !== undefined ? { detail: t.detail } : {}) }),
    ),
    notificationsSent: r.notifications_sent as number,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
  if (r.cause_detail !== null && r.cause_detail !== undefined) out.causeDetail = r.cause_detail as string
  if (r.resolved_at !== null && r.resolved_at !== undefined) out.resolvedAt = toDate(r.resolved_at)
  if (r.duration_seconds !== null && r.duration_seconds !== undefined) {
    out.durationSeconds = r.duration_seconds as number
  }
  return out
}

function rowToChannel(r: Row): NotificationChannelDoc {
  const providerConfig = (r.provider_config as Record<string, unknown> | null) ?? {}
  const out: NotificationChannelDoc = {
    id: r.id as string,
    type: r.type as NotificationChannelDoc['type'],
    name: r.name as string,
    deliveryPriority: r.delivery_priority as NotificationChannelDoc['deliveryPriority'],
    enabled: r.enabled as boolean,
    severityFilter: r.severity_filter as NotificationChannelDoc['severityFilter'],
    eventFilters: r.event_filters as NotificationChannelDoc['eventFilters'],
    retryOnFailure: r.retry_on_failure as boolean,
    isConnected: r.is_connected as boolean,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    ...providerConfig,
  }
  if (r.rate_limit !== null && r.rate_limit !== undefined) {
    out.rateLimit = r.rate_limit as NotificationChannelDoc['rateLimit']
  }
  if (r.metadata !== null && r.metadata !== undefined) {
    out.metadata = r.metadata as Record<string, unknown>
  }
  if (r.last_tested_at !== null && r.last_tested_at !== undefined) {
    out.lastTestedAt = toDate(r.last_tested_at)
  }
  if (r.last_success_at !== null && r.last_success_at !== undefined) {
    out.lastSuccessAt = toDate(r.last_success_at)
  }
  if (r.last_failure_at !== null && r.last_failure_at !== undefined) {
    out.lastFailureAt = toDate(r.last_failure_at)
  }
  return out
}

const PROVIDER_FIELDS = [
  'discordWebhookUrl',
  'discordUsername',
  'discordAvatarUrl',
  'slackWebhookUrl',
  'emailEndpoint',
  'emailRecipients',
  'webhookUrl',
  'webhookMethod',
  'webhookHeaders',
  'webhookBodyTemplate',
] as const

function extractProviderConfig(
  channel: Partial<NotificationChannelDoc>,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  for (const key of PROVIDER_FIELDS) {
    if (channel[key] !== undefined) cfg[key] = channel[key]
  }
  return cfg
}

function rowToLog(r: Row): NotificationLogDoc {
  const out: NotificationLogDoc = {
    id: r.id as string,
    channelId: r.channel_id as string,
    type: r.type as string,
    channelType: r.channel_type as NotificationLogDoc['channelType'],
    channelTarget: r.channel_target as string,
    messageSummary: r.message_summary as string,
    severity: r.severity as NotificationSeverity,
    kind: r.kind as NotificationKind,
    deliveryStatus: r.delivery_status as NotificationDeliveryStatus,
    sentAt: toDate(r.sent_at),
    createdAt: toDate(r.created_at),
  }
  if (r.endpoint_id !== null && r.endpoint_id !== undefined) out.endpointId = r.endpoint_id as string
  if (r.incident_id !== null && r.incident_id !== undefined) out.incidentId = r.incident_id as string
  if (r.failure_reason !== null && r.failure_reason !== undefined) {
    out.failureReason = r.failure_reason as string
  }
  if (r.suppressed_reason !== null && r.suppressed_reason !== undefined) {
    out.suppressedReason = r.suppressed_reason as NotificationSuppressedReason
  }
  if (r.latency_ms !== null && r.latency_ms !== undefined) out.latencyMs = r.latency_ms as number
  if (r.idempotency_key !== null && r.idempotency_key !== undefined) {
    out.idempotencyKey = r.idempotency_key as string
  }
  if (r.retry_of !== null && r.retry_of !== undefined) out.retryOf = r.retry_of as string
  if (r.coalesced_into_log_id !== null && r.coalesced_into_log_id !== undefined) {
    out.coalescedIntoLogId = r.coalesced_into_log_id as string
  }
  if (r.coalesced_count !== null && r.coalesced_count !== undefined) {
    out.coalescedCount = r.coalesced_count as number
  }
  if (r.coalesced_incident_ids !== null && r.coalesced_incident_ids !== undefined) {
    out.coalescedIncidentIds = r.coalesced_incident_ids as string[]
  }
  if (r.payload !== null && r.payload !== undefined) {
    out.payload = r.payload as NotificationLogDoc['payload']
  }
  if (r.request !== null && r.request !== undefined) {
    out.request = r.request as NotificationLogDoc['request']
  }
  if (r.response !== null && r.response !== undefined) {
    out.response = r.response as NotificationLogDoc['response']
  }
  return out
}

function rowToMute(r: Row): NotificationMuteDoc {
  const out: NotificationMuteDoc = {
    id: r.id as string,
    scope: r.scope as NotificationMuteDoc['scope'],
    mutedBy: r.muted_by as string,
    mutedAt: toDate(r.muted_at),
    expiresAt: toDate(r.expires_at),
  }
  if (r.target_id !== null && r.target_id !== undefined) out.targetId = r.target_id as string
  if (r.reason !== null && r.reason !== undefined) out.reason = r.reason as string
  return out
}

function rowToPreferences(r: Row): NotificationPreferencesDoc {
  const out: NotificationPreferencesDoc = {
    id: 'global',
    defaultSeverityFilter: r.default_severity_filter as NotificationPreferencesDoc['defaultSeverityFilter'],
    defaultEventFilters: r.default_event_filters as NotificationPreferencesDoc['defaultEventFilters'],
    updatedAt: toDate(r.updated_at),
  }
  if (r.global_mute_until !== null && r.global_mute_until !== undefined) {
    out.globalMuteUntil = toDate(r.global_mute_until)
  }
  if (r.last_edited_by !== null && r.last_edited_by !== undefined) {
    out.lastEditedBy = r.last_edited_by as string
  }
  return out
}

function rowToSettings(r: Row): SettingsDoc {
  const extra = (r.extra as Record<string, unknown> | null) ?? {}
  const out: SettingsDoc = { id: 'global', ...extra }
  if (r.defaults !== null && r.defaults !== undefined) {
    out.defaults = r.defaults as SettingsDoc['defaults']
  }
  if (r.slo !== null && r.slo !== undefined) out.slo = r.slo as SettingsDoc['slo']
  return out
}

function rowToSystemEvent(r: Row): SystemEventDoc {
  const out: SystemEventDoc = {
    id: r.id as string,
    type: r.type as SystemEventDoc['type'],
    startedAt: toDate(r.started_at),
    reconnectAttempts: r.reconnect_attempts as number,
    severity: r.severity as SystemEventDoc['severity'],
    cause: r.cause as string,
    bufferedToMemory: r.buffered_to_memory as number,
    bufferedToDisk: r.buffered_to_disk as number,
    replayStatus: r.replay_status as SystemEventDoc['replayStatus'],
    replayedCount: r.replayed_count as number,
    replayErrors: r.replay_errors as number,
    timeline: ((r.timeline as Array<{ at: string | Date; event: string; detail?: string }> | null) ?? []).map(
      (t) => ({ at: toDate(t.at), event: t.event, ...(t.detail !== undefined ? { detail: t.detail } : {}) }),
    ),
  }
  if (r.resolved_at !== null && r.resolved_at !== undefined) out.resolvedAt = toDate(r.resolved_at)
  if (r.duration_seconds !== null && r.duration_seconds !== undefined) {
    out.durationSeconds = r.duration_seconds as number
  }
  if (r.cause_detail !== null && r.cause_detail !== undefined) {
    out.causeDetail = r.cause_detail as string
  }
  return out
}

function rowToHealthState(r: Row): HealthStateDoc {
  return {
    id: 'snapshot',
    savedAt: toDate(r.saved_at),
    probeHistory: r.probe_history as HealthStateDoc['probeHistory'],
    heatmap: r.heatmap as HealthStateDoc['heatmap'],
  }
}

function rowToInternalIncident(r: Row): InternalIncidentDoc {
  const out: InternalIncidentDoc = {
    id: r.id as string,
    subsystem: r.subsystem as string,
    severity: r.severity as InternalIncidentDoc['severity'],
    status: r.status as InternalIncidentDoc['status'],
    title: r.title as string,
    cause: r.cause as string,
    startedAt: toDate(r.started_at),
    commits: r.commits as number,
    timeline: ((r.timeline as Array<{ at: string | Date; event: string; detail?: string }> | null) ?? []).map(
      (t) => ({ at: toDate(t.at), event: t.event, ...(t.detail !== undefined ? { detail: t.detail } : {}) }),
    ),
  }
  if (r.resolved_at !== null && r.resolved_at !== undefined) out.resolvedAt = toDate(r.resolved_at)
  if (r.duration_seconds !== null && r.duration_seconds !== undefined) {
    out.durationSeconds = r.duration_seconds as number
  }
  if (r.expires_at !== null && r.expires_at !== undefined) out.expiresAt = toDate(r.expires_at)
  return out
}

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

const HEALTH_PROBE_INTERVAL_MS = 10_000
const BOOT_ATTEMPTS = 3
const BOOT_GAP_MS = 5_000

export class PostgresAdapter extends StorageAdapter {
  private pool: Pool | null = null
  private _connected = false
  private _intentionalDisconnect = false
  private disconnectedAt: number | null = null
  private reconnectAttemptCount: number | null = null
  private healthProbeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly uri: string,
    private readonly dbPrefix: string,
    private readonly config: WatchDeckConfig,
  ) {
    super()
  }

  // Exposed so start.ts can pass the Pool to the retention sweeper without
  // needing a separate connection.
  getPool(): Pool {
    if (!this.pool) throw new Error('PostgresAdapter.getPool() called before connect()')
    return this.pool
  }

  getPrefix(): string {
    return this.dbPrefix
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
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
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
      try {
        await this.openPool()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: lastError,
          context: `boot attempt ${attempt}/${BOOT_ATTEMPTS}`,
        })
        if (attempt < BOOT_ATTEMPTS) await sleep(BOOT_GAP_MS)
      }
    }
    throw lastError ?? new Error('Postgres connection failed after 3 attempts')
  }

  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true
    this._connected = false
    this.stopHealthProbe()
    if (this.pool) {
      try {
        await this.pool.end()
      } catch {
        // pool may already be broken — swallow
      }
      this.pool = null
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.pool || !this._connected) return { status: 'down', latencyMs: 0 }
    try {
      const start = Date.now()
      await this.pool.query('SELECT 1')
      const latencyMs = Date.now() - start
      return { status: latencyMs > 2_000 ? 'degraded' : 'healthy', latencyMs }
    } catch {
      return { status: 'down', latencyMs: 0 }
    }
  }

  async migrate(): Promise<{ collectionCount: number }> {
    if (!this.pool) throw new Error('Cannot run migrations: not connected to Postgres')
    const client = await this.pool.connect()
    try {
      return await ensureSchema(client, this.dbPrefix)
    } finally {
      client.release()
    }
  }

  private async openPool(): Promise<void> {
    const start = Date.now()
    const poolConfig: PoolConfig = {
      connectionString: this.uri,
      max: this.config.rateLimits.dbPoolSize,
      connectionTimeoutMillis: 5_000,
    }
    const pool = new Pool(poolConfig)

    pool.on('error', (err) => {
      // Unexpected pool-level error — the health probe will detect the outage
      // soon; just surface the error to the bus here.
      eventBus.emit('db:error', {
        timestamp: new Date(),
        error: err,
        context: 'pool error',
      })
    })

    await pool.query('SELECT 1')
    const latencyMs = Date.now() - start

    if (this.pool) {
      try {
        await this.pool.end()
      } catch {
        // ignore close errors on previous pool
      }
    }

    this.pool = pool
    this._connected = true
    this.disconnectedAt = null
    this.reconnectAttemptCount = null
    this.startHealthProbe()
    eventBus.emit('db:connected', { timestamp: new Date(), latencyMs })
  }

  private startHealthProbe(): void {
    this.stopHealthProbe()
    this.healthProbeTimer = setInterval(() => {
      if (!this.pool || !this._connected) return
      this.pool
        .query('SELECT 1')
        .then(() => {
          // still healthy — nothing to do
        })
        .catch((err: unknown) => {
          if (this._intentionalDisconnect || !this._connected) return
          this._connected = false
          this.disconnectedAt = Date.now()
          eventBus.emit('db:disconnected', {
            timestamp: new Date(),
            error: err instanceof Error ? err.message : String(err),
          })
          void this.reconnectLoop()
        })
    }, HEALTH_PROBE_INTERVAL_MS)
    this.healthProbeTimer.unref?.()
  }

  private stopHealthProbe(): void {
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer)
      this.healthProbeTimer = null
    }
  }

  private async reconnectLoop(): Promise<void> {
    this.stopHealthProbe()
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
        await this.openPool()
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

  private getRequiredPool(): Pool {
    if (!this.pool) throw new Error('PostgresAdapter used before connect()')
    return this.pool
  }

  // ---------------------------------------------------------------------------
  // Buffer pipeline
  // ---------------------------------------------------------------------------

  async saveCheck(payload: CheckWritePayload): Promise<void> {
    await this.insertCheckRows([payload])
  }

  async saveManyChecks(payloads: CheckWritePayload[]): Promise<void> {
    if (payloads.length === 0) return
    await this.insertCheckRows(payloads)
  }

  private async insertCheckRows(payloads: CheckWritePayload[]): Promise<void> {
    const pool = this.getRequiredPool()
    const columns = [
      'id', 'endpoint_id', 'timestamp', 'response_time',
      'status_code', 'ssl_days_remaining', 'body_bytes', 'body_bytes_truncated',
      'assertion_result', 'status', 'error_message',
    ]
    const placeholders: string[] = []
    const values: unknown[] = []
    let p = 1
    for (const payload of payloads) {
      const ts = payload.timestamp instanceof Date ? payload.timestamp : new Date(payload.timestamp)
      const row = [
        newId(),
        assertUuid(payload.endpointId, 'endpointId'),
        ts,
        payload.responseTime,
        payload.statusCode,
        payload.sslDaysRemaining,
        payload.bodyBytes ?? null,
        payload.bodyBytesTruncated ?? null,
        payload.assertionResult ? JSON.stringify(payload.assertionResult) : null,
        payload.status,
        payload.errorMessage,
      ]
      const ph = row.map(() => `$${p++}`).join(', ')
      placeholders.push(`(${ph})`)
      values.push(...row)
    }
    await pool.query(
      `INSERT INTO ${this.dbPrefix}checks (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
      values,
    )
  }

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  async saveSystemEvent(event: Omit<SystemEventDoc, 'id'>): Promise<void> {
    const pool = this.getRequiredPool()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}system_events (
         id, type, started_at, resolved_at, duration_seconds, reconnect_attempts,
         severity, cause, cause_detail, buffered_to_memory, buffered_to_disk,
         replay_status, replayed_count, replay_errors, timeline
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        newId(),
        event.type,
        event.startedAt,
        event.resolvedAt ?? null,
        event.durationSeconds ?? null,
        event.reconnectAttempts,
        event.severity,
        event.cause,
        event.causeDetail ?? null,
        event.bufferedToMemory,
        event.bufferedToDisk,
        event.replayStatus,
        event.replayedCount,
        event.replayErrors,
        JSON.stringify(event.timeline),
      ],
    )
  }

  async getSystemEvents(limit = 50): Promise<SystemEventDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}system_events ORDER BY started_at DESC LIMIT $1`,
      [limit],
    )
    return rows.map(rowToSystemEvent)
  }

  // ---------------------------------------------------------------------------
  // Check engine
  // ---------------------------------------------------------------------------

  async listEnabledEndpoints(): Promise<EndpointDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}endpoints WHERE status IN ('active','paused')`,
    )
    return rows.map(rowToEndpoint)
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
    const pool = this.getRequiredPool()
    const hasSsl = !!(sslIssuer && (sslIssuer.o || sslIssuer.cn))
    if (hasSsl) {
      await pool.query(
        `UPDATE ${this.dbPrefix}endpoints SET
           last_check_at=$2, last_status=$3, last_response_time=$4,
           last_status_code=$5, last_error_message=$6, consecutive_failures=$7,
           consecutive_healthy=$8, last_ssl_issuer=$9, updated_at=now()
         WHERE id=$1`,
        [
          assertUuid(endpointId, 'endpointId'),
          timestamp,
          status,
          responseTime,
          statusCode,
          errorMessage,
          consecutiveFailures,
          consecutiveHealthy,
          JSON.stringify({ ...sslIssuer, capturedAt: timestamp }),
        ],
      )
    } else {
      await pool.query(
        `UPDATE ${this.dbPrefix}endpoints SET
           last_check_at=$2, last_status=$3, last_response_time=$4,
           last_status_code=$5, last_error_message=$6, consecutive_failures=$7,
           consecutive_healthy=$8, updated_at=now()
         WHERE id=$1`,
        [
          assertUuid(endpointId, 'endpointId'),
          timestamp,
          status,
          responseTime,
          statusCode,
          errorMessage,
          consecutiveFailures,
          consecutiveHealthy,
        ],
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoints API
  // ---------------------------------------------------------------------------

  async createEndpoint(
    data: Omit<EndpointDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<EndpointDoc> {
    const pool = this.getRequiredPool()
    const id = newId()
    const now = new Date()
    if (data.escalationChannelId) assertUuid(data.escalationChannelId, 'escalationChannelId')
    for (const cid of data.notificationChannelIds) assertUuid(cid, 'channelId')
    for (const cid of data.pausedNotificationChannelIds ?? []) assertUuid(cid, 'channelId')
    if (data.currentIncidentId) assertUuid(data.currentIncidentId, 'incidentId')

    await pool.query(
      `INSERT INTO ${this.dbPrefix}endpoints (
         id, name, description, type, url, method, headers, expected_status_codes,
         assertions, host, port, check_interval, timeout, enabled, status,
         latency_threshold, ssl_warning_days, failure_threshold, recovery_threshold,
         alert_cooldown, recovery_alert, escalation_delay, escalation_channel_id,
         notification_channel_ids, paused_notification_channel_ids,
         last_check_at, last_status, last_response_time, last_status_code,
         last_error_message, last_ssl_issuer, current_incident_id,
         consecutive_failures, consecutive_healthy, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
      [
        id,
        data.name,
        data.description ?? null,
        data.type,
        data.url ?? null,
        data.method ?? null,
        data.headers ? JSON.stringify(data.headers) : null,
        data.expectedStatusCodes ?? null,
        data.assertions ? JSON.stringify(data.assertions) : null,
        data.host ?? null,
        data.port ?? null,
        data.checkInterval,
        data.timeout,
        data.enabled,
        data.status,
        data.latencyThreshold,
        data.sslWarningDays,
        data.failureThreshold,
        data.recoveryThreshold,
        data.alertCooldown,
        data.recoveryAlert,
        data.escalationDelay,
        data.escalationChannelId ?? null,
        data.notificationChannelIds,
        data.pausedNotificationChannelIds ?? [],
        data.lastCheckAt ?? null,
        data.lastStatus ?? null,
        data.lastResponseTime ?? null,
        data.lastStatusCode ?? null,
        data.lastErrorMessage ?? null,
        data.lastSslIssuer ? JSON.stringify(data.lastSslIssuer) : null,
        data.currentIncidentId ?? null,
        data.consecutiveFailures,
        data.consecutiveHealthy,
        now,
        now,
      ],
    )

    const fresh = await this.getEndpointById(id)
    return fresh!
  }

  async getEndpointById(id: string): Promise<EndpointDoc | null> {
    if (!this.pool) return null
    if (!isUuid(id)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}endpoints WHERE id=$1`,
      [id],
    )
    return rows[0] ? rowToEndpoint(rows[0]) : null
  }

  async listEndpoints(
    opts: DbPaginationOpts & { status?: 'active' | 'paused' | 'archived'; type?: 'http' | 'port' },
  ): Promise<DbPage<EndpointDoc>> {
    return this.paginateAsc(
      `${this.dbPrefix}endpoints`,
      rowToEndpoint,
      opts,
      (where, params) => {
        if (opts.status) {
          params.push(opts.status)
          where.push(`status = $${params.length}`)
        } else {
          where.push(`status IN ('active','paused')`)
        }
        if (opts.type) {
          params.push(opts.type)
          where.push(`type = $${params.length}`)
        }
      },
    )
  }

  async updateEndpoint(
    id: string,
    changes: Partial<EndpointDoc>,
  ): Promise<EndpointDoc | null> {
    const pool = this.getRequiredPool()
    assertUuid(id, 'endpointId')

    // Flatten the patch into `column=$n` fragments. Fields with ID semantics
    // get UUID-validated on the way through so a malformed id produces a 400
    // at this boundary rather than a database constraint error later.
    const frags: string[] = []
    const params: unknown[] = []
    const push = (col: string, val: unknown): void => {
      params.push(val)
      frags.push(`${col} = $${params.length}`)
    }

    if (changes.name !== undefined) push('name', changes.name)
    if (changes.description !== undefined) push('description', changes.description)
    if (changes.type !== undefined) push('type', changes.type)
    if (changes.url !== undefined) push('url', changes.url)
    if (changes.method !== undefined) push('method', changes.method)
    if (changes.headers !== undefined) push('headers', changes.headers ? JSON.stringify(changes.headers) : null)
    if (changes.expectedStatusCodes !== undefined) push('expected_status_codes', changes.expectedStatusCodes)
    if (changes.assertions !== undefined) push('assertions', changes.assertions ? JSON.stringify(changes.assertions) : null)
    if (changes.host !== undefined) push('host', changes.host)
    if (changes.port !== undefined) push('port', changes.port)
    if (changes.checkInterval !== undefined) push('check_interval', changes.checkInterval)
    if (changes.timeout !== undefined) push('timeout', changes.timeout)
    if (changes.enabled !== undefined) push('enabled', changes.enabled)
    if (changes.status !== undefined) push('status', changes.status)
    if (changes.latencyThreshold !== undefined) push('latency_threshold', changes.latencyThreshold)
    if (changes.sslWarningDays !== undefined) push('ssl_warning_days', changes.sslWarningDays)
    if (changes.failureThreshold !== undefined) push('failure_threshold', changes.failureThreshold)
    if (changes.recoveryThreshold !== undefined) push('recovery_threshold', changes.recoveryThreshold)
    if (changes.alertCooldown !== undefined) push('alert_cooldown', changes.alertCooldown)
    if (changes.recoveryAlert !== undefined) push('recovery_alert', changes.recoveryAlert)
    if (changes.escalationDelay !== undefined) push('escalation_delay', changes.escalationDelay)
    if (changes.escalationChannelId !== undefined) {
      push(
        'escalation_channel_id',
        changes.escalationChannelId ? assertUuid(changes.escalationChannelId, 'escalationChannelId') : null,
      )
    }
    if (changes.notificationChannelIds !== undefined) {
      for (const cid of changes.notificationChannelIds) assertUuid(cid, 'channelId')
      push('notification_channel_ids', changes.notificationChannelIds)
    }
    if (changes.pausedNotificationChannelIds !== undefined) {
      for (const cid of changes.pausedNotificationChannelIds) assertUuid(cid, 'channelId')
      push('paused_notification_channel_ids', changes.pausedNotificationChannelIds)
    }
    if (changes.lastCheckAt !== undefined) push('last_check_at', changes.lastCheckAt)
    if (changes.lastStatus !== undefined) push('last_status', changes.lastStatus)
    if (changes.lastResponseTime !== undefined) push('last_response_time', changes.lastResponseTime)
    if (changes.lastStatusCode !== undefined) push('last_status_code', changes.lastStatusCode)
    if (changes.lastErrorMessage !== undefined) push('last_error_message', changes.lastErrorMessage)
    if (changes.lastSslIssuer !== undefined) {
      push('last_ssl_issuer', changes.lastSslIssuer ? JSON.stringify(changes.lastSslIssuer) : null)
    }
    if (changes.currentIncidentId !== undefined) {
      push(
        'current_incident_id',
        changes.currentIncidentId ? assertUuid(changes.currentIncidentId, 'incidentId') : null,
      )
    }
    if (changes.consecutiveFailures !== undefined) push('consecutive_failures', changes.consecutiveFailures)
    if (changes.consecutiveHealthy !== undefined) push('consecutive_healthy', changes.consecutiveHealthy)

    if (frags.length === 0) return this.getEndpointById(id)

    frags.push(`updated_at = now()`)
    params.push(id)
    const { rows } = await pool.query(
      `UPDATE ${this.dbPrefix}endpoints SET ${frags.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    )
    return rows[0] ? rowToEndpoint(rows[0]) : null
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const pool = this.getRequiredPool()
    assertUuid(id, 'endpointId')
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.dbPrefix}endpoints WHERE id=$1`,
      [id],
    )
    return (rowCount ?? 0) > 0
  }

  async getLatestCheck(endpointId: string): Promise<CheckDoc | null> {
    if (!this.pool) return null
    if (!isUuid(endpointId)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}checks WHERE endpoint_id=$1 ORDER BY timestamp DESC LIMIT 1`,
      [endpointId],
    )
    return rows[0] ? rowToCheck(rows[0]) : null
  }

  // ---------------------------------------------------------------------------
  // Checks API
  // ---------------------------------------------------------------------------

  async listChecks(
    endpointId: string,
    opts: DbPaginationOpts & { from?: Date; to?: Date; status?: 'healthy' | 'degraded' | 'down' },
  ): Promise<DbPage<CheckDoc>> {
    assertUuid(endpointId, 'endpointId')
    return this.paginateDesc(
      `${this.dbPrefix}checks`,
      rowToCheck,
      opts,
      (where, params) => {
        params.push(endpointId)
        where.push(`endpoint_id = $${params.length}`)
        if (opts.from) {
          params.push(opts.from)
          where.push(`timestamp >= $${params.length}`)
        }
        if (opts.to) {
          params.push(opts.to)
          where.push(`timestamp <= $${params.length}`)
        }
        if (opts.status) {
          params.push(opts.status)
          where.push(`status = $${params.length}`)
        }
      },
    )
  }

  async listHourlySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<HourlySummaryDoc[]> {
    if (!this.pool) return []
    assertUuid(endpointId, 'endpointId')
    const limit = Math.min(opts.limit ?? 48, 1000)
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}hourly_summaries
       WHERE endpoint_id=$1 ORDER BY hour DESC LIMIT $2`,
      [endpointId, limit],
    )
    return rows.map(rowToHourlySummary)
  }

  async listDailySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<DailySummaryDoc[]> {
    if (!this.pool) return []
    assertUuid(endpointId, 'endpointId')
    const limit = Math.min(opts.limit ?? 90, 365)
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}daily_summaries
       WHERE endpoint_id=$1 ORDER BY date DESC LIMIT $2`,
      [endpointId, limit],
    )
    return rows.map(rowToDailySummary)
  }

  async getUptimeStats(
    endpointId: string,
  ): Promise<{ '24h': number | null; '7d': number | null; '30d': number | null; '90d': number | null }> {
    if (!this.pool) return { '24h': null, '7d': null, '30d': null, '90d': null }
    assertUuid(endpointId, 'endpointId')
    const oldest = await this.pool.query(
      `SELECT timestamp FROM ${this.dbPrefix}checks WHERE endpoint_id=$1 ORDER BY timestamp ASC LIMIT 1`,
      [endpointId],
    )
    if (oldest.rowCount === 0) return { '24h': null, '7d': null, '30d': null, '90d': null }
    const oldestTs = toDate((oldest.rows[0] as Row).timestamp).getTime()
    const now = Date.now()
    const dataAgeMs = now - oldestTs

    const calcUptime = async (sinceMs: number): Promise<number | null> => {
      if (dataAgeMs < sinceMs * 0.5) return null
      const since = new Date(now - sinceMs)
      const { rows } = await this.pool!.query<{ total: string; healthy: string }>(
        `SELECT
           COUNT(*)::text AS total,
           SUM(CASE WHEN status='healthy' THEN 1 ELSE 0 END)::text AS healthy
         FROM ${this.dbPrefix}checks
         WHERE endpoint_id=$1 AND timestamp >= $2`,
        [endpointId, since],
      )
      const total = Number(rows[0]?.total ?? 0)
      const healthy = Number(rows[0]?.healthy ?? 0)
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
    return this.paginateDesc(
      `${this.dbPrefix}incidents`,
      rowToIncident,
      opts,
      (where, params) => {
        if (opts.status) {
          params.push(opts.status)
          where.push(`status = $${params.length}`)
        }
        if (opts.endpointId) {
          params.push(assertUuid(opts.endpointId, 'endpointId'))
          where.push(`endpoint_id = $${params.length}`)
        }
        if (opts.from) {
          params.push(opts.from)
          where.push(`started_at >= $${params.length}`)
        }
        if (opts.to) {
          params.push(opts.to)
          where.push(`started_at <= $${params.length}`)
        }
      },
    )
  }

  async getIncidentById(id: string): Promise<IncidentDoc | null> {
    if (!this.pool) return null
    if (!isUuid(id)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}incidents WHERE id=$1`,
      [id],
    )
    return rows[0] ? rowToIncident(rows[0]) : null
  }

  async listActiveIncidents(): Promise<IncidentDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}incidents WHERE status='active' ORDER BY started_at DESC`,
    )
    return rows.map(rowToIncident)
  }

  async createIncident(
    data: Omit<IncidentDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IncidentDoc> {
    const pool = this.getRequiredPool()
    assertUuid(data.endpointId, 'endpointId')
    const id = newId()
    const now = new Date()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}incidents (
         id, endpoint_id, status, cause, cause_detail, started_at, resolved_at,
         duration_seconds, timeline, notifications_sent, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        data.endpointId,
        data.status,
        data.cause,
        data.causeDetail ?? null,
        data.startedAt,
        data.resolvedAt ?? null,
        data.durationSeconds ?? null,
        JSON.stringify(data.timeline),
        data.notificationsSent,
        now,
        now,
      ],
    )
    const fresh = await this.getIncidentById(id)
    return fresh!
  }

  async resolveIncident(
    id: string,
    resolvedAt: Date,
    durationSeconds: number,
  ): Promise<IncidentDoc | null> {
    const pool = this.getRequiredPool()
    assertUuid(id, 'incidentId')
    const resolveEvent = { at: resolvedAt, event: 'resolved', detail: `Resolved after ${durationSeconds}s` }
    const { rows } = await pool.query(
      `UPDATE ${this.dbPrefix}incidents
         SET status='resolved', resolved_at=$2, duration_seconds=$3,
             timeline = timeline || $4::jsonb,
             updated_at=now()
       WHERE id=$1 AND status='active'
       RETURNING *`,
      [id, resolvedAt, durationSeconds, JSON.stringify([resolveEvent])],
    )
    return rows[0] ? rowToIncident(rows[0]) : null
  }

  async addIncidentTimelineEvent(
    incidentId: string,
    event: { at: Date; event: string; detail?: string },
  ): Promise<void> {
    const pool = this.getRequiredPool()
    assertUuid(incidentId, 'incidentId')
    await pool.query(
      `UPDATE ${this.dbPrefix}incidents
         SET timeline = timeline || $2::jsonb, updated_at=now()
       WHERE id=$1`,
      [incidentId, JSON.stringify([event])],
    )
  }

  async setEndpointCurrentIncident(
    endpointId: string,
    incidentId: string | null,
  ): Promise<void> {
    const pool = this.getRequiredPool()
    assertUuid(endpointId, 'endpointId')
    if (incidentId) assertUuid(incidentId, 'incidentId')
    await pool.query(
      `UPDATE ${this.dbPrefix}endpoints SET current_incident_id=$2, updated_at=now() WHERE id=$1`,
      [endpointId, incidentId],
    )
  }

  async getIncidentStats(filter: IncidentStatsFilter): Promise<IncidentStats> {
    const pool = this.getRequiredPool()
    const tz = filter.tz ?? 'UTC'
    const windowMs = filter.to.getTime() - filter.from.getTime()
    const prevFrom = new Date(filter.from.getTime() - windowMs)

    const baseWhere: string[] = ['started_at >= $1', 'started_at <= $2']
    const baseParams: unknown[] = [filter.from, filter.to]
    if (filter.endpointId) {
      baseParams.push(assertUuid(filter.endpointId, 'endpointId'))
      baseWhere.push(`endpoint_id = $${baseParams.length}`)
    }
    const whereSql = `WHERE ${baseWhere.join(' AND ')}`

    const totalsQ = pool.query<{
      total: string; active: string; resolved: string; notifications_sent: string | null
    }>(
      `SELECT
         COUNT(*)::text AS total,
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END)::text AS active,
         SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END)::text AS resolved,
         SUM(COALESCE(notifications_sent, 0))::text AS notifications_sent
       FROM ${this.dbPrefix}incidents ${whereSql}`,
      baseParams,
    )

    const byDayCauseQ = pool.query<{ date: string; cause: string; count: string }>(
      `SELECT
         to_char((started_at AT TIME ZONE $${baseParams.length + 1}), 'YYYY-MM-DD') AS date,
         cause,
         COUNT(*)::text AS count
       FROM ${this.dbPrefix}incidents ${whereSql}
       GROUP BY date, cause`,
      [...baseParams, tz],
    )

    const byCauseQ = pool.query<{ cause: string; count: string }>(
      `SELECT cause, COUNT(*)::text AS count
       FROM ${this.dbPrefix}incidents ${whereSql}
       GROUP BY cause ORDER BY COUNT(*) DESC`,
      baseParams,
    )

    const byEndpointQ = pool.query<{
      endpoint_id: string; total: string; total_duration_sec: string; last_started_at: Date
    }>(
      `SELECT endpoint_id,
              COUNT(*)::text AS total,
              SUM(COALESCE(duration_seconds, 0))::text AS total_duration_sec,
              MAX(started_at) AS last_started_at
       FROM ${this.dbPrefix}incidents ${whereSql}
       GROUP BY endpoint_id`,
      baseParams,
    )

    const byEndpointDayQ = pool.query<{ endpoint_id: string; date: string; count: string }>(
      `SELECT endpoint_id,
              to_char((started_at AT TIME ZONE $${baseParams.length + 1}), 'YYYY-MM-DD') AS date,
              COUNT(*)::text AS count
       FROM ${this.dbPrefix}incidents ${whereSql}
       GROUP BY endpoint_id, date`,
      [...baseParams, tz],
    )

    const mttrQ = pool.query<{ date: string; avg_sec: string; count: string }>(
      `SELECT to_char((started_at AT TIME ZONE $${baseParams.length + 1}), 'YYYY-MM-DD') AS date,
              AVG(duration_seconds)::text AS avg_sec,
              COUNT(*)::text AS count
       FROM ${this.dbPrefix}incidents ${whereSql} AND status='resolved' AND duration_seconds > 0
       GROUP BY date`,
      [...baseParams, tz],
    )

    const prevParams: unknown[] = [prevFrom, filter.from]
    if (filter.endpointId) prevParams.push(filter.endpointId)
    const prevQ = pool.query<{ endpoint_id: string; count: string }>(
      `SELECT endpoint_id, COUNT(*)::text AS count
       FROM ${this.dbPrefix}incidents
       WHERE started_at >= $1 AND started_at < $2
       ${filter.endpointId ? 'AND endpoint_id = $3' : ''}
       GROUP BY endpoint_id`,
      prevParams,
    )

    const [totals, byDayCause, byCause, byEndpoint, byEndpointDay, mttr, prev] = await Promise.all([
      totalsQ,
      byDayCauseQ,
      byCauseQ,
      byEndpointQ,
      byEndpointDayQ,
      mttrQ,
      prevQ,
    ])

    const dates = enumerateDayKeys(filter.from, filter.to, tz)
    const byDayMap = new Map<string, { date: string; total: number; causes: Record<string, number> }>()
    for (const d of dates) byDayMap.set(d, { date: d, total: 0, causes: {} })
    for (const r of byDayCause.rows) {
      const b = byDayMap.get(r.date)
      if (!b) continue
      const n = Number(r.count)
      b.causes[r.cause] = (b.causes[r.cause] ?? 0) + n
      b.total += n
    }

    const prevByEndpoint = new Map<string, number>()
    for (const r of prev.rows) prevByEndpoint.set(r.endpoint_id, Number(r.count))

    const byEndpointOut = byEndpoint.rows
      .map((r) => ({
        endpointId: r.endpoint_id,
        total: Number(r.total),
        totalDurationSec: Number(r.total_duration_sec),
        lastStartedAt: toDate(r.last_started_at).toISOString(),
        prevTotal: prevByEndpoint.get(r.endpoint_id) ?? 0,
      }))
      .sort((a, b) => b.total - a.total)

    const mttrMap = new Map<string, { avgSec: number; count: number }>()
    for (const r of mttr.rows) {
      mttrMap.set(r.date, { avgSec: Math.round(Number(r.avg_sec)), count: Number(r.count) })
    }

    const t = totals.rows[0] ?? { total: '0', active: '0', resolved: '0', notifications_sent: '0' }
    return {
      totals: {
        total: Number(t.total),
        active: Number(t.active),
        resolved: Number(t.resolved),
        notificationsSent: Number(t.notifications_sent ?? 0),
      },
      byDay: dates.map((d) => byDayMap.get(d)!),
      byCause: byCause.rows.map((r) => ({ cause: r.cause, count: Number(r.count) })),
      byEndpoint: byEndpointOut,
      byEndpointDay: byEndpointDay.rows.map((r) => ({
        endpointId: r.endpoint_id,
        date: r.date,
        count: Number(r.count),
      })),
      resolvedDurationsByDay: dates.map((d) => {
        const hit = mttrMap.get(d)
        return { date: d, avgSec: hit?.avgSec ?? 0, count: hit?.count ?? 0 }
      }),
    }
  }

  // ---------------------------------------------------------------------------
  // Notification channels API
  // ---------------------------------------------------------------------------

  async listNotificationChannels(): Promise<NotificationChannelDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_channels ORDER BY created_at ASC`,
    )
    return rows.map(rowToChannel)
  }

  async createNotificationChannel(
    data: Omit<NotificationChannelDoc, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationChannelDoc> {
    const pool = this.getRequiredPool()
    const id = newId()
    const now = new Date()
    const providerConfig = extractProviderConfig(data)
    await pool.query(
      `INSERT INTO ${this.dbPrefix}notification_channels (
         id, type, name, delivery_priority, enabled, severity_filter, event_filters,
         quiet_hours, rate_limit, retry_on_failure, metadata, provider_config,
         is_connected, last_tested_at, last_success_at, last_failure_at,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id,
        data.type,
        data.name,
        data.deliveryPriority,
        data.enabled,
        data.severityFilter,
        JSON.stringify(data.eventFilters),
        // quiet_hours column retained for legacy rows; no longer written.
        null,
        data.rateLimit ? JSON.stringify(data.rateLimit) : null,
        data.retryOnFailure,
        data.metadata ? JSON.stringify(data.metadata) : null,
        JSON.stringify(providerConfig),
        data.isConnected,
        data.lastTestedAt ?? null,
        data.lastSuccessAt ?? null,
        data.lastFailureAt ?? null,
        now,
        now,
      ],
    )
    const fresh = await this.getNotificationChannelById(id)
    return fresh!
  }

  async updateNotificationChannel(
    id: string,
    changes: Partial<NotificationChannelDoc>,
  ): Promise<NotificationChannelDoc | null> {
    const pool = this.getRequiredPool()
    assertUuid(id, 'channelId')

    // Provider-specific fields live in the JSONB `provider_config` column.
    // When the caller patches any of them we merge onto the existing value
    // rather than overwriting — keeps the update call surface identical to
    // the Mongo adapter's `$set`.
    const providerPatch = extractProviderConfig(changes)
    const scalarFrags: string[] = []
    const params: unknown[] = []
    const push = (col: string, val: unknown): void => {
      params.push(val)
      scalarFrags.push(`${col} = $${params.length}`)
    }

    if (changes.type !== undefined) push('type', changes.type)
    if (changes.name !== undefined) push('name', changes.name)
    if (changes.deliveryPriority !== undefined) push('delivery_priority', changes.deliveryPriority)
    if (changes.enabled !== undefined) push('enabled', changes.enabled)
    if (changes.severityFilter !== undefined) push('severity_filter', changes.severityFilter)
    if (changes.eventFilters !== undefined) push('event_filters', JSON.stringify(changes.eventFilters))
    if (changes.rateLimit !== undefined) {
      push('rate_limit', changes.rateLimit ? JSON.stringify(changes.rateLimit) : null)
    }
    if (changes.retryOnFailure !== undefined) push('retry_on_failure', changes.retryOnFailure)
    if (changes.metadata !== undefined) {
      push('metadata', changes.metadata ? JSON.stringify(changes.metadata) : null)
    }
    if (changes.isConnected !== undefined) push('is_connected', changes.isConnected)
    if (changes.lastTestedAt !== undefined) push('last_tested_at', changes.lastTestedAt)
    if (changes.lastSuccessAt !== undefined) push('last_success_at', changes.lastSuccessAt)
    if (changes.lastFailureAt !== undefined) push('last_failure_at', changes.lastFailureAt)

    if (Object.keys(providerPatch).length > 0) {
      params.push(JSON.stringify(providerPatch))
      scalarFrags.push(
        `provider_config = COALESCE(provider_config, '{}'::jsonb) || $${params.length}::jsonb`,
      )
    }

    if (scalarFrags.length === 0) return this.getNotificationChannelById(id)

    scalarFrags.push(`updated_at = now()`)
    params.push(id)
    const { rows } = await pool.query(
      `UPDATE ${this.dbPrefix}notification_channels SET ${scalarFrags.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    )
    return rows[0] ? rowToChannel(rows[0]) : null
  }

  async deleteNotificationChannel(id: string): Promise<boolean> {
    const pool = this.getRequiredPool()
    assertUuid(id, 'channelId')
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.dbPrefix}notification_channels WHERE id=$1`,
      [id],
    )
    return (rowCount ?? 0) > 0
  }

  async getNotificationChannelById(id: string): Promise<NotificationChannelDoc | null> {
    if (!this.pool) return null
    if (!isUuid(id)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_channels WHERE id=$1`,
      [id],
    )
    return rows[0] ? rowToChannel(rows[0]) : null
  }

  // ---------------------------------------------------------------------------
  // Notification log API
  // ---------------------------------------------------------------------------

  async listNotificationLog(
    opts: DbPaginationOpts & NotificationLogFilter,
  ): Promise<DbPage<NotificationLogDoc>> {
    return this.paginateDesc(
      `${this.dbPrefix}notification_log`,
      rowToLog,
      opts,
      (where, params) => this.applyLogFilter(where, params, opts),
    )
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
    if (!this.pool) return []
    if (!isUuid(incidentId)) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_log
       WHERE incident_id=$1 ORDER BY sent_at DESC LIMIT 500`,
      [incidentId],
    )
    return rows.map(rowToLog)
  }

  async findCoalescedDeliveriesFor(incidentId: string): Promise<NotificationLogDoc[]> {
    if (!this.pool) return []
    if (!isUuid(incidentId)) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_log
       WHERE $1 = ANY(coalesced_incident_ids) ORDER BY sent_at DESC LIMIT 100`,
      [incidentId],
    )
    return rows.map(rowToLog)
  }

  async getNotificationLogById(id: string): Promise<NotificationLogDoc | null> {
    if (!this.pool) return null
    if (!isUuid(id)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_log WHERE id=$1`,
      [id],
    )
    return rows[0] ? rowToLog(rows[0]) : null
  }

  async writeNotificationLog(
    row: Omit<NotificationLogDoc, 'id' | 'createdAt'>,
  ): Promise<NotificationLogDoc> {
    const pool = this.getRequiredPool()
    assertUuid(row.channelId, 'channelId')
    if (row.endpointId) assertUuid(row.endpointId, 'endpointId')
    if (row.incidentId) assertUuid(row.incidentId, 'incidentId')
    if (row.retryOf) assertUuid(row.retryOf, 'retryOf')
    if (row.coalescedIntoLogId) assertUuid(row.coalescedIntoLogId, 'coalescedIntoLogId')
    for (const cid of row.coalescedIncidentIds ?? []) assertUuid(cid, 'incidentId')

    const id = newId()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}notification_log (
         id, endpoint_id, incident_id, channel_id, type, kind, channel_type,
         channel_target, message_summary, severity, delivery_status,
         failure_reason, suppressed_reason, latency_ms, idempotency_key,
         retry_of, coalesced_into_log_id, coalesced_count, coalesced_incident_ids,
         payload, request, response, sent_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        id,
        row.endpointId ?? null,
        row.incidentId ?? null,
        row.channelId,
        row.type,
        row.kind,
        row.channelType,
        row.channelTarget,
        row.messageSummary,
        row.severity,
        row.deliveryStatus,
        row.failureReason ?? null,
        row.suppressedReason ?? null,
        row.latencyMs ?? null,
        row.idempotencyKey ?? null,
        row.retryOf ?? null,
        row.coalescedIntoLogId ?? null,
        row.coalescedCount ?? null,
        row.coalescedIncidentIds ?? null,
        row.payload ? JSON.stringify(row.payload) : null,
        row.request ? JSON.stringify(row.request) : null,
        row.response ? JSON.stringify(row.response) : null,
        row.sentAt,
      ],
    )
    const fresh = await this.getNotificationLogById(id)
    return fresh!
  }

  async redactOldNotificationLogs(before: Date): Promise<number> {
    const pool = this.getRequiredPool()
    const { rowCount } = await pool.query(
      `UPDATE ${this.dbPrefix}notification_log
         SET payload = NULL, request = NULL, response = NULL
       WHERE sent_at < $1
         AND (payload IS NOT NULL OR request IS NOT NULL OR response IS NOT NULL)`,
      [before],
    )
    return rowCount ?? 0
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
    if (!this.pool) return empty
    const where = `WHERE sent_at >= $1 AND sent_at <= $2`
    const params: unknown[] = [window.from, window.to]

    const statusQ = this.pool.query<{ delivery_status: string; count: string }>(
      `SELECT delivery_status, COUNT(*)::text AS count
       FROM ${this.dbPrefix}notification_log ${where}
       GROUP BY delivery_status`,
      params,
    )
    const channelQ = this.pool.query<{
      channel_id: string; delivery_status: string; count: string
    }>(
      `SELECT channel_id, delivery_status, COUNT(*)::text AS count
       FROM ${this.dbPrefix}notification_log ${where}
       GROUP BY channel_id, delivery_status`,
      params,
    )
    const reasonQ = this.pool.query<{ suppressed_reason: string; count: string }>(
      `SELECT suppressed_reason, COUNT(*)::text AS count
       FROM ${this.dbPrefix}notification_log ${where} AND delivery_status='suppressed' AND suppressed_reason IS NOT NULL
       GROUP BY suppressed_reason`,
      params,
    )
    const kindQ = this.pool.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text AS count
       FROM ${this.dbPrefix}notification_log ${where}
       GROUP BY kind`,
      params,
    )
    const lastSentQ = this.pool.query<{ sent_at: Date }>(
      `SELECT sent_at FROM ${this.dbPrefix}notification_log
       ${where} AND delivery_status='sent' ORDER BY sent_at DESC LIMIT 1`,
      params,
    )
    const lastFailedQ = this.pool.query<{ sent_at: Date }>(
      `SELECT sent_at FROM ${this.dbPrefix}notification_log
       ${where} AND delivery_status='failed' ORDER BY sent_at DESC LIMIT 1`,
      params,
    )

    const [status, channel, reason, kind, lastSent, lastFailed] = await Promise.all([
      statusQ,
      channelQ,
      reasonQ,
      kindQ,
      lastSentQ,
      lastFailedQ,
    ])

    const stats: NotificationStats = {
      ...empty,
      byKind: { ...empty.byKind },
      bySuppressedReason: {} as Record<string, number>,
    }
    for (const r of status.rows) {
      const n = Number(r.count)
      if (r.delivery_status === 'sent') stats.sent = n
      else if (r.delivery_status === 'failed') stats.failed = n
      else if (r.delivery_status === 'suppressed') stats.suppressed = n
      else if (r.delivery_status === 'pending') stats.pending = n
    }
    stats.total = stats.sent + stats.failed + stats.suppressed + stats.pending

    const byChannelMap = new Map<string, { sent: number; failed: number; suppressed: number }>()
    for (const r of channel.rows) {
      const entry = byChannelMap.get(r.channel_id) ?? { sent: 0, failed: 0, suppressed: 0 }
      const n = Number(r.count)
      if (r.delivery_status === 'sent') entry.sent += n
      else if (r.delivery_status === 'failed') entry.failed += n
      else if (r.delivery_status === 'suppressed') entry.suppressed += n
      byChannelMap.set(r.channel_id, entry)
    }
    stats.byChannel = Array.from(byChannelMap.entries()).map(([channelId, counts]) => ({
      channelId,
      ...counts,
    }))

    for (const r of reason.rows) {
      stats.bySuppressedReason[r.suppressed_reason] = Number(r.count)
    }
    for (const r of kind.rows) {
      if (r.kind in stats.byKind) {
        stats.byKind[r.kind as NotificationKind] = Number(r.count)
      }
    }
    stats.lastDispatchAt = lastSent.rows[0]?.sent_at ? toDate(lastSent.rows[0].sent_at) : null
    stats.lastFailureAt = lastFailed.rows[0]?.sent_at ? toDate(lastFailed.rows[0].sent_at) : null
    return stats
  }

  private applyLogFilter(
    where: string[],
    params: unknown[],
    f: NotificationLogFilter,
  ): void {
    if (f.endpointId) {
      params.push(assertUuid(f.endpointId, 'endpointId'))
      where.push(`endpoint_id = $${params.length}`)
    }
    if (f.channelId) {
      params.push(assertUuid(f.channelId, 'channelId'))
      where.push(`channel_id = $${params.length}`)
    }
    if (f.incidentId) {
      params.push(assertUuid(f.incidentId, 'incidentId'))
      where.push(`incident_id = $${params.length}`)
    }
    if (f.retryOf && isUuid(f.retryOf)) {
      params.push(f.retryOf)
      where.push(`retry_of = $${params.length}`)
    }
    if (f.severity) {
      params.push(f.severity)
      where.push(`severity = $${params.length}`)
    }
    if (f.kind) {
      params.push(f.kind)
      where.push(`kind = $${params.length}`)
    }
    if (f.status) {
      params.push(f.status)
      where.push(`delivery_status = $${params.length}`)
    }
    if (f.from) {
      params.push(f.from)
      where.push(`sent_at >= $${params.length}`)
    }
    if (f.to) {
      params.push(f.to)
      where.push(`sent_at <= $${params.length}`)
    }
    if (f.search && f.search.trim() !== '') {
      params.push(`%${f.search}%`)
      where.push(`message_summary ILIKE $${params.length}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Notification mutes
  // ---------------------------------------------------------------------------

  async recordMute(
    data: Omit<NotificationMuteDoc, 'id' | 'mutedAt'>,
  ): Promise<NotificationMuteDoc> {
    const pool = this.getRequiredPool()
    if (data.targetId) assertUuid(data.targetId, 'targetId')
    const id = newId()
    const now = new Date()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}notification_mutes
         (id, scope, target_id, muted_by, muted_at, expires_at, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, data.scope, data.targetId ?? null, data.mutedBy, now, data.expiresAt, data.reason ?? null],
    )
    return {
      id,
      scope: data.scope,
      mutedBy: data.mutedBy,
      mutedAt: now,
      expiresAt: data.expiresAt,
      ...(data.targetId !== undefined ? { targetId: data.targetId } : {}),
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
    }
  }

  async listActiveMutes(): Promise<NotificationMuteDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_mutes
       WHERE expires_at > now() ORDER BY expires_at ASC`,
    )
    return rows.map(rowToMute)
  }

  async getMuteById(id: string): Promise<NotificationMuteDoc | null> {
    if (!this.pool) return null
    if (!isUuid(id)) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_mutes WHERE id=$1`,
      [id],
    )
    return rows[0] ? rowToMute(rows[0]) : null
  }

  async deleteMute(id: string): Promise<boolean> {
    if (!isUuid(id)) return false
    const pool = this.getRequiredPool()
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.dbPrefix}notification_mutes WHERE id=$1`,
      [id],
    )
    return (rowCount ?? 0) > 0
  }

  // ---------------------------------------------------------------------------
  // Notification preferences (singleton)
  // ---------------------------------------------------------------------------

  async getNotificationPreferences(): Promise<NotificationPreferencesDoc> {
    const pool = this.getRequiredPool()
    const { rows } = await pool.query(
      `SELECT * FROM ${this.dbPrefix}notification_preferences WHERE id='global'`,
    )
    if (rows[0]) return rowToPreferences(rows[0])
    // Lazy seed mirrors the Mongo path — first read materialises defaults.
    const seed: NotificationPreferencesDoc = {
      id: 'global',
      defaultSeverityFilter: 'warning+',
      defaultEventFilters: { sendOpen: true, sendResolved: true, sendEscalation: true },
      updatedAt: new Date(),
    }
    await pool.query(
      `INSERT INTO ${this.dbPrefix}notification_preferences
         (id, default_severity_filter, default_event_filters, updated_at)
       VALUES ('global', $1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [seed.defaultSeverityFilter, JSON.stringify(seed.defaultEventFilters), seed.updatedAt],
    )
    return seed
  }

  async updateNotificationPreferences(
    changes: Partial<Omit<NotificationPreferencesDoc, 'id'>>,
  ): Promise<NotificationPreferencesDoc> {
    const pool = this.getRequiredPool()
    // Ensure the row exists so UPDATE has something to target.
    await this.getNotificationPreferences()

    const frags: string[] = []
    const params: unknown[] = []
    if (changes.globalMuteUntil !== undefined) {
      params.push(changes.globalMuteUntil)
      frags.push(`global_mute_until = $${params.length}`)
    }
    if (changes.defaultSeverityFilter !== undefined) {
      params.push(changes.defaultSeverityFilter)
      frags.push(`default_severity_filter = $${params.length}`)
    }
    if (changes.defaultEventFilters !== undefined) {
      params.push(JSON.stringify(changes.defaultEventFilters))
      frags.push(`default_event_filters = $${params.length}`)
    }
    if (changes.lastEditedBy !== undefined) {
      params.push(changes.lastEditedBy)
      frags.push(`last_edited_by = $${params.length}`)
    }
    frags.push(`updated_at = now()`)
    const { rows } = await pool.query(
      `UPDATE ${this.dbPrefix}notification_preferences SET ${frags.join(', ')} WHERE id='global' RETURNING *`,
      params,
    )
    return rows[0] ? rowToPreferences(rows[0]) : this.getNotificationPreferences()
  }

  // ---------------------------------------------------------------------------
  // Aggregation write API
  // ---------------------------------------------------------------------------

  async getChecksInHour(endpointId: string, hourStart: Date, hourEnd: Date): Promise<CheckDoc[]> {
    if (!this.pool) return []
    assertUuid(endpointId, 'endpointId')
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}checks
       WHERE endpoint_id=$1 AND timestamp >= $2 AND timestamp < $3
       ORDER BY timestamp ASC`,
      [endpointId, hourStart, hourEnd],
    )
    return rows.map(rowToCheck)
  }

  async upsertHourlySummary(
    summary: Omit<HourlySummaryDoc, 'id' | 'createdAt'>,
  ): Promise<void> {
    const pool = this.getRequiredPool()
    assertUuid(summary.endpointId, 'endpointId')
    await pool.query(
      `INSERT INTO ${this.dbPrefix}hourly_summaries (
         id, endpoint_id, hour, total_checks, success_count, fail_count,
         degraded_count, uptime_percent, avg_response_time, min_response_time,
         max_response_time, p95_response_time, p99_response_time, error_types,
         had_active_incident, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (endpoint_id, hour) DO UPDATE SET
         total_checks=EXCLUDED.total_checks,
         success_count=EXCLUDED.success_count,
         fail_count=EXCLUDED.fail_count,
         degraded_count=EXCLUDED.degraded_count,
         uptime_percent=EXCLUDED.uptime_percent,
         avg_response_time=EXCLUDED.avg_response_time,
         min_response_time=EXCLUDED.min_response_time,
         max_response_time=EXCLUDED.max_response_time,
         p95_response_time=EXCLUDED.p95_response_time,
         p99_response_time=EXCLUDED.p99_response_time,
         error_types=EXCLUDED.error_types,
         had_active_incident=EXCLUDED.had_active_incident`,
      [
        newId(),
        summary.endpointId,
        summary.hour,
        summary.totalChecks,
        summary.successCount,
        summary.failCount,
        summary.degradedCount,
        summary.uptimePercent,
        summary.avgResponseTime,
        summary.minResponseTime,
        summary.maxResponseTime,
        summary.p95ResponseTime,
        summary.p99ResponseTime,
        JSON.stringify(summary.errorTypes),
        summary.hadActiveIncident,
      ],
    )
  }

  async upsertDailySummary(
    summary: Omit<DailySummaryDoc, 'id' | 'createdAt'>,
  ): Promise<void> {
    const pool = this.getRequiredPool()
    assertUuid(summary.endpointId, 'endpointId')
    await pool.query(
      `INSERT INTO ${this.dbPrefix}daily_summaries (
         id, endpoint_id, date, total_checks, uptime_percent, avg_response_time,
         min_response_time, max_response_time, p95_response_time, p99_response_time,
         incident_count, total_downtime_minutes, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (endpoint_id, date) DO UPDATE SET
         total_checks=EXCLUDED.total_checks,
         uptime_percent=EXCLUDED.uptime_percent,
         avg_response_time=EXCLUDED.avg_response_time,
         min_response_time=EXCLUDED.min_response_time,
         max_response_time=EXCLUDED.max_response_time,
         p95_response_time=EXCLUDED.p95_response_time,
         p99_response_time=EXCLUDED.p99_response_time,
         incident_count=EXCLUDED.incident_count,
         total_downtime_minutes=EXCLUDED.total_downtime_minutes`,
      [
        newId(),
        summary.endpointId,
        summary.date,
        summary.totalChecks,
        summary.uptimePercent,
        summary.avgResponseTime,
        summary.minResponseTime,
        summary.maxResponseTime,
        summary.p95ResponseTime,
        summary.p99ResponseTime,
        summary.incidentCount,
        summary.totalDowntimeMinutes,
      ],
    )
  }

  async deleteHourlySummariesBefore(before: Date): Promise<number> {
    const pool = this.getRequiredPool()
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.dbPrefix}hourly_summaries WHERE hour < $1`,
      [before],
    )
    return rowCount ?? 0
  }

  async deleteDailySummariesBefore(before: Date): Promise<number> {
    const pool = this.getRequiredPool()
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.dbPrefix}daily_summaries WHERE date < $1`,
      [before],
    )
    return rowCount ?? 0
  }

  async getEndpointIdsWithChecks(from: Date, to: Date): Promise<string[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query<{ endpoint_id: string }>(
      `SELECT DISTINCT endpoint_id FROM ${this.dbPrefix}checks
       WHERE timestamp >= $1 AND timestamp < $2`,
      [from, to],
    )
    return rows.map((r) => r.endpoint_id)
  }

  // ---------------------------------------------------------------------------
  // Settings API
  // ---------------------------------------------------------------------------

  async getSettings(): Promise<SettingsDoc> {
    const pool = this.getRequiredPool()
    const { rows } = await pool.query(
      `SELECT * FROM ${this.dbPrefix}settings WHERE id='global'`,
    )
    if (rows[0]) return rowToSettings(rows[0])
    await pool.query(
      `INSERT INTO ${this.dbPrefix}settings (id) VALUES ('global') ON CONFLICT (id) DO NOTHING`,
    )
    return { id: 'global' }
  }

  async updateSettings(changes: Record<string, unknown>): Promise<SettingsDoc> {
    const pool = this.getRequiredPool()
    // Split known top-level keys from the arbitrary rest bucket.
    const { id: _id, defaults, slo, ...rest } = changes
    void _id
    await this.getSettings()

    const frags: string[] = []
    const params: unknown[] = []
    if (defaults !== undefined) {
      params.push(defaults ? JSON.stringify(defaults) : null)
      frags.push(`defaults = $${params.length}`)
    }
    if (slo !== undefined) {
      params.push(slo ? JSON.stringify(slo) : null)
      frags.push(`slo = $${params.length}`)
    }
    if (Object.keys(rest).length > 0) {
      params.push(JSON.stringify(rest))
      frags.push(`extra = COALESCE(extra, '{}'::jsonb) || $${params.length}::jsonb`)
    }
    if (frags.length === 0) return this.getSettings()

    const { rows } = await pool.query(
      `UPDATE ${this.dbPrefix}settings SET ${frags.join(', ')} WHERE id='global' RETURNING *`,
      params,
    )
    return rows[0] ? rowToSettings(rows[0]) : this.getSettings()
  }

  async hardReset(): Promise<Record<string, number>> {
    const pool = this.getRequiredPool()
    const tables = [
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
    ]
    const counts: Record<string, number> = {}
    // Snapshot counts first — TRUNCATE returns nothing.
    for (const t of tables) {
      const { rows } = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ${this.dbPrefix}${t}`,
      )
      counts[t] = Number(rows[0]?.c ?? 0)
    }
    const qualified = tables.map((t) => `${this.dbPrefix}${t}`).join(', ')
    await pool.query(`TRUNCATE ${qualified} CASCADE`)
    return counts
  }

  // ---------------------------------------------------------------------------
  // Health persistence
  // ---------------------------------------------------------------------------

  async saveHealthState(state: Omit<HealthStateDoc, 'id'>): Promise<void> {
    const pool = this.getRequiredPool()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}health_state (id, saved_at, probe_history, heatmap)
       VALUES ('snapshot', $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         saved_at=EXCLUDED.saved_at,
         probe_history=EXCLUDED.probe_history,
         heatmap=EXCLUDED.heatmap`,
      [state.savedAt, JSON.stringify(state.probeHistory), JSON.stringify(state.heatmap)],
    )
  }

  async loadHealthState(): Promise<HealthStateDoc | null> {
    if (!this.pool) return null
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}health_state WHERE id='snapshot'`,
    )
    return rows[0] ? rowToHealthState(rows[0]) : null
  }

  async listInternalIncidents(): Promise<InternalIncidentDoc[]> {
    if (!this.pool) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.dbPrefix}internal_incidents
       ORDER BY started_at DESC LIMIT 500`,
    )
    return rows.map(rowToInternalIncident)
  }

  async upsertInternalIncident(doc: InternalIncidentDoc): Promise<void> {
    const pool = this.getRequiredPool()
    await pool.query(
      `INSERT INTO ${this.dbPrefix}internal_incidents (
         id, subsystem, severity, status, title, cause, started_at, resolved_at,
         duration_seconds, commits, timeline, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         subsystem=EXCLUDED.subsystem,
         severity=EXCLUDED.severity,
         status=EXCLUDED.status,
         title=EXCLUDED.title,
         cause=EXCLUDED.cause,
         started_at=EXCLUDED.started_at,
         resolved_at=EXCLUDED.resolved_at,
         duration_seconds=EXCLUDED.duration_seconds,
         commits=EXCLUDED.commits,
         timeline=EXCLUDED.timeline,
         expires_at=EXCLUDED.expires_at`,
      [
        doc.id,
        doc.subsystem,
        doc.severity,
        doc.status,
        doc.title,
        doc.cause,
        doc.startedAt,
        doc.resolvedAt ?? null,
        doc.durationSeconds ?? null,
        doc.commits,
        JSON.stringify(doc.timeline),
        doc.expiresAt ?? null,
      ],
    )
  }

  // ---------------------------------------------------------------------------
  // Shared pagination helpers
  // ---------------------------------------------------------------------------

  /**
   * Cursor-based pagination, newest-first (ORDER BY id DESC). UUID v7 ids are
   * time-ordered, so cursor comparisons work the same way ObjectId cursors do
   * on the Mongo adapter.
   */
  private async paginateDesc<T>(
    table: string,
    mapper: (r: Row) => T,
    opts: DbPaginationOpts,
    buildWhere: (where: string[], params: unknown[]) => void,
  ): Promise<DbPage<T>> {
    return this.paginate(table, mapper, opts, buildWhere, 'DESC')
  }

  private async paginateAsc<T>(
    table: string,
    mapper: (r: Row) => T,
    opts: DbPaginationOpts,
    buildWhere: (where: string[], params: unknown[]) => void,
  ): Promise<DbPage<T>> {
    return this.paginate(table, mapper, opts, buildWhere, 'ASC')
  }

  private async paginate<T>(
    table: string,
    mapper: (r: Row) => T,
    opts: DbPaginationOpts,
    buildWhere: (where: string[], params: unknown[]) => void,
    direction: 'ASC' | 'DESC',
  ): Promise<DbPage<T>> {
    if (!this.pool) {
      return { items: [], total: 0, hasMore: false, nextCursor: null, prevCursor: null }
    }

    const limit = Math.min(opts.limit ?? 20, 5000)
    const where: string[] = []
    const params: unknown[] = []
    buildWhere(where, params)

    // Snapshot params before cursor mutates them so countDocuments uses the
    // base filter without the cursor restriction.
    const filterParams = [...params]
    const filterWhere = [...where]

    if (opts.cursor) {
      if (!isUuid(opts.cursor)) {
        const err = new Error('Invalid pagination cursor') as Error & {
          statusCode?: number
          code?: string
        }
        err.statusCode = 400
        err.code = 'INVALID_CURSOR'
        throw err
      }
      params.push(opts.cursor)
      where.push(`id ${direction === 'ASC' ? '>' : '<'} $${params.length}`)
    }

    params.push(limit + 1)
    const limitPh = `$${params.length}`
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const filterClause = filterWhere.length ? `WHERE ${filterWhere.join(' AND ')}` : ''

    const itemsP = this.pool.query<Row>(
      `SELECT * FROM ${table} ${clause} ORDER BY id ${direction} LIMIT ${limitPh}`,
      params,
    )
    const totalP = this.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM ${table} ${filterClause}`,
      filterParams,
    )
    const [itemsRes, totalRes] = await Promise.all([itemsP, totalP])

    const raw = itemsRes.rows
    const hasMore = raw.length > limit
    if (hasMore) raw.pop()
    const items = raw.map(mapper)
    const total = Number(totalRes.rows[0]?.c ?? 0)

    return {
      items,
      total,
      hasMore,
      nextCursor: hasMore ? ((raw[raw.length - 1] as Row).id as string) : null,
      prevCursor: raw.length > 0 ? ((raw[0] as Row).id as string) : null,
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * DST-resilient day enumeration, same shape as the Mongo adapter's helper.
 * Duplicated here instead of shared-imported because the mongo file keeps its
 * copy scoped to the adapter module.
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
