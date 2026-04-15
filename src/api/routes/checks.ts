/**
 * Check history routes (auth required).
 *
 * GET /endpoints/:id/checks  — paginated raw check results
 * GET /endpoints/:id/hourly  — hourly summaries
 * GET /endpoints/:id/daily   — daily summaries
 * GET /endpoints/:id/uptime  — 24h/7d/30d/90d uptime percentages
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'

export function checksRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── GET /endpoints/:id/checks ────────────────────────────────────────────
    fastify.get('/endpoints/:id/checks', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as {
        cursor?: string
        limit?: string
        from?: string
        to?: string
        status?: 'healthy' | 'degraded' | 'down'
      }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listChecks(id, {
        ...pagination,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        status: query.status,
      })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    // ── GET /endpoints/:id/hourly ────────────────────────────────────────────
    fastify.get('/endpoints/:id/hourly', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as { limit?: string }
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 48, 200) : 48
      const summaries = await ctx.adapter.listHourlySummaries(id, { limit })
      return reply.send({ data: summaries })
    })

    // ── GET /endpoints/:id/daily ─────────────────────────────────────────────
    fastify.get('/endpoints/:id/daily', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as { limit?: string }
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 90, 365) : 90
      const summaries = await ctx.adapter.listDailySummaries(id, { limit })
      return reply.send({ data: summaries })
    })

    // ── GET /endpoints/:id/uptime ────────────────────────────────────────────
    fastify.get('/endpoints/:id/uptime', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const stats = await ctx.adapter.getUptimeStats(id)
      return reply.send({ data: stats })
    })
  }
}
