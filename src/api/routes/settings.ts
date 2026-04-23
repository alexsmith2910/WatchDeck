/**
 * Settings routes (auth required).
 *
 * GET /settings               — global runtime settings
 * PUT /settings               — update global settings
 * GET /endpoints/:id/settings — per-endpoint config overrides
 * PUT /endpoints/:id/settings — update per-endpoint overrides
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { eventBus } from '../../core/eventBus.js'
import { formatError } from '../../utils/errors.js'
import type { AppContext } from '../server.js'
import type { EndpointDoc } from '../../storage/types.js'
import { mutableFieldProps } from './endpoints.js'

/** Endpoint fields that can be overridden per-endpoint via the settings API. */
const OVERRIDABLE_FIELDS = [
  'checkInterval',
  'timeout',
  'latencyThreshold',
  'sslWarningDays',
  'failureThreshold',
  'alertCooldown',
  'recoveryAlert',
  'escalationDelay',
  'escalationChannelId',
  'notificationChannelIds',
  'assertions',
] as const

// Narrow the shared mutable-field schema down to the fields this route accepts,
// so range enforcement matches PUT /endpoints/:id exactly.
const settingsBodyProps = Object.fromEntries(
  OVERRIDABLE_FIELDS.map((f) => [f, mutableFieldProps[f]]),
) as { [K in (typeof OVERRIDABLE_FIELDS)[number]]: (typeof mutableFieldProps)[K] }

const settingsBodySchema = {
  type: 'object',
  properties: settingsBodyProps,
  additionalProperties: false,
} as const

export function settingsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── Global settings ───────────────────────────────────────────────────────

    fastify.get('/settings', async (_request, reply) => {
      const settings = await ctx.adapter.getSettings()
      return reply.send({ data: settings })
    })

    // ── Module toggles (read-only view of ctx.config.modules) ────────────────
    // The dashboard uses this to disable channel types / transports whose
    // backing module is off. Changing module state still requires editing
    // watchdeck.config.js and restarting.
    fastify.get('/modules', async (_request, reply) => {
      return reply.send({ data: ctx.config.modules })
    })

    // ── SLO config (read-only view of ctx.config.slo) ────────────────────────
    // Drives the "SLO burn rate" KPI card on the endpoint detail page.
    fastify.get('/slo', async (_request, reply) => {
      return reply.send({ data: ctx.config.slo })
    })

    // ── Runtime info (read-only view of static server-side runtime values) ──
    // Used by the dashboard for fields that are constant for the process
    // lifetime — currently the probe name shown on every check row.
    fastify.get('/runtime', async (_request, reply) => {
      return reply.send({ data: { probeName: ctx.config.probeName } })
    })

    fastify.put('/settings', async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const { _id: _d, ...changes } = body
      const updated = await ctx.adapter.updateSettings(changes)
      return reply.send({ data: updated })
    })

    // ── Per-endpoint settings ─────────────────────────────────────────────────

    fastify.get('/endpoints/:id/settings', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }
      const endpoint = await ctx.adapter.getEndpointById(id)
      if (!endpoint) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }
      // Return only the overridable fields
      const overrides: Record<string, unknown> = {}
      for (const field of OVERRIDABLE_FIELDS) {
        if (endpoint[field] !== undefined) overrides[field] = endpoint[field]
      }
      return reply.send({ data: overrides })
    })

    fastify.put('/endpoints/:id/settings', { schema: { body: settingsBodySchema } }, async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }
      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      const body = request.body as Record<string, unknown>
      // Only allow overridable fields
      const changes: Record<string, unknown> = {}
      for (const field of OVERRIDABLE_FIELDS) {
        if (field in body) changes[field] = body[field]
      }

      if (Object.keys(changes).length === 0) {
        return reply.code(422).send(
          formatError('VALIDATION_ERROR', 'No overridable fields found in request body'),
        )
      }

      // Coerce ID-typed fields back into ObjectIds — the dispatcher's fan-out
      // reads these as ObjectId instances, and mixing strings crashes at
      // runtime. Mirrors the same coercion in PUT /endpoints/:id.
      if (Array.isArray(changes.notificationChannelIds)) {
        changes.notificationChannelIds = (changes.notificationChannelIds as unknown[])
          .filter((v): v is string => typeof v === 'string' && ObjectId.isValid(v))
          .map((v) => new ObjectId(v))
      }
      if (typeof changes.escalationChannelId === 'string') {
        changes.escalationChannelId = ObjectId.isValid(changes.escalationChannelId)
          ? new ObjectId(changes.escalationChannelId)
          : null
      }

      const updated = await ctx.adapter.updateEndpoint(id, changes as Partial<EndpointDoc>)
      if (!updated) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      eventBus.emit('endpoint:updated', {
        timestamp: new Date(),
        endpointId: id,
        changes: changes as Partial<EndpointDoc>,
      })

      return reply.send({ data: updated })
    })
  }
}
