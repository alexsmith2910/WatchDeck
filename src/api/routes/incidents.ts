/**
 * Incident routes (auth required).
 *
 * GET /incidents        — list all (cursor pagination, ?status, ?endpointId, ?from, ?to)
 * GET /incidents/active — active incidents only
 * GET /incidents/:id    — single incident with timeline
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import type { AppContext } from '../server.js'

export function incidentsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // Must be before /:id to avoid 'active' being matched as an id
    fastify.get('/incidents/active', async (_request, reply) => {
      const incidents = await ctx.adapter.listActiveIncidents()
      return reply.send({ data: incidents })
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
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Incident ID is not a valid ObjectId'))
      }
      const incident = await ctx.adapter.getIncidentById(id)
      if (!incident) {
        return reply.code(404).send(formatError('NOT_FOUND', `Incident ${id} not found`))
      }
      return reply.send({ data: incident })
    })
  }
}
