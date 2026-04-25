/**
 * Endpoint routes (auth required).
 *
 * GET    /endpoints            — list active + paused
 * GET    /endpoints/:id        — single endpoint with latest check
 * POST   /endpoints            — create
 * POST   /endpoints/:id/clone  — duplicate as a paused "Copy of ..."
 * PUT    /endpoints/:id        — update
 * DELETE /endpoints/:id        — permanent hard delete
 * POST   /endpoints/:id/recheck — trigger immediate check
 * PATCH  /endpoints/:id/toggle  — active ↔ paused
 */

import type { FastifyInstance } from 'fastify'
import { eventBus } from '../../core/eventBus.js'
import { formatError, type ValidationError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'
import type { Assertion, EndpointDoc } from '../../storage/types.js'
import type { EventMap } from '../../core/eventTypes.js'
import { runHttpCheck } from '../../checks/httpCheck.js'
import { runPortCheck } from '../../checks/portCheck.js'
import { evaluateStatus } from '../../checks/evaluators/statusEval.js'
import { evaluateAssertions } from '../../checks/evaluators/assertionsEval.js'
import { evaluateSsl } from '../../checks/evaluators/sslEval.js'

// ---------------------------------------------------------------------------
// Body schemas (POST create, PUT update)
// ---------------------------------------------------------------------------

// Valid ranges for each per-endpoint monitoring override. Shared with the
// settings route so PUT /endpoints/:id and PUT /endpoints/:id/settings reject
// identical out-of-range values — and re-exported so the dashboard can surface
// the same numbers in input hints without drifting.
export const MONITORING_FIELD_RANGES = {
  checkInterval: { min: 30, max: 86_400 },
  timeout: { min: 1_000, max: 60_000 },
  latencyThreshold: { min: 100, max: 30_000 },
  sslWarningDays: { min: 0, max: 365 },
  failureThreshold: { min: 1, max: 10 },
  recoveryThreshold: { min: 1, max: 10 },
  alertCooldown: { min: 0, max: 7_200 },
  escalationDelay: { min: 0, max: 86_400 },
} as const

// Fields both routes accept. Deep validation for URL / host / port lives in
// the helpers below so create and update share the exact same rules.
export const mutableFieldProps = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 500 },
  // HTTP
  url: { type: 'string', minLength: 1 },
  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
  expectedStatusCodes: {
    type: 'array',
    items: { type: 'integer', minimum: 100, maximum: 599 },
  },
  assertions: {
    type: 'array',
    maxItems: 10,
    items: {
      type: 'object',
      required: ['kind', 'operator', 'severity'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['latency', 'body', 'header', 'json', 'ssl'] },
        operator: {
          type: 'string',
          enum: [
            'lt', 'lte', 'gt', 'gte', 'eq', 'neq',
            'contains', 'not_contains', 'equals',
            'exists', 'not_exists',
          ],
        },
        severity: { type: 'string', enum: ['down', 'degraded'] },
        target: { type: 'string', maxLength: 256 },
        value: { type: 'string', maxLength: 1000 },
      },
    },
  },
  // Port
  host: { type: 'string', minLength: 1 },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  // Shared overrides (integer ranges mirror MONITORING_FIELD_RANGES above)
  checkInterval: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.checkInterval.min,
    maximum: MONITORING_FIELD_RANGES.checkInterval.max,
  },
  timeout: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.timeout.min,
    maximum: MONITORING_FIELD_RANGES.timeout.max,
  },
  latencyThreshold: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.latencyThreshold.min,
    maximum: MONITORING_FIELD_RANGES.latencyThreshold.max,
  },
  sslWarningDays: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.sslWarningDays.min,
    maximum: MONITORING_FIELD_RANGES.sslWarningDays.max,
  },
  failureThreshold: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.failureThreshold.min,
    maximum: MONITORING_FIELD_RANGES.failureThreshold.max,
  },
  recoveryThreshold: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.recoveryThreshold.min,
    maximum: MONITORING_FIELD_RANGES.recoveryThreshold.max,
  },
  alertCooldown: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.alertCooldown.min,
    maximum: MONITORING_FIELD_RANGES.alertCooldown.max,
  },
  recoveryAlert: { type: 'boolean' },
  escalationDelay: {
    type: 'integer',
    minimum: MONITORING_FIELD_RANGES.escalationDelay.min,
    maximum: MONITORING_FIELD_RANGES.escalationDelay.max,
  },
  escalationChannelId: { type: ['string', 'null'] },
  notificationChannelIds: { type: 'array', items: { type: 'string' } },
  pausedNotificationChannelIds: { type: 'array', items: { type: 'string' } },
} as const

