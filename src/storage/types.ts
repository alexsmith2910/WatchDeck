import type { ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface DbPaginationOpts {
  /** ObjectId hex string — return items before (or after, depending on sort) this cursor. */
  cursor?: string
  /** Page size. Capped at 100 server-side. Defaults to 20. */
  limit?: number
}

export interface DbPage<T> {
  items: T[]
  /** Total matching documents (without cursor filter). */
  total: number
  hasMore: boolean
  /** Cursor for the next page (last item's _id), or null if no next page. */
  nextCursor: string | null
  /** Cursor pointing at the first item in this page, or null if empty. */
  prevCursor: string | null
}

// ---------------------------------------------------------------------------
// Buffer pipeline types
// ---------------------------------------------------------------------------

/**
 * Shape stored in the check buffer and accepted by StorageAdapter.saveCheck().
 * timestamp is Date | string because disk-serialised entries arrive as strings
 * after JSON.parse — the adapter normalises it before writing to MongoDB.
 */
export interface CheckWritePayload {
  timestamp: Date | string
  endpointId: string
  status: 'healthy' | 'degraded' | 'down'
  responseTime: number
  statusCode: number | null
  errorMessage: string | null
  sslDaysRemaining: number | null
  bodyBytes?: number | null
  bodyBytesTruncated?: boolean
}

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface BodyRule {
  type: 'contains' | 'not_contains' | 'json_path'
  value: string
  /** JSONPath expression — only used when type is json_path */
  path?: string
  /** Expected value for json_path comparisons */
  expected?: unknown
}

export interface BodyValidationResult {
  passed: boolean
  results: Array<{
    rule: BodyRule
    passed: boolean
    actual?: unknown
    error?: string
  }>
}

export interface MaintenanceWindow {
  _id: ObjectId
  startTime: Date
  endTime: Date
  reason: string
}

export interface IncidentTimelineEvent {
  at: Date
  event: string
  detail?: string
}

// ---------------------------------------------------------------------------
// mx_endpoints
// ---------------------------------------------------------------------------

export interface EndpointDoc {
  _id: ObjectId
  name: string
  type: 'http' | 'port'

  // HTTP fields
  url?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  expectedStatusCodes?: number[]
  bodyRules?: BodyRule[]

  // Port fields
  host?: string
  port?: number

  // Shared check config
  checkInterval: number
  timeout: number
  enabled: boolean
  status: 'active' | 'paused' | 'archived'
  latencyThreshold: number
  sslWarningDays: number
  failureThreshold: number
  alertCooldown: number
  recoveryAlert: boolean
  escalationDelay: number
  escalationChannelId?: ObjectId
  notificationChannelIds: ObjectId[]
  maintenanceWindows: MaintenanceWindow[]

  // Runtime state
  lastCheckAt?: Date
  lastStatus?: 'healthy' | 'degraded' | 'down'
  lastResponseTime?: number
  lastStatusCode?: number | null
  lastErrorMessage?: string | null
  /** Last-seen TLS issuer for this endpoint. Refreshed per-endpoint (not per-check). */
  lastSslIssuer?: { o?: string; cn?: string; capturedAt: Date }
  currentIncidentId?: ObjectId
  consecutiveFailures: number

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_checks
// ---------------------------------------------------------------------------

export interface CheckDoc {
  _id: ObjectId
  endpointId: ObjectId
  timestamp: Date

  // Always present — failed checks record actual elapsed time, never null
  responseTime: number

  // HTTP-specific
  statusCode?: number
  sslDaysRemaining?: number
  /** Size of the response body in bytes, when body-size capture is enabled. */
  bodyBytes?: number
  /** True when the body read was capped at `config.maxBodyBytesToRead`. */
  bodyBytesTruncated?: boolean
  bodyValidation?: BodyValidationResult

  // Port-specific
  portOpen?: boolean

  status: 'healthy' | 'degraded' | 'down'
  statusReason?: string
  errorMessage?: string
  duringMaintenance: boolean

  createdAt: Date
}

// ---------------------------------------------------------------------------
// mx_hourly_summaries
// ---------------------------------------------------------------------------

export interface HourlySummaryDoc {
  _id: ObjectId
  endpointId: ObjectId
  /** UTC hour bucket — truncated to the hour (e.g. 2024-01-15T14:00:00Z) */
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
  /** Counts of each error type seen in this hour */
  errorTypes: Record<string, number>
  hadActiveIncident: boolean

  createdAt: Date
}

// ---------------------------------------------------------------------------
// mx_daily_summaries
// ---------------------------------------------------------------------------

export interface DailySummaryDoc {
  _id: ObjectId
  endpointId: ObjectId
  /** UTC date bucket — truncated to midnight (e.g. 2024-01-15T00:00:00Z) */
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

// ---------------------------------------------------------------------------
// mx_incidents
// ---------------------------------------------------------------------------

export interface IncidentDoc {
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

// ---------------------------------------------------------------------------
// mx_notification_channels
// ---------------------------------------------------------------------------

export type NotificationChannelType = 'discord' | 'slack' | 'email' | 'webhook'

export type NotificationSeverityFilter = 'info+' | 'warning+' | 'critical'

export interface NotificationEventFilters {
  sendOpen: boolean
  sendResolved: boolean
  sendEscalation: boolean
}

export interface NotificationQuietHours {
  /** "HH:MM" 24-hour local start time */
  start: string
  /** "HH:MM" 24-hour local end time (may cross midnight: e.g. "22:00"–"06:00") */
  end: string
  /** IANA timezone name, e.g. "Europe/London" */
  tz: string
}

export interface NotificationChannelDoc {
  _id: ObjectId
  type: NotificationChannelType
  name: string
  deliveryPriority: 'standard' | 'critical'

  /** Soft-disable without deleting. Defaults to true on create. */
  enabled: boolean

  /** Only emit dispatches for events at or above this severity threshold. */
  severityFilter: NotificationSeverityFilter

  /** Which lifecycle events this channel should receive. */
  eventFilters: NotificationEventFilters

  /** Optional quiet hours window that suppresses non-critical dispatches. */
  quietHours?: NotificationQuietHours

  /** Per-channel rate limit override (otherwise the type default applies). */
  rateLimit?: { maxPerMinute: number }

  /** If true, failed dispatches are retried per the global backoff schedule. */
  retryOnFailure: boolean

  /** Free-form channel metadata (color accent, routing tags, etc.). */
  metadata?: Record<string, unknown>

  // Discord
  /**
   * Which Discord transport this channel uses. `webhook` is the default and
   * only transport with an implementation today — `bot` is reserved for a
   * future PR (see src/notifications/providers/discord/bot.ts).
   */
  discordTransport?: 'webhook' | 'bot'
  discordWebhookUrl?: string
  discordChannelId?: string
  discordGuildId?: string
  /** Optional override for the author name shown in Discord. */
  discordUsername?: string
  /** Optional override for the author avatar shown in Discord. */
  discordAvatarUrl?: string

  // Slack
  slackWebhookUrl?: string
  slackChannelId?: string
  slackWorkspaceName?: string

  // Email
  emailEndpoint?: string
  emailRecipients?: string[]

  // Webhook (generic POST-JSON)
  webhookUrl?: string
  webhookMethod?: 'POST' | 'PUT' | 'PATCH'
  webhookHeaders?: Record<string, string>
  webhookBodyTemplate?: string

  /**
   * Reflects the outcome of the most recent send attempt (test, real alert,
   * coalesced summary, or retry). True while deliveries are succeeding, flips
   * to false on the first failure. Used by the dashboard to distinguish a
   * "failing" channel (connection broken) from a "degraded" one (connection
   * works but some attempts are slow or failing).
   */
  isConnected: boolean
  lastTestedAt?: Date
  /** Timestamp of the most recent successful send (any kind). */
  lastSuccessAt?: Date
  /** Timestamp of the most recent failed send (any kind). */
  lastFailureAt?: Date

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_notification_log
// ---------------------------------------------------------------------------

export type NotificationKind =
  | 'incident_opened'
  | 'incident_resolved'
  | 'incident_escalated'
  | 'channel_test'
  | 'custom'

export type NotificationSeverity = 'info' | 'warning' | 'critical' | 'success'

export type NotificationDeliveryStatus = 'sent' | 'failed' | 'pending' | 'suppressed'

export type NotificationSuppressedReason =
  | 'cooldown'
  | 'quiet_hours'
  | 'maintenance'
  | 'severity_filter'
  | 'event_filter'
  | 'rate_limit'
  | 'module_disabled'
  | 'coalesced'
  | 'muted'
  | 'channel_disabled'

export interface NotificationLogDoc {
  _id: ObjectId
  /** Optional — absent on global suppressions and channel tests. */
  endpointId?: ObjectId
  /** Optional — absent on channel tests and coalescing-parent summaries. */
  incidentId?: ObjectId
  channelId: ObjectId
  /** Deprecated short label — use `kind` going forward. Kept for back-compat. */
  type: string
  channelType: NotificationChannelType
  channelTarget: string
  messageSummary: string

  /** Severity of the underlying alert. */
  severity: NotificationSeverity
  /** What event produced this dispatch. */
  kind: NotificationKind

  deliveryStatus: NotificationDeliveryStatus
  failureReason?: string
  /** Outcome reason when deliveryStatus === 'suppressed'. */
  suppressedReason?: NotificationSuppressedReason

  /** Round-trip latency of the provider call, when one was made. */
  latencyMs?: number
  /** Stable key used for dedup (incidentId + kind). */
  idempotencyKey?: string
  /** If set, this row is a retry attempt of the referenced log row. */
  retryOf?: ObjectId

  /** Set on individual rows that were folded into a coalescing-parent summary. */
  coalescedIntoLogId?: ObjectId
  /** Set on the coalescing-parent summary row: number of alerts it represents. */
  coalescedCount?: number
  /** Incident ids represented by a coalescing-parent summary row. */
  coalescedIncidentIds?: ObjectId[]

  sentAt: Date
  createdAt: Date
}

// ---------------------------------------------------------------------------
// mx_notification_mutes  — temporary muting (e.g. during a deploy)
// ---------------------------------------------------------------------------

export interface NotificationMuteDoc {
  _id: ObjectId
  scope: 'endpoint' | 'channel' | 'global'
  /** Required when scope is 'endpoint' or 'channel'. */
  targetId?: ObjectId
  mutedBy: string
  mutedAt: Date
  /** TTL index on this field drops the doc once it's reached. */
  expiresAt: Date
  reason?: string
}

// ---------------------------------------------------------------------------
// mx_notification_preferences  — single document, _id = "global"
// ---------------------------------------------------------------------------

export interface NotificationPreferencesDoc {
  _id: 'global'
  globalQuietHours?: NotificationQuietHours
  /** If set and in the future, all dispatches are suppressed until this time. */
  globalMuteUntil?: Date
  defaultSeverityFilter: NotificationSeverityFilter
  defaultEventFilters: NotificationEventFilters
  /** Preview-only in V1; full batching lands in V1.5. */
  digestMode?: { enabled: boolean; intervalMinutes: number }
  lastEditedBy?: string
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_settings  (single document, _id = "global")
// ---------------------------------------------------------------------------

export interface SettingsDoc {
  _id: 'global'
  /** Any runtime-adjustable settings stored as key-value pairs */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// mx_system_events
// ---------------------------------------------------------------------------

export interface SystemEventTimelineEntry {
  at: Date
  event: string
  detail?: string
}

export interface SystemEventDoc {
  _id: ObjectId
  type: 'db_outage'
  startedAt: Date
  resolvedAt?: Date
  durationSeconds?: number
  reconnectAttempts: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  cause: string
  causeDetail?: string
  bufferedToMemory: number
  bufferedToDisk: number
  replayStatus: 'pending' | 'running' | 'complete' | 'failed' | 'none'
  replayedCount: number
  replayErrors: number
  timeline: SystemEventTimelineEntry[]
}

// ---------------------------------------------------------------------------
// mx_health_state  (single document, _id = "snapshot")
//
// Persisted by HealthPersistence every ~30s and on shutdown so the System
// Health page can show 24h-of-context after a process restart instead of
// re-accumulating from zero.
// ---------------------------------------------------------------------------

export interface HealthHistoryEntryDoc {
  ts: number
  status: 'healthy' | 'degraded' | 'down' | 'standby' | 'disabled'
  latencyMs: number | null
}

export interface HealthHeatmapBucketDoc {
  count: number
  degraded: number
  down: number
}

export interface HealthHeatmapRowDoc {
  /** Epoch ms of the leftmost bucket (UTC hour-aligned). */
  startMs: number
  buckets: HealthHeatmapBucketDoc[]
}

export interface HealthStateDoc {
  _id: 'snapshot'
  savedAt: Date
  /** Last ≤30 minutes of probe completions per subsystem. */
  probeHistory: Record<string, HealthHistoryEntryDoc[]>
  /** 24 × 1-hour buckets per subsystem for the activity heatmap. */
  heatmap: Record<string, HealthHeatmapRowDoc>
}

// ---------------------------------------------------------------------------
// mx_internal_incidents  — system-plane incident history.
//
// `_id` is the synthesized id from the in-memory tracker (e.g. "ii-7") so
// upserts replace cleanly. `expiresAt` is set when an incident resolves;
// a TTL index drops the doc 24h later.
// ---------------------------------------------------------------------------

export interface InternalIncidentTimelineEntryDoc {
  at: Date
  event: string
  detail?: string
}

export interface InternalIncidentDoc {
  _id: string
  subsystem: string
  severity: 'p1' | 'p2' | 'p3'
  status: 'active' | 'resolved'
  title: string
  cause: string
  startedAt: Date
  resolvedAt?: Date
  durationSeconds?: number
  commits: number
  timeline: InternalIncidentTimelineEntryDoc[]
  /** Set on resolve; TTL index drops the doc when reached. */
  expiresAt?: Date
}
