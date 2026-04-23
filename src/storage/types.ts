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
  assertionResult?: AssertionEvalResult
}

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/**
 * Per-endpoint assertion rule. Configured in the dashboard's Assertions tab,
 * evaluated by `assertionsEval.ts` after the status-code gate. See that file
 * for operator semantics and the kind → operator matrix.
 */
export type AssertionKind = 'latency' | 'body' | 'header' | 'json' | 'ssl'

export type AssertionOperator =
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'exists'
  | 'not_exists'

export type AssertionSeverity = 'down' | 'degraded'

export interface Assertion {
  kind: AssertionKind
  operator: AssertionOperator
  /** Header name (kind=header) or dotted JSON path (kind=json). */
  target?: string
  /** Comparison value as a string. Omitted for exists / not_exists. */
  value?: string
  severity: AssertionSeverity
}

export interface AssertionResult {
  /** Position of this rule in endpoint.assertions at evaluation time. */
  index: number
  kind: AssertionKind
  operator: AssertionOperator
  target?: string
  value?: string
  severity: AssertionSeverity
  passed: boolean
  /** The value the rule was compared against, coerced for display. */
  actual?: unknown
  /** Populated when the rule couldn't evaluate cleanly (body not JSON, etc). */
  error?: string
}

export interface AssertionEvalResult {
  /** True only when every rule passed. */
  passed: boolean
  /** Worst severity among failed rules, null when all passed. */
  failedSeverity: AssertionSeverity | null
  results: AssertionResult[]
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
  /** Free-text notes. Shown on the General tab. Not used by any evaluator. */
  description?: string
  type: 'http' | 'port'

  // HTTP fields
  url?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  expectedStatusCodes?: number[]
  /** Ordered list of extra checks run after the status-code gate. Max 10 per endpoint. */
  assertions?: Assertion[]

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
  /**
   * Subset of `notificationChannelIds` that this endpoint is temporarily not
   * dispatching to. The channel doc itself remains enabled and still serves
   * other endpoints — this is a per-endpoint pause, not a channel-wide mute.
   * Dispatcher skips these in fan-out; they're still listed in the Routes UI.
   */
  pausedNotificationChannelIds?: ObjectId[]
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
  assertionResult?: AssertionEvalResult

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
  | 'recovery_disabled'
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

  /**
   * Rendered NotificationMessage slice the provider was asked to format.
   * Captured at dispatch time so the UI can show what *was* sent even after
   * later template changes. Nulled out by the 30d retention sweep.
   */
  payload?: NotificationLogPayload
  /**
   * Outbound HTTP request the provider made. Secrets redacted at write time
   * via `src/notifications/redact.ts`. Nulled out by the 30d retention sweep.
   */
  request?: NotificationLogRequest
  /** Provider response captured at dispatch time. Nulled out by the 30d retention sweep. */
  response?: NotificationLogResponse

  sentAt: Date
  createdAt: Date
}

export interface NotificationLogPayload {
  title: string
  summary: string
  /** Optional markdown/plaintext blob (truncated to ~1KB). */
  markdown?: string
  fields?: Array<{ label: string; value: string }>
}

export interface NotificationLogRequest {
  method: string
  /** URL with any embedded credentials replaced by `***`. */
  url: string
  /** Header map with sensitive values replaced by `***`. */
  headers: Record<string, string>
  /** Request body (truncated to ~4KB). */
  body?: string
}

export interface NotificationLogResponse {
  statusCode?: number
  /** Response body sample (truncated to ~2KB). */
  bodyExcerpt?: string
  /** Provider-assigned id (Discord message id, Slack ts, …). */
  providerId?: string
  /** URL the response came from — useful when the provider follows redirects. */
  url?: string
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
  /** If set and in the future, all dispatches are suppressed until this time. */
  globalMuteUntil?: Date
  /** Applied to new channels at creation time unless the request overrides it. */
  defaultSeverityFilter: NotificationSeverityFilter
  /** Applied to new channels at creation time unless the request overrides it. */
  defaultEventFilters: NotificationEventFilters
  lastEditedBy?: string
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_settings  (single document, _id = "global")
// ---------------------------------------------------------------------------

/**
 * Runtime overrides for fields that live in `watchdeck.config.js`. When set,
 * these take precedence over `ctx.config.defaults.*` / `ctx.config.slo.*` for
 * any consumer that reads through `adapter.getEffectiveDefaults()` / `...Slo()`.
 *
 * Only the ergonomic, per-endpoint-inherited fields and the SLO knobs are
 * editable at runtime — the notification sub-tree under `defaults.notifications`
 * keeps its own dedicated surface (`mx_notification_preferences`).
 */
export interface SettingsDefaultsOverride {
  checkInterval?: number
  timeout?: number
  expectedStatusCodes?: number[]
  latencyThreshold?: number
  sslWarningDays?: number
  failureThreshold?: number
  alertCooldown?: number
  recoveryAlert?: boolean
  escalationDelay?: number
}

export interface SettingsSloOverride {
  target?: number
  windowDays?: number
}

export interface SettingsDoc {
  _id: 'global'
  /** Runtime override for the per-endpoint defaults. */
  defaults?: SettingsDefaultsOverride
  /** Runtime override for the global SLO. */
  slo?: SettingsSloOverride
  /** Any additional runtime-adjustable settings. */
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