const createBodySchema = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    ...mutableFieldProps,
    type: { type: 'string', enum: ['http', 'port'] },
  },
  additionalProperties: false,
} as const

// Body schema for POST /endpoints/:id/test-assertions — optionally accepts a
// draft assertions array so the dashboard can test unsaved edits without a
// round-trip through Save first.
const testAssertionsBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assertions: mutableFieldProps.assertions,
  },
} as const

// Body schema for POST /endpoints/test-probe — the Add-endpoint flow's test
// button. Mirrors test-assertions but without a persisted endpoint: the full
// draft config travels in the body so the user can validate a probe before
// clicking Create.
const testProbeBodySchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: mutableFieldProps.url,
    method: mutableFieldProps.method,
    headers: mutableFieldProps.headers,
    expectedStatusCodes: mutableFieldProps.expectedStatusCodes,
    timeout: mutableFieldProps.timeout,
    latencyThreshold: mutableFieldProps.latencyThreshold,
    sslWarningDays: mutableFieldProps.sslWarningDays,
    assertions: mutableFieldProps.assertions,
  },
} as const

const updateBodySchema = {
  type: 'object',
  properties: mutableFieldProps,
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// Per-field validators shared by POST and PUT.
// Each returns null when the value is valid, or a ValidationError describing
// what went wrong. HTTP endpoints are rejected if the URL isn't parseable or
// uses a protocol other than http(s) — the check engine only speaks those.
// ---------------------------------------------------------------------------

function validateUrlValue(url: unknown): ValidationError | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return {
      field: 'body.url',
      value: url ?? null,
      expected: 'string — valid http:// or https:// URL',
      fix: 'Provide a URL starting with http:// or https://',
    }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      field: 'body.url',
      value: url,
      expected: 'valid http:// or https:// URL',
      fix: 'Ensure the URL includes protocol and host (e.g. https://api.example.com/health)',
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      field: 'body.url',
      value: url,
      expected: 'http:// or https:// protocol',
      fix: 'HTTP checks only support http:// or https:// — replace the scheme',
    }
  }
  return null
}

function validateHostValue(host: unknown): ValidationError | null {
  if (typeof host !== 'string' || host.trim() === '') {
    return {
      field: 'body.host',
      value: host ?? null,
      expected: 'string — hostname or IP address',
      fix: 'Provide a hostname or IP address',
    }
  }
  return null
}

function validatePortValue(port: unknown): ValidationError | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      field: 'body.port',
      value: port ?? null,
      expected: 'integer 1–65535',
      fix: 'Provide a TCP port number between 1 and 65535',
    }
  }
  return null
}

