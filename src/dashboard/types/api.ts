// Shared API response types used across dashboard pages

export interface ApiEndpoint {
  _id: string
  name: string
  description?: string
  type: 'http' | 'port'
  url?: string
  method?: string
  host?: string
  port?: number
  headers?: Record<string, string>
  expectedStatusCodes?: number[]
  assertions?: Assertion[]
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
  escalationChannelId?: string
  notificationChannelIds: string[]
  /** Subset of `notificationChannelIds` currently paused for this endpoint. */
  pausedNotificationChannelIds?: string[]
  lastCheckAt?: string
  lastStatus?: 'healthy' | 'degraded' | 'down'
  lastResponseTime?: number
  lastStatusCode?: number | null
  lastErrorMessage?: string | null
  lastSslIssuer?: { o?: string; cn?: string; capturedAt: string }
  consecutiveFailures: number
  consecutiveHealthy: number
  createdAt: string
  updatedAt: string
}

export type AssertionKind = 'latency' | 'body' | 'header' | 'json' | 'ssl'
export type AssertionOperator =
  | 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'
  | 'contains' | 'not_contains' | 'equals'
  | 'exists' | 'not_exists'
export type AssertionSeverity = 'down' | 'degraded'

export interface Assertion {
  kind: AssertionKind
  operator: AssertionOperator
  target?: string
  value?: string
  severity: AssertionSeverity
}

export interface AssertionResult {
  index: number
  kind: AssertionKind
  operator: AssertionOperator
  target?: string
  value?: string
  severity: AssertionSeverity
  passed: boolean
  actual?: unknown
  error?: string
}

export interface AssertionEvalResult {
  passed: boolean
  failedSeverity: AssertionSeverity | null
  results: AssertionResult[]
}

export interface ApiCheck {
  _id: string
  endpointId: string
  timestamp: string
  responseTime: number
  statusCode?: number
  status: 'healthy' | 'degraded' | 'down'
  statusReason?: string
  errorMessage?: string
  sslDaysRemaining?: number
  bodyBytes?: number
  bodyBytesTruncated?: boolean
  assertionResult?: AssertionEvalResult
  portOpen?: boolean
  duringMaintenance: boolean
}

export interface IncidentTimelineEvent {
  at: string
  event: string
  detail?: string
}

export interface ApiIncident {
  _id: string
  endpointId: string
  status: 'active' | 'resolved'
  cause: string
  causeDetail?: string
  startedAt: string
  resolvedAt?: string
  durationSeconds?: number
  timeline?: IncidentTimelineEvent[]
  notificationsSent: number
}

export interface ApiPagination {
  limit: number
  hasMore: boolean
  nextCursor: string | null
  prevCursor: string | null
  total: number
}

export interface HourlySummary {
  hour: string
  avgResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  uptimePercent: number
  totalChecks: number
  successCount: number
  failCount: number
  degradedCount: number
}

export interface DailySummary {
  date: string
  avgResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  uptimePercent: number
  totalChecks: number
  incidentCount: number
}

export interface UptimeStats {
  '24h': number | null
  '7d': number | null
  '30d': number | null
  '90d': number | null
}

export type EndpointStatus = 'healthy' | 'degraded' | 'down'

// ---------------------------------------------------------------------------
// Incident stats — pre-aggregated trends for the Incidents page
// ---------------------------------------------------------------------------

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
    notificationsSent: number
  }
  byDay: IncidentStatsDay[]
  byCause: IncidentStatsCause[]
  byEndpoint: IncidentStatsEndpoint[]
  byEndpointDay: IncidentStatsEndpointDay[]
  resolvedDurationsByDay: IncidentStatsMttrDay[]
}
