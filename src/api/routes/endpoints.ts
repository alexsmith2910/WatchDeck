/**
 * Endpoint routes (auth required).
 *
 * GET    /endpoints            — list active + paused
 * GET    /endpoints/archived   — list archived
 * GET    /endpoints/:id        — single endpoint with latest check
 * POST   /endpoints            — create
 * PUT    /endpoints/:id        — update
 * DELETE /endpoints/:id        — archive (default) or hard delete (?mode=hard)
 * POST   /endpoints/:id/recheck — trigger immediate check
 * PATCH  /endpoints/:id/toggle  — active ↔ paused
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { eventBus } from '../../core/eventBus.js'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'
import type { EndpointDoc } from '../../storage/types.js'
import type { EventMap } from '../../core/eventTypes.js'

// ---------------------------------------------------------------------------
// POST /endpoints body schema
// ---------------------------------------------------------------------------

const createBodySchema = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    type: { type: 'string', enum: ['http', 'port'] },
    // HTTP
    url: { type: 'string' },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    expectedStatusCodes: { type: 'array', items: { type: 'integer' } },
    bodyRules: { type: 'array' },
    // Port
    host: { type: 'string' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    // Shared optional overrides
    checkInterval: { type: 'integer' },
    timeout: { type: 'integer' },
    latencyThreshold: { type: 'integer' },
    sslWarningDays: { type: 'integer' },
    failureThreshold: { type: 'integer' },
    alertCooldown: { type: 'integer' },
    recoveryAlert: { type: 'boolean' },
    escalationDelay: { type: 'integer' },
    notificationChannelIds: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

export function endpointsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── GET /endpoints/archived ─────────────────────────────────────────────
    // Must be registered before /:id to avoid 'archived' being treated as an id.
    fastify.get('/endpoints/archived', async (request, reply) => {
      const query = request.query as { cursor?: string; limit?: string }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listEndpoints({ ...pagination, status: 'archived' })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    // ── GET /endpoints ───────────────────────────────────────────────────────
    fastify.get('/endpoints', async (request, reply) => {
      const query = request.query as {
        cursor?: string
        limit?: string
        status?: 'active' | 'paused'
        type?: 'http' | 'port'
      }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listEndpoints({
        ...pagination,
        status: query.status,
        type: query.type,
      })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    // ── GET /endpoints/:id ───────────────────────────────────────────────────
    fastify.get('/endpoints/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }
      const endpoint = await ctx.adapter.getEndpointById(id)
      if (!endpoint) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }
      const latestCheck = await ctx.adapter.getLatestCheck(id)
      return reply.send({ data: endpoint, latestCheck })
    })

    // ── POST /endpoints ──────────────────────────────────────────────────────
    fastify.post('/endpoints', { schema: { body: createBodySchema } }, async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const type = body.type as 'http' | 'port'

      // Module check
      if (type === 'port' && !ctx.config.modules.portChecks) {
        return reply.code(409).send(
          formatError('MODULE_DISABLED', 'Port checks are disabled', [
            {
              field: 'body.type',
              value: 'port',
              expected: 'modules.portChecks to be true',
              fix: 'Set modules.portChecks to true in watchdeck.config.js and restart',
            },
          ]),
        )
      }

      // Type-specific required field validation
      const validationErrors: ReturnType<typeof formatError>['errors'] = []
      if (type === 'http') {
        if (!body.url || typeof body.url !== 'string') {
          validationErrors!.push({
            field: 'body.url',
            value: body.url ?? null,
            expected: 'string — valid HTTP/HTTPS URL',
            fix: 'Provide a URL starting with http:// or https://',
          })
        } else {
          try { new URL(body.url as string) } catch {
            validationErrors!.push({
              field: 'body.url',
              value: body.url,
              expected: 'valid HTTP/HTTPS URL',
              fix: 'Ensure the URL includes protocol (https://...)',
            })
          }
        }
      } else {
        if (!body.host || typeof body.host !== 'string') {
          validationErrors!.push({
            field: 'body.host',
            value: body.host ?? null,
            expected: 'string — hostname or IP address',
            fix: 'Provide a hostname or IP address',
          })
        }
        if (body.port === undefined) {
          validationErrors!.push({
            field: 'body.port',
            value: null,
            expected: 'integer 1–65535',
            fix: 'Provide a TCP port number',
          })
        }
      }

      if (validationErrors!.length > 0) {
        return reply.code(422).send(
          formatError(
            'VALIDATION_ERROR',
            `Request body has ${validationErrors!.length} error${validationErrors!.length === 1 ? '' : 's'}`,
            validationErrors,
          ),
        )
      }

      const cfg = ctx.config.defaults
      const now = new Date()

      const endpointData: Omit<EndpointDoc, '_id' | 'createdAt' | 'updatedAt'> = {
        name: body.name as string,
        type,
        enabled: true,
        status: 'active',
        checkInterval: (body.checkInterval as number | undefined) ?? cfg.checkInterval,
        timeout: (body.timeout as number | undefined) ?? cfg.timeout,
        latencyThreshold: (body.latencyThreshold as number | undefined) ?? cfg.latencyThreshold,
        sslWarningDays: (body.sslWarningDays as number | undefined) ?? cfg.sslWarningDays,
        failureThreshold: (body.failureThreshold as number | undefined) ?? cfg.failureThreshold,
        alertCooldown: (body.alertCooldown as number | undefined) ?? cfg.alertCooldown,
        recoveryAlert: (body.recoveryAlert as boolean | undefined) ?? cfg.recoveryAlert,
        escalationDelay: (body.escalationDelay as number | undefined) ?? cfg.escalationDelay,
        notificationChannelIds: ((body.notificationChannelIds as string[] | undefined) ?? []).map(
          (id) => new ObjectId(id),
        ),
        maintenanceWindows: [],
        consecutiveFailures: 0,
      }

      if (type === 'http') {
        endpointData.url = body.url as string
        endpointData.method = (body.method as EndpointDoc['method']) ?? 'GET'
        endpointData.headers = (body.headers as Record<string, string>) ?? {}
        endpointData.expectedStatusCodes =
          (body.expectedStatusCodes as number[] | undefined) ?? cfg.expectedStatusCodes
        if (body.bodyRules) endpointData.bodyRules = body.bodyRules as EndpointDoc['bodyRules']
      } else {
        endpointData.host = body.host as string
        endpointData.port = body.port as number
      }

      const endpoint = await ctx.adapter.createEndpoint(endpointData)

      eventBus.emit('endpoint:created', { timestamp: now, endpoint })

      return reply.code(201).send({ data: endpoint })
    })

    // ── PUT /endpoints/:id ───────────────────────────────────────────────────
    fastify.put('/endpoints/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      const body = request.body as Record<string, unknown>
      // Strip immutable fields
      const { _id: _d, createdAt: _c, type: _t, ...changes } = body

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

    // ── DELETE /endpoints/:id ────────────────────────────────────────────────
    fastify.delete('/endpoints/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const query = request.query as { mode?: string }
      const mode = query.mode === 'hard' ? 'hard' : 'archive'

      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      if (mode === 'hard') {
        await ctx.adapter.deleteEndpoint(id)
        eventBus.emit('endpoint:deleted', {
          timestamp: new Date(),
          endpointId: id,
          name: existing.name,
        })
      } else {
        await ctx.adapter.updateEndpoint(id, { status: 'archived', enabled: false })
        eventBus.emit('endpoint:updated', {
          timestamp: new Date(),
          endpointId: id,
          changes: { status: 'archived', enabled: false },
        })
      }

      return reply.code(204).send()
    })

    // ── POST /endpoints/:id/recheck ──────────────────────────────────────────
    fastify.post('/endpoints/:id/recheck', async (request, reply) => {
      const { id } = request.params as { id: string }
      const query = request.query as { wait?: string }

      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const endpoint = await ctx.adapter.getEndpointById(id)
      if (!endpoint) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }
      if (endpoint.status === 'archived') {
        return reply
          .code(409)
          .send(formatError('ENDPOINT_ARCHIVED', 'Cannot recheck an archived endpoint'))
      }

      const scheduled = ctx.scheduler.scheduleImmediate(id)
      if (!scheduled) {
        return reply
          .code(409)
          .send(formatError('NOT_SCHEDULED', 'Endpoint is not currently in the scheduler (paused?)'))
      }

      if (query.wait === 'true') {
        try {
          const result = await waitForCheckComplete(id, endpoint.timeout + 10_000)
          return reply.code(200).send({ data: result })
        } catch {
          return reply.code(202).send({ status: 'scheduled', message: 'Check timed out waiting for result' })
        }
      }

      return reply.code(202).send({ status: 'scheduled' })
    })

    // ── PATCH /endpoints/:id/toggle ──────────────────────────────────────────
    fastify.patch('/endpoints/:id/toggle', async (request, reply) => {
      const { id } = request.params as { id: string }

      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }
      if (existing.status === 'archived') {
        return reply
          .code(409)
          .send(formatError('ENDPOINT_ARCHIVED', 'Cannot toggle an archived endpoint'))
      }

      const newStatus = existing.status === 'active' ? 'paused' : 'active'
      const updated = await ctx.adapter.updateEndpoint(id, { status: newStatus })

      eventBus.emit('endpoint:updated', {
        timestamp: new Date(),
        endpointId: id,
        changes: { status: newStatus },
      })

      return reply.send({ data: updated })
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForCheckComplete(
  endpointId: string,
  timeoutMs: number,
): Promise<EventMap['check:complete']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('Timed out'))
    }, timeoutMs)

    const unsub = eventBus.subscribe('check:complete', (payload) => {
      if (payload.endpointId === endpointId) {
        clearTimeout(timer)
        unsub()
        resolve(payload)
      }
    })
  })
}
