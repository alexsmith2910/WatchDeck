/**
 * NotificationDispatcher — the notifications module's core orchestrator.
 *
 * Subscribes to `incident:opened` / `incident:resolved`, builds a channel-
 * agnostic `NotificationMessage`, fans out to every channel linked to the
 * endpoint, runs the gate chain (enabled → severity → event → maintenance →
 * quiet-hours → mute → cooldown → dedup → rate-limit → coalescing), calls
 * `provider.send()`, and writes a `mx_notification_log` row for every
 * outcome — sent, failed, and suppressed.
 *
 * Retries and escalation have their own helpers: failed dispatches are
 * re-queued per `retryBackoffMs`; delayed escalation is handed off to
 * `EscalationScheduler`. Coalescing is a burst strategy (see
 * `coalescing.ts`) — first alert is always immediate, follow-ups within the
 * window are flushed together.
 *
 * The dispatcher is intentionally resilient: any exception inside a gate or
 * a provider call is caught and turned into a suppressed/failed log row so
 * one bad channel can never cascade into another.
 */

import { ObjectId } from 'mongodb'
import { eventBus } from '../core/eventBus.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'
import type {
  EndpointDoc,
  IncidentDoc,
  NotificationChannelDoc,
  NotificationKind,
  NotificationLogDoc,
  NotificationSeverity,
  NotificationSeverityFilter,
  NotificationSuppressedReason,
} from '../storage/types.js'
import { ChannelRegistry } from './channelRegistry.js'
import { CoalescingBuffer, type FlushPayload } from './coalescing.js'
import { CooldownTracker, DedupTracker } from './cooldown.js'
import { EscalationScheduler } from './escalation.js'
import { notificationMetrics } from './metrics.js'
import { MuteTracker } from './mutes.js'
import { RateLimiter } from './rateLimit.js'
import {
  buildChannelTestMessage,
  buildEscalationMessage,
  buildIncidentOpenedMessage,
  buildIncidentResolvedMessage,
} from './templates.js'
import type {
  DispatchSuppression,
  NotificationMessage,
  ProviderResult,
  ResolvedDispatch,
} from './types.js'

// ---------------------------------------------------------------------------
// Severity ordering + filter matching
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<NotificationSeverity, number> = {
  info: 0,
  success: 0,
  warning: 1,
  critical: 2,
}

function filterFloor(filter: NotificationSeverityFilter): number {
  switch (filter) {
    case 'info+': return 0
    case 'warning+': return 1
    case 'critical': return 2
  }
}

function passesSeverity(severity: NotificationSeverity, filter: NotificationSeverityFilter): boolean {
  return SEVERITY_ORDER[severity] >= filterFloor(filter)
}

// ---------------------------------------------------------------------------
// Quiet-hours check (channel + global)
// ---------------------------------------------------------------------------

function inQuietHours(
  now: Date,
  window: { start: string; end: string; tz: string },
): boolean {
  const parts = formatLocal(now, window.tz)
  if (!parts) return false
  const nowMin = parts.hh * 60 + parts.mm
  const start = parseHM(window.start)
  const end = parseHM(window.end)
  if (start === null || end === null) return false
  if (start <= end) return nowMin >= start && nowMin < end
  // Wraps midnight — e.g. 22:00 → 06:00.
  return nowMin >= start || nowMin < end
}

