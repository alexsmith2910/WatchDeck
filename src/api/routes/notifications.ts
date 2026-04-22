/**
 * Notification routes (auth required).
 *
 * Channels
 *   GET    /notifications/channels                   — list
 *   POST   /notifications/channels                   — create
 *   PUT    /notifications/channels/:id               — update
 *   DELETE /notifications/channels/:id               — delete
 *   POST   /notifications/channels/:id/test          — dispatch a test message
 *
 * Log
 *   GET    /notifications/log                        — cursor-paginated with filters
 *   GET    /notifications/log/:id                    — single row (detail drawer)
 *   POST   /notifications/log/:id/retry              — re-send a failed dispatch
 *
 * Stats
 *   GET    /notifications/stats                      — totals + rates over a window
 *
 * Preferences
 *   GET    /notifications/preferences                — global preferences singleton
 *   PUT    /notifications/preferences                — update preferences
 *
 * Mutes
 *   GET    /notifications/mutes                      — list active mutes
 *   POST   /notifications/mutes                      — create mute
 *   DELETE /notifications/mutes/:id                  — remove mute
 *
 * Endpoint-scoped
 *   GET    /endpoints/:id/notifications/log          — endpoint-scoped log
 *   GET    /endpoints/:id/notifications/stats        — endpoint-scoped stats
 *   POST   /endpoints/:id/notifications/mute         — mute shortcut
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { eventBus } from '../../core/eventBus.js'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'
import type {
  NotificationChannelDoc,
  NotificationChannelType,
  NotificationDeliveryStatus,
  NotificationKind,
  NotificationSeverity,
} from '../../storage/types.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const channelBaseSchema = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  deliveryPriority: { type: 'string', enum: ['standard', 'critical'] },
  enabled: { type: 'boolean' },
  severityFilter: { type: 'string', enum: ['info+', 'warning+', 'critical'] },
  eventFilters: {
    type: 'object',
    properties: {
      sendOpen: { type: 'boolean' },
      sendResolved: { type: 'boolean' },
      sendEscalation: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  quietHours: {
    type: 'object',
    properties: {
      start: { type: 'string' },
      end: { type: 'string' },
      tz: { type: 'string' },
    },
    required: ['start', 'end', 'tz'],
    additionalProperties: false,
    nullable: true,
  },
  rateLimit: {
    type: 'object',
    properties: { maxPerMinute: { type: 'integer', minimum: 1, maximum: 10000 } },
    required: ['maxPerMinute'],
    additionalProperties: false,
    nullable: true,
  },
  retryOnFailure: { type: 'boolean' },
  metadata: { type: 'object', additionalProperties: true, nullable: true },
  // Discord
  discordTransport: { type: 'string', enum: ['webhook', 'bot'] },
  discordWebhookUrl: { type: 'string' },
  discordChannelId: { type: 'string' },
  discordGuildId: { type: 'string' },
  discordUsername: { type: 'string' },
  discordAvatarUrl: { type: 'string' },
  // Slack
  slackWebhookUrl: { type: 'string' },
  slackChannelId: { type: 'string' },
  slackWorkspaceName: { type: 'string' },
  // Email
  emailEndpoint: { type: 'string' },
  emailRecipients: { type: 'array', items: { type: 'string' } },
  // Webhook
  webhookUrl: { type: 'string' },
  webhookMethod: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
  webhookHeaders: { type: 'object', additionalProperties: { type: 'string' } },
  webhookBodyTemplate: { type: 'string' },
} as const

const createChannelSchema = {
  type: 'object',
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: ['discord', 'slack', 'email', 'webhook'] },
    ...channelBaseSchema,
  },
  additionalProperties: false,
} as const

const updateChannelSchema = {
  type: 'object',
  properties: channelBaseSchema,
  additionalProperties: false,
} as const

const createMuteSchema = {
  type: 'object',
  required: ['scope', 'expiresAt'],
  properties: {
    scope: { type: 'string', enum: ['endpoint', 'channel', 'global'] },
    targetId: { type: 'string' },
    expiresAt: { type: 'string' },
    mutedBy: { type: 'string' },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const

const endpointMuteSchema = {
  type: 'object',
  required: ['expiresAt'],
  properties: {
    expiresAt: { type: 'string' },
    mutedBy: { type: 'string' },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const

const updatePreferencesSchema = {
  type: 'object',
  properties: {
    globalQuietHours: {
      type: 'object',
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        tz: { type: 'string' },
      },
      required: ['start', 'end', 'tz'],
      additionalProperties: false,
      nullable: true,
    },
    globalMuteUntil: { type: 'string', nullable: true },
    defaultSeverityFilter: { type: 'string', enum: ['info+', 'warning+', 'critical'] },
    defaultEventFilters: {
      type: 'object',
      properties: {
        sendOpen: { type: 'boolean' },
        sendResolved: { type: 'boolean' },
        sendEscalation: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    digestMode: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
      required: ['enabled', 'intervalMinutes'],
      additionalProperties: false,
    },
    lastEditedBy: { type: 'string' },
  },
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function parseLogFilters(q: Record<string, string | undefined>): {
  endpointId?: string
  channelId?: string
  incidentId?: string
  severity?: NotificationSeverity
  kind?: NotificationKind
  status?: NotificationDeliveryStatus
  from?: Date
  to?: Date
  search?: string
  retryOf?: string
} {
  const out: ReturnType<typeof parseLogFilters> = {}
  if (q.endpointId) out.endpointId = q.endpointId
  if (q.channelId) out.channelId = q.channelId
  if (q.incidentId) out.incidentId = q.incidentId
  if (q.severity) out.severity = q.severity as NotificationSeverity
  if (q.kind) out.kind = q.kind as NotificationKind
  if (q.status) out.status = q.status as NotificationDeliveryStatus
  const from = parseDate(q.from)
  if (from) out.from = from
  const to = parseDate(q.to)
  if (to) out.to = to
  if (q.search) out.search = q.search
  if (q.retryOf && ObjectId.isValid(q.retryOf)) out.retryOf = q.retryOf
  return out
}

function moduleGate(
  ctx: AppContext,
  type: NotificationChannelType,
  body: Record<string, unknown>,
): { ok: true } | { ok: false; response: ReturnType<typeof formatError> } {
  if (type === 'discord' && !ctx.config.modules.discord) {
    // Discord webhook transport does not require the Discord module — it's a
    // plain HTTPS POST to a user-supplied webhook URL and never touches
    // MX_DISCORD_TOKEN. Only the bot transport is gated.
    const transport = (body.discordTransport as string | undefined) ?? 'webhook'
    if (transport !== 'webhook') {
      return {
        ok: false,
        response: formatError('MODULE_DISABLED', 'Discord bot transport is disabled', [
          {
            field: 'body.discordTransport',
            value: transport,
            expected: 'modules.discord to be true (or use the webhook transport)',
            fix: 'Set modules.discord to true in watchdeck.config.js and restart, or switch to the Discord webhook transport',
          },
        ]),
      }
    }
  }
  if (type === 'slack' && !ctx.config.modules.slack) {
    return {
      ok: false,
      response: formatError('MODULE_DISABLED', 'Slack notifications are disabled', [
        {
          field: 'body.type',
          value: 'slack',
          expected: 'modules.slack to be true',
          fix: 'Set modules.slack to true in watchdeck.config.js and restart',
        },
      ]),
    }
  }
  return { ok: true }
}

function defaultWindow(query: Record<string, string | undefined>): { from: Date; to: Date } {
  const to = parseDate(query.to) ?? new Date()
  const from = parseDate(query.from) ?? new Date(to.getTime() - 24 * 60 * 60 * 1000)
  return { from, to }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function notificationsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── Channels ────────────────────────────────────────────────────────────

    fastify.get('/notifications/channels', async (request, reply) => {
      const pagination = parsePagination(request.query as { cursor?: string; limit?: string })
      const channels = await ctx.adapter.listNotificationChannels()
      const limit = pagination.limit ?? 20
      const slice = channels.slice(0, limit)
      return reply.send({
        data: slice,
        pagination: {
          limit,
          hasMore: channels.length > limit,
          nextCursor: null,
          prevCursor: null,
          total: channels.length,
        },
      })
    })

    fastify.post(
      '/notifications/channels',
      { schema: { body: createChannelSchema } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>
        const type = body.type as NotificationChannelType

        const gate = moduleGate(ctx, type, body)
        if (!gate.ok) return reply.code(409).send(gate.response)

        const provider = ctx.notifications?.channels.getProvider(type)
        const draft = {
          type,
          name: body.name as string,
          deliveryPriority: (body.deliveryPriority as 'standard' | 'critical') ?? 'standard',
          enabled: body.enabled !== false,
          severityFilter:
            (body.severityFilter as NotificationChannelDoc['severityFilter']) ?? 'warning+',
          eventFilters:
            (body.eventFilters as NotificationChannelDoc['eventFilters']) ?? {
              sendOpen: true,
              sendResolved: true,
              sendEscalation: true,
            },
          quietHours: body.quietHours as NotificationChannelDoc['quietHours'],
          rateLimit: body.rateLimit as NotificationChannelDoc['rateLimit'],
          retryOnFailure: body.retryOnFailure !== false,
          metadata: body.metadata as NotificationChannelDoc['metadata'],
          discordTransport: body.discordTransport as NotificationChannelDoc['discordTransport'],
          discordWebhookUrl: body.discordWebhookUrl as string | undefined,
          discordChannelId: body.discordChannelId as string | undefined,
          discordGuildId: body.discordGuildId as string | undefined,
          discordUsername: body.discordUsername as string | undefined,
          discordAvatarUrl: body.discordAvatarUrl as string | undefined,
          slackWebhookUrl: body.slackWebhookUrl as string | undefined,
          slackChannelId: body.slackChannelId as string | undefined,
          slackWorkspaceName: body.slackWorkspaceName as string | undefined,
          emailEndpoint: body.emailEndpoint as string | undefined,
          emailRecipients: body.emailRecipients as string[] | undefined,
          webhookUrl: body.webhookUrl as string | undefined,
          webhookMethod: body.webhookMethod as NotificationChannelDoc['webhookMethod'],
          webhookHeaders: body.webhookHeaders as Record<string, string> | undefined,
          webhookBodyTemplate: body.webhookBodyTemplate as string | undefined,
          isConnected: false,
        }

        if (provider) {
          const validation = provider.validateTarget({
            ...draft,
            _id: new ObjectId(),
            createdAt: new Date(),
            updatedAt: new Date(),
          } as NotificationChannelDoc)
          if (!validation.valid) {
            return reply.code(400).send(
              formatError('VALIDATION_ERROR', validation.error ?? 'Channel validation failed'),
            )
          }
        }

        const channel = await ctx.adapter.createNotificationChannel(draft)
        eventBus.emit('notification:channelCreated', {
          timestamp: new Date(),
          channelId: channel._id.toHexString(),
        })
        return reply.code(201).send({ data: channel })
      },
    )

    fastify.put(
      '/notifications/channels/:id',
      { schema: { body: updateChannelSchema } },
      async (request, reply) => {
        const { id } = request.params as { id: string }
        if (!ObjectId.isValid(id)) {
          return reply
            .code(400)
            .send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
        }

        const body = request.body as Record<string, unknown>
        const { _id: _d, createdAt: _c, type: _t, ...changes } = body

        const updated = await ctx.adapter.updateNotificationChannel(
          id,
          changes as Parameters<typeof ctx.adapter.updateNotificationChannel>[1],
        )
        if (!updated) {
          return reply.code(404).send(formatError('NOT_FOUND', `Channel ${id} not found`))
        }
        eventBus.emit('notification:channelUpdated', {
          timestamp: new Date(),
          channelId: id,
        })
        return reply.send({ data: updated })
      },
    )

    fastify.delete('/notifications/channels/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
      }
      const deleted = await ctx.adapter.deleteNotificationChannel(id)
      if (!deleted) {
        return reply.code(404).send(formatError('NOT_FOUND', `Channel ${id} not found`))
      }
      eventBus.emit('notification:channelDeleted', {
        timestamp: new Date(),
        channelId: id,
      })
      return reply.code(204).send()
    })

    // ── Test channel ────────────────────────────────────────────────────────

    fastify.post('/notifications/channels/:id/test', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
      }
      const channel = await ctx.adapter.getNotificationChannelById(id)
      if (!channel) {
        return reply.code(404).send(formatError('NOT_FOUND', `Channel ${id} not found`))
      }
      if (!ctx.notifications) {
        return reply.code(503).send(
          formatError('DISPATCHER_UNAVAILABLE', 'Notification dispatcher is not initialised'),
        )
      }
      const body = (request.body ?? {}) as { actor?: string }
      const result = await ctx.notifications.sendChannelTest(id, body.actor)
      return reply.send({ data: result })
    })

    // ── Log — list ──────────────────────────────────────────────────────────

    fastify.get('/notifications/log', async (request, reply) => {
      const query = request.query as Record<string, string | undefined>
      const pagination = parsePagination(query)
      const filters = parseLogFilters(query)
      const page = await ctx.adapter.listNotificationLog({ ...pagination, ...filters })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    fastify.get('/notifications/log/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Log ID is not a valid ObjectId'))
      }
      const row = await ctx.adapter.getNotificationLogById(id)
      if (!row) return reply.code(404).send(formatError('NOT_FOUND', `Log row ${id} not found`))
      return reply.send({ data: row })
    })

    fastify.post('/notifications/log/:id/retry', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Log ID is not a valid ObjectId'))
      }
      if (!ctx.notifications) {
        return reply.code(503).send(
          formatError('DISPATCHER_UNAVAILABLE', 'Notification dispatcher is not initialised'),
        )
      }
      const row = await ctx.adapter.getNotificationLogById(id)
      if (!row) return reply.code(404).send(formatError('NOT_FOUND', `Log row ${id} not found`))
      if (row.deliveryStatus === 'sent') {
        return reply.code(409).send(
          formatError('ALREADY_SENT', 'Cannot retry a dispatch that has already been sent'),
        )
      }

      // The dispatcher needs the live channel + a message bundle. For simple
      // retries of a recorded row the most reliable path is to rebuild from
      // the source incident (if any) + target channel, then re-queue it.
      const channel = await ctx.adapter.getNotificationChannelById(row.channelId.toHexString())
      if (!channel) {
        return reply.code(404).send(
          formatError('CHANNEL_GONE', `Channel ${row.channelId.toHexString()} no longer exists`),
        )
      }
      if (!row.incidentId) {
        return reply.code(400).send(
          formatError('UNSUPPORTED', 'Only incident-related dispatches can be retried'),
        )
      }
      const incident = await ctx.adapter.getIncidentById(row.incidentId.toHexString())
      if (!incident) {
        return reply.code(404).send(
          formatError('NOT_FOUND', `Source incident ${row.incidentId.toHexString()} not found`),
        )
      }
      const endpoint = await ctx.adapter.getEndpointById(incident.endpointId.toHexString())
      if (!endpoint) {
        return reply.code(404).send(
          formatError('NOT_FOUND', `Endpoint ${incident.endpointId.toHexString()} not found`),
        )
      }

      const result = await ctx.notifications.retryDispatch({
        kind: row.kind,
        incident,
        endpoint,
        channel,
        retryOfLogId: row._id.toHexString(),
      })
      return reply.send({ data: result })
    })

    // ── Stats ───────────────────────────────────────────────────────────────

    fastify.get('/notifications/stats', async (request, reply) => {
      const window = defaultWindow(request.query as Record<string, string | undefined>)
      const stats = await ctx.adapter.countNotificationStats(window)
      return reply.send({ data: stats, window })
    })

    // ── Escalations (in-memory scheduler snapshot) ──────────────────────────

    fastify.get('/notifications/escalations', async (_request, reply) => {
      const dispatcher = ctx.notifications
      if (!dispatcher) return reply.send({ data: [] })
      const scheduled = dispatcher.escalation.list().map((e) => ({
        incidentId: e.incidentId,
        endpointId: e.endpointId,
        channelId: e.channelId,
        firesAt: new Date(e.firesAt).toISOString(),
      }))
      return reply.send({ data: scheduled })
    })

    // ── Preferences ─────────────────────────────────────────────────────────

    fastify.get('/notifications/preferences', async (_request, reply) => {
      const prefs = await ctx.adapter.getNotificationPreferences()
      return reply.send({ data: prefs })
    })

    fastify.put(
      '/notifications/preferences',
      { schema: { body: updatePreferencesSchema } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>
        const patch: Record<string, unknown> = { ...body }
        if ('globalMuteUntil' in body) {
          const d = parseDate(body.globalMuteUntil)
          patch.globalMuteUntil = d ?? undefined
        }
        const prefs = await ctx.adapter.updateNotificationPreferences(
          patch as Parameters<typeof ctx.adapter.updateNotificationPreferences>[0],
        )
        // Re-emit as a global mute event so the MuteTracker picks it up.
        if (prefs.globalMuteUntil) {
          eventBus.emit('notification:muted', {
            timestamp: new Date(),
            scope: 'global',
            expiresAt: prefs.globalMuteUntil,
          })
        } else if ('globalMuteUntil' in body) {
          eventBus.emit('notification:unmuted', { timestamp: new Date(), scope: 'global' })
        }
        return reply.send({ data: prefs })
      },
    )

    // ── Mutes ───────────────────────────────────────────────────────────────

    fastify.get('/notifications/mutes', async (request, reply) => {
      const pagination = parsePagination(request.query as { cursor?: string; limit?: string })
      const mutes = await ctx.adapter.listActiveMutes()
      const limit = pagination.limit ?? 20
      const slice = mutes.slice(0, limit)
      return reply.send({
        data: slice,
        pagination: {
          limit,
          hasMore: mutes.length > limit,
          nextCursor: null,
          prevCursor: null,
          total: mutes.length,
        },
      })
    })

    fastify.post(
      '/notifications/mutes',
      { schema: { body: createMuteSchema } },
      async (request, reply) => {
        const body = request.body as {
          scope: 'endpoint' | 'channel' | 'global'
          targetId?: string
          expiresAt: string
          mutedBy?: string
          reason?: string
        }
        const expiresAt = parseDate(body.expiresAt)
        if (!expiresAt || expiresAt.getTime() <= Date.now()) {
          return reply.code(400).send(
            formatError('INVALID_EXPIRY', 'expiresAt must be a future ISO timestamp'),
          )
        }
        if (body.scope !== 'global' && !body.targetId) {
          return reply.code(400).send(
            formatError('MISSING_TARGET', `targetId is required when scope is '${body.scope}'`),
          )
        }
        if (body.targetId && !ObjectId.isValid(body.targetId)) {
          return reply.code(400).send(
            formatError('INVALID_ID', 'targetId is not a valid ObjectId'),
          )
        }

        const mute = await ctx.adapter.recordMute({
          scope: body.scope,
          targetId: body.targetId ? new ObjectId(body.targetId) : undefined,
          expiresAt,
          mutedBy: body.mutedBy ?? 'api',
          reason: body.reason,
        })
        eventBus.emit('notification:muted', {
          timestamp: new Date(),
          scope: mute.scope,
          targetId: mute.targetId?.toHexString(),
          expiresAt: mute.expiresAt,
        })
        return reply.code(201).send({ data: mute })
      },
    )

    fastify.delete('/notifications/mutes/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Mute ID is not a valid ObjectId'))
      }
      const existing = await ctx.adapter.getMuteById(id)
      const deleted = await ctx.adapter.deleteMute(id)
      if (!deleted) {
        return reply.code(404).send(formatError('NOT_FOUND', `Mute ${id} not found`))
      }
      if (existing) {
        eventBus.emit('notification:unmuted', {
          timestamp: new Date(),
          scope: existing.scope,
          targetId: existing.targetId?.toHexString(),
        })
      }
      return reply.code(204).send()
    })

    // ── Endpoint-scoped ─────────────────────────────────────────────────────

    fastify.get('/endpoints/:id/notifications/log', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }
      const query = request.query as Record<string, string | undefined>
      const pagination = parsePagination(query)
      const filters = parseLogFilters(query)
      const page = await ctx.adapter.listNotificationLogForEndpoint(id, {
        ...pagination,
        ...filters,
      })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    fastify.get('/endpoints/:id/notifications/stats', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }
      const window = defaultWindow(request.query as Record<string, string | undefined>)
      const all = await ctx.adapter.countNotificationStats(window)
      const scoped = await ctx.adapter.listNotificationLogForEndpoint(id, {
        ...window,
        limit: 1,
      })
      // Re-run a scoped aggregation by fetching counts via the adapter's
      // filter-based list. For V1 we hand back the global stats plus the
      // endpoint total from the log page so the UI has a number to show.
      return reply.send({
        data: { ...all, endpointTotal: scoped.total },
        window,
      })
    })

    fastify.post(
      '/endpoints/:id/notifications/mute',
      { schema: { body: endpointMuteSchema } },
      async (request, reply) => {
        const { id } = request.params as { id: string }
        if (!ObjectId.isValid(id)) {
          return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
        }
        const body = request.body as { expiresAt: string; mutedBy?: string; reason?: string }
        const expiresAt = parseDate(body.expiresAt)
        if (!expiresAt || expiresAt.getTime() <= Date.now()) {
          return reply.code(400).send(
            formatError('INVALID_EXPIRY', 'expiresAt must be a future ISO timestamp'),
          )
        }
        const endpoint = await ctx.adapter.getEndpointById(id)
        if (!endpoint) {
          return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
        }
        const mute = await ctx.adapter.recordMute({
          scope: 'endpoint',
          targetId: new ObjectId(id),
          expiresAt,
          mutedBy: body.mutedBy ?? 'api',
          reason: body.reason,
        })
        eventBus.emit('notification:muted', {
          timestamp: new Date(),
          scope: 'endpoint',
          targetId: id,
          expiresAt: mute.expiresAt,
        })
        return reply.code(201).send({ data: mute })
      },
    )
  }
}

