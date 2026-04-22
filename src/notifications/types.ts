/**
 * Notification module — shared types.
 *
 * `NotificationMessage` is the channel-agnostic bundle handed to every provider
 * (Discord / Slack / email / webhook); each provider renders its own payload
 * from it. See `notifications-plan.md` §1.4 for the full contract.
 */

import type {
  NotificationChannelDoc,
  NotificationKind,
  NotificationSeverity,
  NotificationSuppressedReason,
} from '../storage/types.js'

export interface NotificationMessageLink {
  label: string
  href: string
}

export interface NotificationMessageField {
  label: string
  value: string
}

export interface NotificationMessageEndpoint {
  id: string
  name: string
  url: string | null
}

export interface NotificationMessageIncident {
  id: string
  startedAt: Date
  status: 'active' | 'resolved'
}

/**
 * Channel-agnostic message bundle. Providers consume this to build their
 * payload. The same bundle can target many channels at once.
 */
export interface NotificationMessage {
  kind: NotificationKind
  severity: NotificationSeverity
  title: string
  summary: string
  detail?: string
  endpoint?: NotificationMessageEndpoint
  incident?: NotificationMessageIncident
  link: string
  fields?: NotificationMessageField[]
  tags?: string[]
  actor?: string
  /** Incident id + kind — providers use this to dedupe at their own layer. */
  idempotencyKey: string
}

/** Outbound HTTP request captured at dispatch time (already redacted). */
export interface ProviderRequestCapture {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

/** Provider response captured at dispatch time. */
export interface ProviderResponseCapture {
  statusCode?: number
  bodyExcerpt?: string
  providerId?: string
  url?: string
}

/** Result returned by a provider's `send()` / `test()`. */
export interface ProviderResult {
  status: 'sent' | 'failed' | 'skipped'
  latencyMs: number
  deliveryId?: string
  failureReason?: string
  providerMeta?: Record<string, unknown>
  /** Set by providers that make HTTP requests — already redacted + truncated. */
  request?: ProviderRequestCapture
  /** Set by providers that make HTTP requests — already truncated. */
  response?: ProviderResponseCapture
}

/** Minimal validation return for a provider's pre-flight check. */
export interface ValidationResult {
  valid: boolean
  error?: string
}

/** The routing target handed to a provider — just the channel doc itself. */
export type ChannelTarget = NotificationChannelDoc

/**
 * A dispatch attempt resolved to one specific channel. Built by the
 * dispatcher immediately before calling a provider, and written to
 * `mx_notification_log` regardless of outcome (sent / failed / suppressed).
 */
export interface ResolvedDispatch {
  channelId: string
  channel: ChannelTarget
  message: NotificationMessage
  /** Seconds to wait before another dispatch for this endpoint+channel+kind. */
  cooldownSeconds?: number
  /** Current retry attempt (0 = first attempt). */
  retryAttempt?: number
  retryOfLogId?: string
  /**
   * Set on `incident_resolved` dispatches once we've confirmed the channel
   * actually received the corresponding `incident_opened` (or escalation).
   * The gate layer skips cooldown + severity-filter checks when this is
   * true so a recovery message can never be quietly suppressed after the
   * matching alert went out.
   */
  bypassResolvedGates?: boolean
}

/** Why a pre-dispatch gate rejected the attempt — maps 1:1 to log reasons. */
export type DispatchSuppression = {
  reason: NotificationSuppressedReason
  detail?: string
}
