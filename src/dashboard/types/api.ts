// Shared API response types used across dashboard pages

export interface ApiEndpoint {
  _id: string
  name: string
  type: 'http' | 'port'
  url?: string
  method?: string
  host?: string
  port?: number
  headers?: Record<string, string>
  expectedStatusCodes?: number[]
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
  escalationChannelId?: string
  notificationChannelIds: string[]
  lastCheckAt?: string
  lastStatus?: 'healthy' | 'degraded' | 'down'
  lastResponseTime?: number
  lastStatusCode?: number | null
  lastErrorMessage?: string | null
  lastSslIssuer?: { o?: string; cn?: string; capturedAt: string }
  consecutiveFailures: number
  createdAt: string
  updatedAt: string
}

export interface BodyValidationResult {
  passed: boolean
  results: Array<{ rule?: string; actual?: string; error?: string }>
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
  bodyValidation?: BodyValidationResult
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
