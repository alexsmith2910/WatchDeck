/**
 * Notification routes (auth required).
 *
 * GET    /notifications/channels        — list channels
 * POST   /notifications/channels        — add channel
 * PUT    /notifications/channels/:id    — update channel
 * DELETE /notifications/channels/:id    — remove channel
 * POST   /notifications/channels/:id/test — send test message
 * GET    /notifications/log             — delivery log (cursor pagination)
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'

const createChannelSchema = {
  type: 'object',
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: ['discord', 'slack', 'email'] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    deliveryPriority: { type: 'string', enum: ['standard', 'critical'] },
    // Discord
    discordWebhookUrl: { type: 'string' },
    discordChannelId: { type: 'string' },
    discordGuildId: { type: 'string' },
    // Slack
    slackWebhookUrl: { type: 'string' },
    slackChannelId: { type: 'string' },
    slackWorkspaceName: { type: 'string' },
    // Email
    emailEndpoint: { type: 'string' },
    emailRecipients: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

export function notificationsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── Channels ─────────────────────────────────────────────────────────────

    fastify.get('/notifications/channels', async (_request, reply) => {
      const channels = await ctx.adapter.listNotificationChannels()
      return reply.send({ data: channels })
    })

    fastify.post(
      '/notifications/channels',
      { schema: { body: createChannelSchema } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>

        // Module check
        if (body.type === 'discord' && !ctx.config.modules.discord) {
          return reply.code(409).send(
            formatError('MODULE_DISABLED', 'Discord notifications are disabled', [
              {
                field: 'body.type',
                value: 'discord',
                expected: 'modules.discord to be true',
                fix: 'Set modules.discord to true in watchdeck.config.js and restart',
              },
            ]),
          )
        }
        if (body.type === 'slack' && !ctx.config.modules.slack) {
          return reply.code(409).send(
            formatError('MODULE_DISABLED', 'Slack notifications are disabled', [
              {
                field: 'body.type',
                value: 'slack',
                expected: 'modules.slack to be true',
                fix: 'Set modules.slack to true in watchdeck.config.js and restart',
              },
            ]),
          )
        }

        const channel = await ctx.adapter.createNotificationChannel({
          type: body.type as 'discord' | 'slack' | 'email',
          name: body.name as string,
          deliveryPriority: (body.deliveryPriority as 'standard' | 'critical') ?? 'standard',
          isConnected: false,
          ...body,
        } as Parameters<typeof ctx.adapter.createNotificationChannel>[0])

        return reply.code(201).send({ data: channel })
      },
    )

    fastify.put('/notifications/channels/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
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
      return reply.send({ data: updated })
    })

    fastify.delete('/notifications/channels/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
      }
      const deleted = await ctx.adapter.deleteNotificationChannel(id)
      if (!deleted) {
        return reply.code(404).send(formatError('NOT_FOUND', `Channel ${id} not found`))
      }
      return reply.code(204).send()
    })

    // ── Test channel ─────────────────────────────────────────────────────────

    fastify.post('/notifications/channels/:id/test', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Channel ID is not a valid ObjectId'))
      }
      const channels = await ctx.adapter.listNotificationChannels()
      const channel = channels.find((c) => c._id.toHexString() === id)
      if (!channel) {
        return reply.code(404).send(formatError('NOT_FOUND', `Channel ${id} not found`))
      }
      // Notification dispatcher not yet implemented (Step 14) — acknowledge only.
      return reply.send({
        status: 'accepted',
        message: 'Test delivery queued (notification dispatcher coming in a future step)',
      })
    })

    // ── Log ──────────────────────────────────────────────────────────────────

    fastify.get('/notifications/log', async (request, reply) => {
      const query = request.query as { cursor?: string; limit?: string }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listNotificationLog(pagination)
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })
  }
}
