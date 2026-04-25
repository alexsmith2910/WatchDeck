/**
 * Incident routes (auth required).
 *
 * GET /incidents        — list all (cursor pagination, ?status, ?endpointId, ?from, ?to)
 * GET /incidents/active — active incidents only
 * GET /incidents/stats  — pre-aggregated trends + KPIs for a window
 * GET /incidents/:id    — single incident with timeline
 */

import type { FastifyInstance } from 'fastify'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

export function incidentsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // Must be before /:id to avoid 'active' being matched as an id
    fastify.get('/incidents/active', async (_request, reply) => {
      const incidents = await ctx.adapter.listActiveIncidents()
      return reply.send({ data: incidents })
    })

    fastify.get('/incidents/stats', async (request, reply) => {
      const query = request.query as {
        from?: string
        to?: string
        endpointId?: string
        tz?: string
      }
      const from = parseDate(query.from)
      if (!from) {
        return reply.code(400).send(
          formatError('INVALID_QUERY', '`from` is required and must be an ISO timestamp', [
            {
              field: 'from',
              value: query.from ?? null,
              expected: 'ISO 8601 timestamp',
              fix: 'Pass ?from=<iso> (e.g. ?from=2026-04-08T00:00:00Z)',
            },
          ]),
        )
      }
      const to = parseDate(query.to) ?? new Date()
      if (to.getTime() < from.getTime()) {
        return reply.code(400).send(
          formatError('INVALID_QUERY', '`to` must be greater than or equal to `from`', [
            {
              field: 'to',
              value: query.to ?? null,
              expected: 'ISO timestamp >= from',
              fix: 'Pass a later `to` or omit it to default to now',
            },
          ]),
        )
      }
      const stats = await ctx.adapter.getIncidentStats({
        from,
        to,
        endpointId: query.endpointId,
        tz: query.tz,
      })
      return reply.send({
        data: stats,
        window: { from: from.toISOString(), to: to.toISOString() },
      })
    })

    fastify.get('/incidents', async (request, reply) => {
      const query = request.query as {
        cursor?: string
        limit?: string
        status?: 'active' | 'resolved'
        endpointId?: string
        from?: string
        to?: string
      }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listIncidents({
        ...pagination,
        status: query.status,
        endpointId: query.endpointId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    fastify.get('/incidents/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const incident = await ctx.adapter.getIncidentById(id)
      if (!incident) {
        return reply.code(404).send(formatError('NOT_FOUND', `Incident ${id} not found`))
      }
      return reply.send({ data: incident })
    })
  }
}