function parseHM(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

function formatLocal(now: Date, tz: string): { hh: number; mm: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const hh = Number(parts.find((p) => p.type === 'hour')?.value)
    const mm = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
    return { hh, mm }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatcherDeps {
  adapter: StorageAdapter
  config: WatchDeckConfig
  /** Base URL used in message links — typically `http://localhost:${port}`. */
  baseUrl: string
}

export class NotificationDispatcher {
  private readonly adapter: StorageAdapter
  private readonly config: WatchDeckConfig
  private readonly baseUrl: string

  readonly channels: ChannelRegistry
  readonly mutes: MuteTracker
  readonly cooldowns = new CooldownTracker()
  readonly dedup = new DedupTracker()
  readonly rateLimiter = new RateLimiter()
  readonly escalation: EscalationScheduler
  readonly coalescing: CoalescingBuffer

  private unsubscribes: Array<() => void> = []
  private started = false

  constructor(deps: DispatcherDeps) {
    this.adapter = deps.adapter
    this.config = deps.config
    this.baseUrl = deps.baseUrl
    this.channels = new ChannelRegistry(this.adapter)
    this.mutes = new MuteTracker(this.adapter)
    this.escalation = new EscalationScheduler(this.adapter, (req) =>
      this.fireEscalation(req),
    )
    const coalescingCfg = this.config.defaults.notifications.coalescing
    this.coalescing = new CoalescingBuffer(
      {
        enabled: coalescingCfg.enabled,
        windowMs: coalescingCfg.windowSeconds * 1000,
        minBurstCount: coalescingCfg.minBurstCount,
        bypassSeverity: coalescingCfg.bypassSeverity,
      },
      (payload) => {
        this.onCoalescingFlush(payload).catch((err: unknown) => {
          console.error('[notifications] coalescing flush failed:', err)
        })
      },
    )
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.channels.init()
    await this.mutes.init()
    await this.escalation.init()
    // IMPORTANT: return the promise so eventBus.subscribe can attach its
    // `.catch(handleError)`. Using `void this.handle…()` drops the promise
    // on the floor and a rejection becomes an unhandled rejection that
    // can tear the whole process down.
    this.unsubscribes.push(
      eventBus.subscribe(
        'incident:opened',
        (payload) => this.handleIncidentOpened(payload.incident),
        'standard',
      ),
      eventBus.subscribe(
        'incident:resolved',
        (payload) => this.handleIncidentResolved(payload.incidentId, payload.durationSeconds),
        'standard',
      ),
    )
    this.started = true
  }

  stop(): void {
    if (!this.started) return
    this.coalescing.stop()
    this.escalation.stop()
    this.mutes.stop()
    this.channels.stop()
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
    this.started = false
  }

  // ---------------------------------------------------------------------------
  // Channel-test path — surfaced to the API layer.
  // ---------------------------------------------------------------------------

  async sendChannelTest(
    channelId: string,
    actor?: string,
  ): Promise<ProviderResult & { ok: boolean; reason?: string }> {
    const channel = this.channels.getChannel(channelId)
    if (!channel) {
      return { ok: false, status: 'failed', latencyMs: 0, failureReason: 'Channel not found', reason: 'Channel not found' }
    }
    const provider = this.channels.getProvider(channel.type)
    if (!provider) {
      const reason = `No provider for type ${channel.type}`
      return { ok: false, status: 'failed', latencyMs: 0, failureReason: reason, reason }
    }
    const msg = buildChannelTestMessage(channel.name, { baseUrl: this.baseUrl, actor })
    const startedAt = Date.now()
    let result: ProviderResult
    try {
      result = await provider.test(channel)
    } catch (err) {
      result = {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        failureReason: err instanceof Error ? err.message : String(err),
      }
    }
    await this.writeLog({
      channel,
      message: msg,
      status: result.status === 'sent' ? 'sent' : 'failed',
      latencyMs: result.latencyMs,
      failureReason: result.failureReason,
    })
    const ok = result.status === 'sent'
    await this.recordChannelDeliveryOutcome(channel, ok)
    eventBus.emit('notification:test', {
      timestamp: new Date(),
      channelId,
      ok,
      reason: result.failureReason,
    })
    return { ok, reason: result.failureReason, ...result }
  }

  /**
   * Re-dispatch a prior failed log row. The caller has already verified that
   * the source incident, endpoint, and channel still exist. Skips the gate
   * chain because the original dispatch was already approved — a manual
   * retry shouldn't be blocked by, say, a cooldown from that same failed
   * attempt. `retryOfLogId` links the new log row back to the original.
   */
  async retryDispatch(input: {
    kind: NotificationKind
    incident: IncidentDoc
    endpoint: EndpointDoc
    channel: NotificationChannelDoc
    retryOfLogId: string
  }): Promise<ProviderResult> {
    const { kind, incident, endpoint, channel, retryOfLogId } = input
    const opts = { baseUrl: this.baseUrl }
    let message: NotificationMessage
    switch (kind) {
      case 'incident_opened':
        message = buildIncidentOpenedMessage(endpoint, incident, opts)
        break
      case 'incident_resolved': {
        const durationSeconds = incident.resolvedAt
          ? Math.max(
              0,
              Math.floor((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
            )
          : 0
        message = buildIncidentResolvedMessage(endpoint, incident, durationSeconds, opts)
        break
      }
      case 'incident_escalated':
        message = buildEscalationMessage(endpoint, incident, opts)
        break
      default:
        return {
          status: 'failed',
          latencyMs: 0,
          failureReason: `Cannot retry dispatches of kind '${kind}'`,
        }
    }

    const provider = this.channels.getProvider(channel.type)
    if (!provider) {
      await this.writeLog({
        channel,
        message,
        status: 'failed',
        latencyMs: 0,
        failureReason: `No provider for type ${channel.type}`,
        retryOf: retryOfLogId,
      })
      return { status: 'failed', latencyMs: 0, failureReason: `No provider for ${channel.type}` }
    }

    const startedAt = Date.now()
    let result: ProviderResult
    try {
      result = await provider.send(message, channel)
    } catch (err) {
      result = {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        failureReason: err instanceof Error ? err.message : String(err),
      }
    }

    const log = await this.writeLog({
      channel,
      message,
      status: result.status === 'sent' ? 'sent' : 'failed',
      latencyMs: result.latencyMs,
      failureReason: result.failureReason,
      retryOf: retryOfLogId,
    })
    await this.recordChannelDeliveryOutcome(channel, result.status === 'sent')
    if (result.status === 'sent') {
      notificationMetrics.recordSent({ kind, channelId: channel._id.toHexString() })
      if (log) {
        eventBus.emit('notification:dispatched', {
          timestamp: new Date(),
          logId: log._id.toHexString(),
          channelId: channel._id.toHexString(),
          endpointId: endpoint._id.toHexString(),
          incidentId: incident._id.toHexString(),
          kind,
          severity: message.severity,
          latencyMs: result.latencyMs,
        })
      }
    } else {
      notificationMetrics.recordFailed({ kind, channelId: channel._id.toHexString() })
      if (log) {
        eventBus.emit('notification:failed', {
          timestamp: new Date(),
          logId: log._id.toHexString(),
          channelId: channel._id.toHexString(),
          endpointId: endpoint._id.toHexString(),
          incidentId: incident._id.toHexString(),
          kind,
          reason: result.failureReason ?? 'unknown',
        })
      }
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Incident entry points
  // ---------------------------------------------------------------------------

  private async handleIncidentOpened(incident: IncidentDoc): Promise<void> {
    if (!this.config.defaults.notifications.enabled) return
    const endpoint = await this.adapter
      .getEndpointById(incident.endpointId.toHexString())
      .catch(() => null)
    if (!endpoint) return
    const message = buildIncidentOpenedMessage(endpoint, incident, { baseUrl: this.baseUrl })
    await this.fanOut(endpoint, message, incident)
  }

  private async handleIncidentResolved(incidentId: string, durationSeconds: number): Promise<void> {
    if (!this.config.defaults.notifications.enabled) return
    const incident = await this.adapter.getIncidentById(incidentId).catch(() => null)
    if (!incident) return
    const endpoint = await this.adapter
      .getEndpointById(incident.endpointId.toHexString())
      .catch(() => null)
    if (!endpoint) return
    if (!endpoint.recoveryAlert) return

    // Resolved alerts clear the per-incident dedup & cooldown state so the
    // next outage can re-alert immediately.
    this.dedup.clearIncident(incidentId)
    this.cooldowns.clearEndpoint(endpoint._id.toHexString())

    // Only emit recovery to channels that *actually received* the matching
    // open. Without this, a coalesced batch of 50 incidents would emit 50
    // recovery messages even though only one open went out — flooding the
    // channel with "X recovered" noise the user never asked for. The
    // notification log is the source of truth.
    const channelsWithDeliveredOpen = await this.findChannelsThatGotOpen(incidentId)
    if (channelsWithDeliveredOpen.size === 0) return

    const message = buildIncidentResolvedMessage(endpoint, incident, durationSeconds, {
      baseUrl: this.baseUrl,
    })
    await this.fanOutResolved(endpoint, incident, message, channelsWithDeliveredOpen)
  }

  /**
   * Returns the set of channel IDs that received a successful `incident_opened`
   * (or `incident_escalated`) for this incident — including incidents that
   * were folded into a coalesced summary. These are the only channels that
   * should hear about the recovery.
   */
  private async findChannelsThatGotOpen(incidentId: string): Promise<Set<string>> {
    const channels = new Set<string>()
    try {
      const logs = await this.adapter.listNotificationLogForIncident(incidentId)
      for (const row of logs) {
        if (row.deliveryStatus !== 'sent') continue
        if (row.kind !== 'incident_opened' && row.kind !== 'incident_escalated') continue
        channels.add(row.channelId.toHexString())
      }
      // Coalesced summary rows store the original incident IDs in
      // `coalescedIncidentIds` and only attach `incidentId` to the
      // representative — so we also scan recent sent rows for any whose
      // `coalescedIncidentIds` array includes this incident.
      const coalesced = await this.adapter.findCoalescedDeliveriesFor(incidentId)
      for (const row of coalesced) {
        if (row.deliveryStatus !== 'sent') continue
        channels.add(row.channelId.toHexString())
      }
    } catch (err) {
      console.error('[notifications] failed to look up open-delivery log:', err)
    }
    return channels
  }

  private async fanOutResolved(
    endpoint: EndpointDoc,
    incident: IncidentDoc,
    message: NotificationMessage,
    channelIds: Set<string>,
  ): Promise<void> {
    for (const channelId of channelIds) {
      const channel = this.channels.getChannel(channelId)
      if (!channel) continue
      await this.dispatchToChannel(
        {
          channelId,
          channel,
          message,
          cooldownSeconds: endpoint.alertCooldown,
          retryAttempt: 0,
          bypassResolvedGates: true,
        },
        endpoint,
        incident,
      )
    }
  }

  private async fireEscalation(req: {
    incidentId: string
    endpointId: string
    channelId: string
  }): Promise<void> {
    if (!this.config.defaults.notifications.enabled) return
    if (!this.config.defaults.notifications.sendEscalation) return
    const incident = await this.adapter.getIncidentById(req.incidentId).catch(() => null)
    if (!incident || incident.status !== 'active') return
    const endpoint = await this.adapter.getEndpointById(req.endpointId).catch(() => null)
    if (!endpoint) return
    const channel = this.channels.getChannel(req.channelId)
    if (!channel) return
    const message = buildEscalationMessage(endpoint, incident, { baseUrl: this.baseUrl })
    await this.dispatchToChannel(
      {
        channelId: req.channelId,
        channel,
        message,
        cooldownSeconds: endpoint.alertCooldown,
        retryAttempt: 0,
      },
      endpoint,
      incident,
    )
  }

  // ---------------------------------------------------------------------------
  // Fan-out — incidents land here after channel resolution
  // ---------------------------------------------------------------------------

  private async fanOut(
    endpoint: EndpointDoc,
    message: NotificationMessage,
    incident: IncidentDoc,
  ): Promise<void> {
    // `notificationChannelIds` is typed as ObjectId[], but legacy documents
    // may contain raw strings (early builds of the PUT route stored them
    // as-is). Normalise defensively so one broken row can't crash dispatch.
    const channelIds: string[] = []
    for (const raw of endpoint.notificationChannelIds ?? []) {
      if (raw == null) continue
      if (typeof raw === 'string') {
        channelIds.push(raw)
      } else if (typeof (raw as { toHexString?: unknown }).toHexString === 'function') {
        channelIds.push((raw as ObjectId).toHexString())
      }
    }
    for (const channelId of channelIds) {
      const channel = this.channels.getChannel(channelId)
      if (!channel) continue
      await this.dispatchToChannel(
        {
          channelId,
          channel,
          message,
          cooldownSeconds: endpoint.alertCooldown,
          retryAttempt: 0,
        },
        endpoint,
        incident,
      )
    }
  }

  /**
   * Single-channel dispatch pipeline: gates → coalesce → send → log.
   * Always returns; never throws. One suppressed row per rejected gate.
   */
  private async dispatchToChannel(
    dispatch: ResolvedDispatch,
    endpoint: EndpointDoc | null,
    incident: IncidentDoc | null,
  ): Promise<void> {
    const suppression = this.runGates(dispatch, endpoint, incident)
    if (suppression) {
      await this.recordSuppressed(dispatch, suppression)
      return
    }

    const decision = this.coalescing.admit(dispatch)
    if (decision.action === 'buffered') {
      // The coalescing buffer will flush the summary later; no log row yet.
      return
    }

    await this.sendNow(dispatch)
  }

  // ---------------------------------------------------------------------------
  // Gates — return a suppression reason, or null if the dispatch passes.
  // ---------------------------------------------------------------------------

  private runGates(
    dispatch: ResolvedDispatch,
    endpoint: EndpointDoc | null,
    incident: IncidentDoc | null,
  ): DispatchSuppression | null {
    const { channel, message } = dispatch
    const notif = this.config.defaults.notifications

    if (channel.enabled === false) return { reason: 'channel_disabled' }

    // Resolved messages whose matching open was already delivered to this
    // channel skip the severity gate entirely. Otherwise a channel set to
    // `warning+` would silently drop every "service recovered" message
    // (since `success` < `warning`), leaving the user wondering whether
    // the outage ever cleared.
    const resolvedBypass =
      dispatch.bypassResolvedGates === true && message.kind === 'incident_resolved'

    if (!resolvedBypass) {
      if (!passesSeverity(message.severity, channel.severityFilter)) {
        return { reason: 'severity_filter' }
      }
      // Apply the global severity floor on top of the channel filter.
      if (!passesSeverity(message.severity, notif.severityFloor)) {
        return { reason: 'severity_filter' }
      }
    }

    if (!eventFilterAllows(channel, message.kind)) {
      return { reason: 'event_filter' }
    }

    if (endpoint && !notif.alertDuringMaintenance && this.inMaintenance(endpoint, new Date())) {
      return { reason: 'maintenance' }
    }

    if (this.isQuietHours(channel, message.severity)) {
      return { reason: 'quiet_hours' }
    }

    const mute = this.mutes.isMuted({
      endpointId: endpoint?._id.toHexString(),
      channelId: dispatch.channelId,
    })
    if (mute.muted) return { reason: 'muted', detail: mute.scope }

    // Cooldown only applies to alert-direction messages (open/escalation).
    // Recovery messages must always go through if their open went through —
    // anything else and the user is left wondering if the system ever came
    // back. The `resolvedBypass` flag carries the proof that the open was
    // delivered (see handleIncidentResolved).
    if (endpoint && !resolvedBypass) {
      const inCool = this.cooldowns.inCooldown(
        endpoint._id.toHexString(),
        dispatch.channelId,
        message.kind,
      )
      if (inCool) return { reason: 'cooldown' }
    }

    if (incident) {
      const dup = this.dedup.markIfNew(
        incident._id.toHexString(),
        dispatch.channelId,
        message.kind,
      )
      if (dup) return { reason: 'coalesced' }
    }

    const rate = this.resolveRateLimit(channel)
    if (!this.rateLimiter.tryConsume(dispatch.channelId, rate)) {
      return { reason: 'rate_limit' }
    }

    return null
  }

  private inMaintenance(endpoint: EndpointDoc, now: Date): boolean {
    if (!endpoint.maintenanceWindows?.length) return false
    const t = now.getTime()
    return endpoint.maintenanceWindows.some(
      (w) => w.startTime.getTime() <= t && w.endTime.getTime() >= t,
    )
  }

  private isQuietHours(channel: NotificationChannelDoc, severity: NotificationSeverity): boolean {
    // Critical always bypasses quiet hours.
    if (severity === 'critical') return false
    const now = new Date()
    const global = this.config.defaults.notifications.quietHours
    if (global && inQuietHours(now, global)) return true
    if (channel.quietHours && inQuietHours(now, channel.quietHours)) return true
    return false
  }

  private resolveRateLimit(channel: NotificationChannelDoc): number {
    if (channel.rateLimit?.maxPerMinute) return channel.rateLimit.maxPerMinute
    const defaults = this.config.defaults.notifications.channelDefaults
    return defaults[channel.type].rateLimitPerMinute
  }

  // ---------------------------------------------------------------------------
  // Send + retry + log
  // ---------------------------------------------------------------------------

  private async sendNow(dispatch: ResolvedDispatch): Promise<void> {
    const { channel, message } = dispatch
    const provider = this.channels.getProvider(channel.type)
    if (!provider) {
      await this.writeLog({
        channel,
        message,
        status: 'failed',
        latencyMs: 0,
        failureReason: `No provider for type ${channel.type}`,
        retryOf: dispatch.retryOfLogId,
      })
      notificationMetrics.recordFailed({ kind: message.kind, channelId: dispatch.channelId })
      return
    }

    const startedAt = Date.now()
    let result: ProviderResult
    try {
      result = await provider.send(message, channel)
    } catch (err) {
      result = {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        failureReason: err instanceof Error ? err.message : String(err),
      }
    }

    if (result.status === 'sent') {
      const log = await this.writeLog({
        channel,
        message,
        status: 'sent',
        latencyMs: result.latencyMs,
        retryOf: dispatch.retryOfLogId,
      })
      await this.recordChannelDeliveryOutcome(channel, true)
      const endpointId = message.endpoint?.id
      if (endpointId && dispatch.cooldownSeconds) {
        this.cooldowns.stamp(
          endpointId,
          dispatch.channelId,
          message.kind,
          dispatch.cooldownSeconds,
        )
      }
      notificationMetrics.recordSent({ kind: message.kind, channelId: dispatch.channelId })
      if (log) {
        eventBus.emit('notification:dispatched', {
          timestamp: new Date(),
          logId: log._id.toHexString(),
          channelId: dispatch.channelId,
          endpointId,
          incidentId: message.incident?.id,
          kind: message.kind,
          severity: message.severity,
          latencyMs: result.latencyMs,
        })
      }
      return
    }

    // Provider skipped — treat as failure but don't retry a stub.
    if (result.status === 'skipped') {
      await this.writeLog({
        channel,
        message,
        status: 'failed',
        latencyMs: result.latencyMs,
        failureReason: result.failureReason ?? 'Provider skipped',
        retryOf: dispatch.retryOfLogId,
      })
      notificationMetrics.recordFailed({ kind: message.kind, channelId: dispatch.channelId })
      return
    }

    const log = await this.writeLog({
      channel,
      message,
      status: 'failed',
      latencyMs: result.latencyMs,
      failureReason: result.failureReason,
      retryOf: dispatch.retryOfLogId,
    })
    await this.recordChannelDeliveryOutcome(channel, false)
    notificationMetrics.recordFailed({ kind: message.kind, channelId: dispatch.channelId })
    if (log) {
      eventBus.emit('notification:failed', {
        timestamp: new Date(),
        logId: log._id.toHexString(),
        channelId: dispatch.channelId,
        endpointId: message.endpoint?.id,
        incidentId: message.incident?.id,
        kind: message.kind,
        reason: result.failureReason ?? 'unknown',
      })
    }

    // Schedule retry on failure if enabled.
    if (this.shouldRetry(channel, dispatch)) {
      this.scheduleRetry(dispatch, log?._id.toHexString())
    }
  }

  private shouldRetry(channel: NotificationChannelDoc, dispatch: ResolvedDispatch): boolean {
    if (!this.config.defaults.notifications.retryOnFailure) return false
    if (channel.retryOnFailure === false) return false
    const backoff = this.config.defaults.notifications.retryBackoffMs
    if (!backoff.length) return false
    const attempt = dispatch.retryAttempt ?? 0
    return attempt < backoff.length
  }

  private scheduleRetry(dispatch: ResolvedDispatch, lastLogId: string | undefined): void {
    const backoff = this.config.defaults.notifications.retryBackoffMs
    const attempt = dispatch.retryAttempt ?? 0
    const waitMs = backoff[attempt]
    if (waitMs === undefined) return
    const next: ResolvedDispatch = {
      ...dispatch,
      retryAttempt: attempt + 1,
      retryOfLogId: lastLogId ?? dispatch.retryOfLogId,
    }
    const handle = setTimeout(() => {
      this.sendNow(next).catch((err: unknown) => {
        console.error('[notifications] retry dispatch failed:', err)
      })
    }, waitMs)
    handle.unref?.()
  }

  // ---------------------------------------------------------------------------
  // Coalescing flush — builds one summary row, emits one dispatch event.
  // ---------------------------------------------------------------------------

  private async onCoalescingFlush(payload: FlushPayload): Promise<void> {
    // In 'individual' mode we just send each buffered dispatch one-by-one.
    if (payload.mode === 'individual') {
      for (const entry of payload.alerts) {
        await this.sendNow(entry.dispatch)
      }
      return
    }

    // 'summary' — collapse all alerts into one log row + one provider call.
    const channel = this.channels.getChannel(payload.channelId)
    if (!channel) return
    const first = payload.alerts[0]
    if (!first) return
    const count = payload.alerts.length
    const incidentIds = unique(
      payload.alerts.map((a) => a.dispatch.message.incident?.id).filter(Boolean) as string[],
    )
    const summaryMessage: NotificationMessage = {
      ...first.dispatch.message,
      title: `${count} endpoints alerting`,
      summary: `${count} endpoints opened incidents in the last ${
        Math.round((this.config.defaults.notifications.coalescing.windowSeconds))
      }s.`,
      detail: payload.alerts
        .map((a) => `• ${a.dispatch.message.endpoint?.name ?? 'endpoint'}: ${a.dispatch.message.summary}`)
        .join('\n'),
      idempotencyKey: `coalesced:${payload.channelId}:${Date.now()}`,
    }

    const provider = this.channels.getProvider(channel.type)
    if (!provider) return
    const startedAt = Date.now()
    let result: ProviderResult
    try {
      result = await provider.send(summaryMessage, channel)
    } catch (err) {
      result = {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        failureReason: err instanceof Error ? err.message : String(err),
      }
    }

    const log = await this.writeLog({
      channel,
      message: summaryMessage,
      status: result.status === 'sent' ? 'sent' : 'failed',
      latencyMs: result.latencyMs,
      failureReason: result.failureReason,
      coalescedCount: count,
      coalescedIncidentIds: incidentIds,
    })
    await this.recordChannelDeliveryOutcome(channel, result.status === 'sent')
    if (result.status === 'sent') {
      notificationMetrics.recordSent({ kind: summaryMessage.kind, channelId: payload.channelId })
    } else {
      notificationMetrics.recordFailed({ kind: summaryMessage.kind, channelId: payload.channelId })
    }
    if (log) {
      eventBus.emit('notification:coalescingFlushed', {
        timestamp: new Date(),
        channelId: payload.channelId,
        endpointId: payload.endpointId,
        count,
        logId: log._id.toHexString(),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Log writes
  // ---------------------------------------------------------------------------

  private async recordSuppressed(
    dispatch: ResolvedDispatch,
    suppression: DispatchSuppression,
  ): Promise<void> {
    const { channel, message } = dispatch
    await this.writeLog({
      channel,
      message,
      status: 'suppressed',
      suppressedReason: suppression.reason,
    })
    notificationMetrics.recordSuppressed()
    eventBus.emit('notification:suppressed', {
      timestamp: new Date(),
      channelId: dispatch.channelId,
      endpointId: message.endpoint?.id,
      incidentId: message.incident?.id,
      suppressedReason: suppression.reason,
    })
  }

  /**
   * Updates channel health after a real send attempt (test, incident alert,
   * retry, or coalesced summary). Always stamps `lastSuccessAt`/`lastFailureAt`
   * so the dashboard can tell a freshly-failing channel from one that hasn't
   * been exercised. Only emits `notification:channelUpdated` when the
   * `isConnected` flag actually flips, to avoid log spam on every send.
   *
   * Intentionally skipped: suppressed rows and "no provider" stubs — neither
   * represents a transport failure, so neither should mark the channel
   * offline.
   */
  private async recordChannelDeliveryOutcome(
    channel: NotificationChannelDoc,
    ok: boolean,
  ): Promise<void> {
    const now = new Date()
    const changes: Partial<NotificationChannelDoc> = ok
      ? { lastSuccessAt: now }
      : { lastFailureAt: now }
    const flip = ok !== channel.isConnected
    if (flip) changes.isConnected = ok
    try {
      await this.adapter.updateNotificationChannel(channel._id.toHexString(), changes)
    } catch (err) {
      console.error('[notifications] failed to update channel health:', err)
      return
    }
    if (flip) {
      eventBus.emit('notification:channelUpdated', {
        timestamp: now,
        channelId: channel._id.toHexString(),
      })
    }
  }

  private async writeLog(row: {
    channel: NotificationChannelDoc
    message: NotificationMessage
    status: 'sent' | 'failed' | 'suppressed' | 'pending'
    latencyMs?: number
    failureReason?: string
    suppressedReason?: NotificationSuppressedReason
    retryOf?: string
    coalescedCount?: number
    coalescedIncidentIds?: string[]
  }): Promise<NotificationLogDoc | null> {
    try {
      return await this.adapter.writeNotificationLog({
        endpointId: row.message.endpoint ? new ObjectId(row.message.endpoint.id) : undefined,
        incidentId: row.message.incident ? new ObjectId(row.message.incident.id) : undefined,
        channelId: row.channel._id,
        type: kindToLegacyType(row.message.kind),
        channelType: row.channel.type,
        channelTarget: describeTarget(row.channel),
        messageSummary: row.message.summary,
        severity: row.message.severity,
        kind: row.message.kind,
        deliveryStatus: row.status,
        failureReason: row.failureReason,
        suppressedReason: row.suppressedReason,
        latencyMs: row.latencyMs,
        idempotencyKey: row.message.idempotencyKey,
        retryOf: row.retryOf ? new ObjectId(row.retryOf) : undefined,
        coalescedCount: row.coalescedCount,
        coalescedIncidentIds: row.coalescedIncidentIds?.map((id) => new ObjectId(id)),
        sentAt: new Date(),
      })
    } catch (err) {
      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'notifications',
        message: `Failed to write notification log: ${err instanceof Error ? err.message : String(err)}`,
      })
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventFilterAllows(
  channel: NotificationChannelDoc,
  kind: NotificationKind,
): boolean {
  const f = channel.eventFilters
  if (!f) return true
  switch (kind) {
    case 'incident_opened': return f.sendOpen
    case 'incident_resolved': return f.sendResolved
    case 'incident_escalated': return f.sendEscalation
    case 'channel_test':
    case 'custom':
      return true
  }
}

function describeTarget(channel: NotificationChannelDoc): string {
  switch (channel.type) {
    case 'discord': return channel.discordChannelId ?? channel.discordWebhookUrl ?? channel.name
    case 'slack': return channel.slackChannelId ?? channel.slackWebhookUrl ?? channel.name
    case 'email': return channel.emailRecipients?.join(', ') ?? channel.name
    case 'webhook': return channel.webhookUrl ?? channel.name
  }
}

function kindToLegacyType(kind: NotificationKind): string {
  return kind
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}
