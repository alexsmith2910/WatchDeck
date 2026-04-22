/**
 * Client-side shapes for the /notifications API surface.
 *
 * These mirror `src/storage/types.ts` but with:
 *  - ObjectId fields serialized as strings
 *  - Dates serialized as ISO strings
 */

export type ChannelType = 'discord' | 'slack' | 'email' | 'webhook'
export type DeliveryPriority = 'standard' | 'critical'
export type SeverityFilter = 'info+' | 'warning+' | 'critical'
export type NotificationSeverity = 'info' | 'warning' | 'critical' | 'success'
export type NotificationKind =
  | 'incident_opened'
  | 'incident_resolved'
  | 'incident_escalated'
  | 'channel_test'
  | 'custom'
export type DeliveryStatus = 'sent' | 'failed' | 'pending' | 'suppressed'
export type SuppressedReason =
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

export interface QuietHours {
  start: string
  end: string
  tz: string
}

export interface EventFilters {
  sendOpen: boolean
  sendResolved: boolean
  sendEscalation: boolean
}

export interface ApiChannel {
  _id: string
  type: ChannelType
  name: string
  deliveryPriority: DeliveryPriority
  enabled: boolean
  severityFilter: SeverityFilter
  eventFilters: EventFilters
  quietHours?: QuietHours | null
  rateLimit?: { maxPerMinute: number } | null
  retryOnFailure: boolean
  metadata?: Record<string, unknown> | null

  discordTransport?: 'webhook' | 'bot'
  discordWebhookUrl?: string
  discordChannelId?: string
  discordGuildId?: string
  discordUsername?: string
  discordAvatarUrl?: string

  slackWebhookUrl?: string
  slackChannelId?: string
  slackWorkspaceName?: string

  emailEndpoint?: string
  emailRecipients?: string[]

  webhookUrl?: string
  webhookMethod?: 'POST' | 'PUT' | 'PATCH'
  webhookHeaders?: Record<string, string>
  webhookBodyTemplate?: string

  isConnected: boolean
  lastTestedAt?: string
  lastSuccessAt?: string
  lastFailureAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiNotificationLogPayload {
  title: string
  summary: string
  markdown?: string
  fields?: Array<{ label: string; value: string }>
}

export interface ApiNotificationLogRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export interface ApiNotificationLogResponse {
  statusCode?: number
  bodyExcerpt?: string
  providerId?: string
  url?: string
}

export interface ApiNotificationLogRow {
  _id: string
  endpointId?: string
  incidentId?: string
  channelId: string
  channelType: ChannelType
  channelTarget: string
  messageSummary: string
  severity: NotificationSeverity
  kind: NotificationKind
  deliveryStatus: DeliveryStatus
  failureReason?: string
  suppressedReason?: SuppressedReason
  latencyMs?: number
  idempotencyKey?: string
  retryOf?: string
  coalescedIntoLogId?: string
  coalescedCount?: number
  coalescedIncidentIds?: string[]
  /** Snapshot of the channel-agnostic message the provider rendered. */
  payload?: ApiNotificationLogPayload
  /** Outbound HTTP request made by the provider, with secrets redacted. */
  request?: ApiNotificationLogRequest
  /** Provider response (status, body excerpt, provider-assigned id). */
  response?: ApiNotificationLogResponse
  sentAt: string
  createdAt: string
}

export interface ApiNotificationStats {
  total: number
  sent: number
  failed: number
  suppressed: number
  pending: number
  byChannel: Array<{ channelId: string; sent: number; failed: number; suppressed: number }>
  bySuppressedReason: Record<string, number>
  byKind: Record<NotificationKind, number>
  lastDispatchAt: string | null
  lastFailureAt: string | null
}

export interface ApiNotificationMute {
  _id: string
  scope: 'endpoint' | 'channel' | 'global'
  targetId?: string
  mutedBy: string
  mutedAt: string
  expiresAt: string
  reason?: string
}

export interface ApiNotificationPreferences {
  _id: 'global'
  globalQuietHours?: QuietHours | null
  globalMuteUntil?: string | null
  defaultSeverityFilter: SeverityFilter
  defaultEventFilters: EventFilters
  digestMode?: { enabled: boolean; intervalMinutes: number } | null
  lastEditedBy?: string
  updatedAt: string
}

export interface ApiScheduledEscalation {
  incidentId: string
  endpointId: string
  channelId: string
  firesAt: string
}

export const CHANNEL_TYPE_ICON: Record<ChannelType, string> = {
  discord: 'logos:discord-icon',
  slack:   'logos:slack-icon',
  email:   'solar:letter-bold',
  webhook: 'solar:code-square-bold',
}

export const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
  discord: 'Discord',
  slack:   'Slack',
  email:   'Email',
  webhook: 'Webhook',
}

export const KIND_LABEL: Record<NotificationKind, string> = {
  incident_opened:    'Opened',
  incident_resolved:  'Resolved',
  incident_escalated: 'Escalation',
  channel_test:       'Test',
  custom:             'Custom',
}

export const KIND_COLOR: Record<NotificationKind, string> = {
  incident_opened:    'text-wd-danger',
  incident_resolved:  'text-wd-success',
  incident_escalated: 'text-wd-warning',
  channel_test:       'text-wd-primary',
  custom:             'text-wd-muted',
}

export const STATUS_STYLE: Record<DeliveryStatus, { label: string; className: string }> = {
  sent:       { label: 'Sent',       className: 'bg-wd-success/15 text-wd-success' },
  failed:     { label: 'Failed',     className: 'bg-wd-danger/15 text-wd-danger' },
  pending:    { label: 'Pending',    className: 'bg-wd-muted/20 text-wd-muted' },
  suppressed: { label: 'Suppressed', className: 'bg-wd-warning/15 text-wd-warning' },
}

export const SEVERITY_STYLE: Record<NotificationSeverity, string> = {
  info:     'bg-wd-primary',
  success:  'bg-wd-success',
  warning:  'bg-wd-warning',
  critical: 'bg-wd-danger',
}
