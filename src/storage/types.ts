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
  acknowledgedAt?: Date
  acknowledgedBy?: string

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_notification_channels
// ---------------------------------------------------------------------------

export interface NotificationChannelDoc {
  _id: ObjectId
  type: 'discord' | 'slack' | 'email'
  name: string
  deliveryPriority: 'standard' | 'critical'

  // Discord
  discordWebhookUrl?: string
  discordChannelId?: string
  discordGuildId?: string

  // Slack
  slackWebhookUrl?: string
  slackChannelId?: string
  slackWorkspaceName?: string

  // Email
  emailEndpoint?: string
  emailRecipients?: string[]

  isConnected: boolean
  lastTestedAt?: Date

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// mx_notification_log
// ---------------------------------------------------------------------------

export interface NotificationLogDoc {
  _id: ObjectId
  endpointId: ObjectId
  incidentId: ObjectId
  channelId: ObjectId
  type: string
  channelType: 'discord' | 'slack' | 'email'
  channelTarget: string
  messageSummary: string
  deliveryStatus: 'sent' | 'failed' | 'pending'
  failureReason?: string
  sentAt: Date

  createdAt: Date
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