export function endpointsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

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

      // Type-specific required field validation — delegates deep checks to
      // the shared helpers so POST and PUT reject the same inputs.
      const validationErrors: ValidationError[] = []
      if (type === 'http') {
        const err = validateUrlValue(body.url)
        if (err) validationErrors.push(err)
      } else {
        const hostErr = validateHostValue(body.host)
        if (hostErr) validationErrors.push(hostErr)
        const portErr = validatePortValue(body.port)
        if (portErr) validationErrors.push(portErr)
      }

      if (validationErrors.length > 0) {
        return reply.code(422).send(
          formatError(
            'VALIDATION_ERROR',
            `Request body has ${validationErrors.length} error${validationErrors.length === 1 ? '' : 's'}`,
            validationErrors,
          ),
        )
      }

      const cfg = await ctx.adapter.getEffectiveDefaults(ctx.config)
      const now = new Date()

      const endpointData: Omit<EndpointDoc, 'id' | 'createdAt' | 'updatedAt'> = {
        name: body.name as string,
        ...(body.description ? { description: body.description as string } : {}),
        type,
        enabled: true,
        status: 'active',
        checkInterval: (body.checkInterval as number | undefined) ?? cfg.checkInterval,
        timeout: (body.timeout as number | undefined) ?? cfg.timeout,
        latencyThreshold: (body.latencyThreshold as number | undefined) ?? cfg.latencyThreshold,
        sslWarningDays: (body.sslWarningDays as number | undefined) ?? cfg.sslWarningDays,
        failureThreshold: (body.failureThreshold as number | undefined) ?? cfg.failureThreshold,
        recoveryThreshold: (body.recoveryThreshold as number | undefined) ?? cfg.recoveryThreshold,
        alertCooldown: (body.alertCooldown as number | undefined) ?? cfg.alertCooldown,
        recoveryAlert: (body.recoveryAlert as boolean | undefined) ?? cfg.recoveryAlert,
        escalationDelay: (body.escalationDelay as number | undefined) ?? cfg.escalationDelay,
        notificationChannelIds: ((body.notificationChannelIds as unknown[] | undefined) ?? [])
          .filter((v): v is string => typeof v === 'string'),
        consecutiveFailures: 0,
        consecutiveHealthy: 0,
      }

      if (type === 'http') {
        endpointData.url = body.url as string
        endpointData.method = (body.method as EndpointDoc['method']) ?? 'GET'
        endpointData.headers = (body.headers as Record<string, string>) ?? {}
        endpointData.expectedStatusCodes =
          (body.expectedStatusCodes as number[] | undefined) ?? cfg.expectedStatusCodes
        if (body.assertions) endpointData.assertions = body.assertions as EndpointDoc['assertions']
      } else {
        endpointData.host = body.host as string
        endpointData.port = body.port as number
      }

      const endpoint = await ctx.adapter.createEndpoint(endpointData)

      eventBus.emit('endpoint:created', { timestamp: now, endpoint })

      return reply.code(201).send({ data: endpoint })
    })

    // ── PUT /endpoints/:id ───────────────────────────────────────────────────
    fastify.put('/endpoints/:id', { schema: { body: updateBodySchema } }, async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      const changes = { ...(request.body as Record<string, unknown>) }

      // Deep validation for values the JSON schema only shallow-types. Only
      // fields actually present in the update payload are checked — partial
      // updates are the whole point of PUT here.
      const validationErrors: ValidationError[] = []
      if ('url' in changes) {
        if (existing.type !== 'http') {
          validationErrors.push({
            field: 'body.url',
            value: changes.url,
            expected: 'omitted — this endpoint is a port check, not HTTP',
            fix: 'Remove body.url; port endpoints use host + port instead',
          })
        } else {
          const err = validateUrlValue(changes.url)
          if (err) validationErrors.push(err)
        }
      }
      if ('host' in changes) {
        if (existing.type !== 'port') {
          validationErrors.push({
            field: 'body.host',
            value: changes.host,
            expected: 'omitted — this endpoint is HTTP, not a port check',
            fix: 'Remove body.host; HTTP endpoints use url instead',
          })
        } else {
          const err = validateHostValue(changes.host)
          if (err) validationErrors.push(err)
        }
      }
      if ('port' in changes) {
        if (existing.type !== 'port') {
          validationErrors.push({
            field: 'body.port',
            value: changes.port,
            expected: 'omitted — this endpoint is HTTP, not a port check',
            fix: 'Remove body.port; HTTP endpoints use url instead',
          })
        } else {
          const err = validatePortValue(changes.port)
          if (err) validationErrors.push(err)
        }
      }

      if (validationErrors.length > 0) {
        return reply.code(422).send(
          formatError(
            'VALIDATION_ERROR',
            `Request body has ${validationErrors.length} error${validationErrors.length === 1 ? '' : 's'}`,
            validationErrors,
          ),
        )
      }

      if (Array.isArray(changes.notificationChannelIds)) {
        changes.notificationChannelIds = (changes.notificationChannelIds as unknown[])
          .filter((v): v is string => typeof v === 'string')
      }
      if (Array.isArray(changes.pausedNotificationChannelIds)) {
        changes.pausedNotificationChannelIds = (changes.pausedNotificationChannelIds as unknown[])
          .filter((v): v is string => typeof v === 'string')
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

    // ── DELETE /endpoints/:id ────────────────────────────────────────────────
    // Permanent removal in V1. Historical checks and incidents stay in the DB
    // for aggregation and post-mortem, but the endpoint document itself is
    // hard-deleted. Archiving was removed because the two-path behaviour (soft
    // by default, hard via `?mode=hard`) surprised users; V2 will add a
    // distinct Archive action with its own UI. See V2 backlog item 7.
    fastify.delete('/endpoints/:id', async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      await ctx.adapter.deleteEndpoint(id)
      eventBus.emit('endpoint:deleted', {
        timestamp: new Date(),
        endpointId: id,
        name: existing.name,
      })

      return reply.code(204).send()
    })

    // ── POST /endpoints/:id/recheck ──────────────────────────────────────────
    fastify.post('/endpoints/:id/recheck', async (request, reply) => {
      const { id } = request.params as { id: string }
      const query = request.query as { wait?: string }


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

    // ── POST /endpoints/:id/clone ────────────────────────────────────────────
    // Duplicates the endpoint's config (URL/host, headers, thresholds, alerts,
    // assertions) under a "Copy of {name}" title. Fresh check history —
    // incidentId, consecutiveFailures, lastCheckAt are not carried over.
    fastify.post('/endpoints/:id/clone', async (request, reply) => {
      const { id } = request.params as { id: string }
      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      // Strip runtime-state fields; keep config.
      const {
        id: _omit_id,
        createdAt: _omit_createdAt,
        updatedAt: _omit_updatedAt,
        lastCheckAt: _omit_lastCheckAt,
        lastStatus: _omit_lastStatus,
        lastResponseTime: _omit_lastResponseTime,
        lastStatusCode: _omit_lastStatusCode,
        lastErrorMessage: _omit_lastErrorMessage,
        lastSslIssuer: _omit_lastSslIssuer,
        currentIncidentId: _omit_currentIncidentId,
        consecutiveFailures: _omit_consecutiveFailures,
        consecutiveHealthy: _omit_consecutiveHealthy,
        ...configFields
      } = existing

      const cloneData: Omit<EndpointDoc, 'id' | 'createdAt' | 'updatedAt'> = {
        ...configFields,
        name: `Copy of ${existing.name}`,
        status: 'paused', // safer default — the user hasn't reviewed it yet
        consecutiveFailures: 0,
        consecutiveHealthy: 0,
      }

      const clone = await ctx.adapter.createEndpoint(cloneData)

      eventBus.emit('endpoint:created', { timestamp: new Date(), endpoint: clone })

      return reply.code(201).send({ data: clone })
    })

    // ── PATCH /endpoints/:id/toggle ──────────────────────────────────────────
    fastify.patch('/endpoints/:id/toggle', async (request, reply) => {
      const { id } = request.params as { id: string }


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

    // ── POST /endpoints/test ──────────────────────────────────────────────
    // One-off connection test — does NOT save anything.
    fastify.post('/endpoints/test', async (request, reply) => {
      const body = request.body as {
        type: 'http' | 'port'
        url?: string
        method?: string
        headers?: Record<string, string>
        host?: string
        port?: number
        timeout?: number
      }

      if (!body || !body.type) {
        return reply.code(400).send(formatError('MISSING_TYPE', 'type is required (http | port)'))
      }

      const timeout = Math.min(body.timeout ?? 10_000, 15_000)

      if (body.type === 'http') {
        if (!body.url) {
          return reply.code(400).send(formatError('MISSING_URL', 'url is required for HTTP test'))
        }
        try {
          new URL(body.url)
        } catch {
          return reply.code(400).send(formatError('INVALID_URL', 'url is not a valid URL'))
        }

        const result = await runHttpCheck({
          url: body.url,
          method: body.method ?? 'GET',
          headers: body.headers,
          timeout,
          captureSsl: body.url.startsWith('https'),
        })

        return reply.send({
          data: {
            success: result.statusCode != null && result.statusCode >= 200 && result.statusCode < 400,
            statusCode: result.statusCode,
            responseTime: result.responseTime,
            sslDaysRemaining: result.sslDaysRemaining,
            errorMessage: result.errorMessage,
          },
        })
      }

      if (body.type === 'port') {
        if (!body.host || !body.port) {
          return reply.code(400).send(formatError('MISSING_HOST_PORT', 'host and port are required for port test'))
        }

        const result = await runPortCheck({
          host: body.host,
          port: body.port,
          timeout,
        })

        return reply.send({
          data: {
            success: result.portOpen,
            responseTime: result.responseTime,
            errorMessage: result.errorMessage,
          },
        })
      }

      return reply.code(400).send(formatError('INVALID_TYPE', 'type must be http or port'))
    })

    // ── POST /endpoints/test-probe ────────────────────────────────────────────
    // Add-endpoint flow's test button. Same probe + evaluator pipeline as
    // /endpoints/:id/test-assertions, but runs against the draft config in the
    // body — no persisted endpoint needed. Never emits check:complete, never
    // writes to mx_checks.
    fastify.post(
      '/endpoints/test-probe',
      { schema: { body: testProbeBodySchema } },
      async (request, reply) => {
        const body = request.body as {
          url: string
          method?: EndpointDoc['method']
          headers?: Record<string, string>
          expectedStatusCodes?: number[]
          timeout?: number
          latencyThreshold?: number
          sslWarningDays?: number
          assertions?: Assertion[]
        }

        const urlErr = validateUrlValue(body.url)
        if (urlErr) {
          return reply.code(422).send(
            formatError('VALIDATION_ERROR', 'Request body has 1 error', [urlErr]),
          )
        }

        const cfg = await ctx.adapter.getEffectiveDefaults(ctx.config)
        const timeout = body.timeout ?? cfg.timeout
        const expectedStatusCodes = body.expectedStatusCodes ?? cfg.expectedStatusCodes
        const latencyThreshold = body.latencyThreshold ?? cfg.latencyThreshold
        const sslWarningDays = body.sslWarningDays ?? cfg.sslWarningDays
        const assertions = body.assertions ?? []
        const isHttps = body.url.startsWith('https://')

        const probe = await runHttpCheck({
          url: body.url,
          method: body.method ?? 'GET',
          headers: body.headers ?? {},
          timeout,
          captureSsl: isHttps && ctx.config.modules.sslChecks,
          captureBodySize: ctx.config.captureBodySize,
          maxBodyBytesToRead: ctx.config.maxBodyBytesToRead,
        })

        const hasLatencyAssertion = assertions.some((r) => r.kind === 'latency')
        const hasSslAssertion = assertions.some((r) => r.kind === 'ssl')

        const base = evaluateStatus({
          type: 'http',
          statusCode: probe.statusCode,
          responseTime: probe.responseTime,
          errorMessage: probe.errorMessage,
          expectedStatusCodes,
          latencyThreshold,
          skipLatencyCheck: hasLatencyAssertion,
        })

        let baseStatus = base.status
        let baseReason = base.statusReason
        if (baseStatus === 'healthy' && !hasSslAssertion) {
          const sslEval_ = evaluateSsl({
            sslDaysRemaining: probe.sslDaysRemaining,
            sslWarningDays,
          })
          if (sslEval_.status === 'degraded') {
            baseStatus = 'degraded'
            baseReason = sslEval_.statusReason
          }
        }

        const assertionResult =
          baseStatus !== 'down' && assertions.length > 0
            ? evaluateAssertions({
                assertions,
                body: probe.body,
                headers: probe.headers,
                responseTime: probe.responseTime,
                sslDaysRemaining: probe.sslDaysRemaining,
                isHttps,
              })
            : null

        return reply.send({
          data: {
            baseStatus,
            baseReason,
            probe: {
              statusCode: probe.statusCode,
              responseTime: probe.responseTime,
              errorMessage: probe.errorMessage,
              contentType: probe.headers?.['content-type'] ?? null,
              bodyBytes: probe.bodyBytes,
              bodyBytesTruncated: probe.bodyBytesTruncated,
              sslDaysRemaining: probe.sslDaysRemaining,
            },
            assertionResult,
          },
        })
      },
    )

    // ── POST /endpoints/:id/test-assertions ───────────────────────────────────
    // Runs the endpoint's probe + evaluator once against the supplied (or
    // saved) assertions and returns the result. Does NOT emit check:complete,
    // does NOT persist to mx_checks — so the user can iterate on draft rules
    // without polluting the real check history.
    fastify.post(
      '/endpoints/:id/test-assertions',
      { schema: { body: testAssertionsBodySchema } },
      async (request, reply) => {
        const { id } = request.params as { id: string }
        const endpoint = await ctx.adapter.getEndpointById(id)
        if (!endpoint) {
          return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
        }
        if (endpoint.type !== 'http') {
          return reply.code(400).send(
            formatError('HTTP_ONLY', 'Assertions are only supported on HTTP endpoints'),
          )
        }

        const body = (request.body as { assertions?: Assertion[] } | undefined) ?? {}
        const assertions = body.assertions ?? endpoint.assertions ?? []
        const isHttps = (endpoint.url ?? '').startsWith('https://')

        // Mirror the scheduler's invocation exactly so the test produces the
        // same data a real check would — otherwise users would see "works in
        // test, fails in production" drift.
        const probe = await runHttpCheck({
          url: endpoint.url!,
          method: endpoint.method ?? 'GET',
          headers: endpoint.headers ?? {},
          timeout: endpoint.timeout,
          captureSsl: isHttps && ctx.config.modules.sslChecks,
          captureBodySize: ctx.config.captureBodySize,
          maxBodyBytesToRead: ctx.config.maxBodyBytesToRead,
        })

        const hasLatencyAssertion = assertions.some((r) => r.kind === 'latency')
        const hasSslAssertion = assertions.some((r) => r.kind === 'ssl')

        const base = evaluateStatus({
          type: 'http',
          statusCode: probe.statusCode,
          responseTime: probe.responseTime,
          errorMessage: probe.errorMessage,
          expectedStatusCodes: endpoint.expectedStatusCodes ?? [200],
          latencyThreshold: endpoint.latencyThreshold,
          skipLatencyCheck: hasLatencyAssertion,
        })

        // Mirror the checkRunner: SSL warning can upgrade healthy → degraded
        // when no SSL assertion is overriding. Keeps Test output consistent
        // with what a real scheduled check would produce.
        let baseStatus = base.status
        let baseReason = base.statusReason
        if (baseStatus === 'healthy' && !hasSslAssertion) {
          const sslEval_ = evaluateSsl({
            sslDaysRemaining: probe.sslDaysRemaining,
            sslWarningDays: endpoint.sslWarningDays,
          })
          if (sslEval_.status === 'degraded') {
            baseStatus = 'degraded'
            baseReason = sslEval_.statusReason
          }
        }

        const assertionResult =
          baseStatus !== 'down' && assertions.length > 0
            ? evaluateAssertions({
                assertions,
                body: probe.body,
                headers: probe.headers,
                responseTime: probe.responseTime,
                sslDaysRemaining: probe.sslDaysRemaining,
                isHttps,
              })
            : null

        return reply.send({
          data: {
            baseStatus,
            baseReason,
            probe: {
              statusCode: probe.statusCode,
              responseTime: probe.responseTime,
              errorMessage: probe.errorMessage,
              contentType: probe.headers?.['content-type'] ?? null,
              bodyBytes: probe.bodyBytes,
              bodyBytesTruncated: probe.bodyBytesTruncated,
              sslDaysRemaining: probe.sslDaysRemaining,
            },
            assertionResult,
          },
        })
      },
    )
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
