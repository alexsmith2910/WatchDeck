/**
 * Maintenance window routes (auth required).
 *
 * POST   /maintenance     — create windows (one per endpointId in the list)
 * GET    /maintenance     — list active + scheduled
 * DELETE /maintenance/:id — cancel a window
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { formatError } from '../../utils/errors.js'
import type { AppContext } from '../server.js'

const createSchema = {
  type: 'object',
  required: ['endpointIds', 'startTime', 'endTime', 'reason'],
  properties: {
    endpointIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    startTime: { type: 'string', format: 'date-time' },
    endTime: { type: 'string', format: 'date-time' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
  additionalProperties: false,
} as const

export function maintenanceRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    fastify.post('/maintenance', { schema: { body: createSchema } }, async (request, reply) => {
      const body = request.body as {
        endpointIds: string[]
        startTime: string
        endTime: string
        reason: string
      }

      const startTime = new Date(body.startTime)
      const endTime = new Date(body.endTime)

      if (endTime <= startTime) {
        return reply.code(422).send(
          formatError('VALIDATION_ERROR', 'endTime must be after startTime', [
            {
              field: 'body.endTime',
              value: body.endTime,
              expected: 'date-time after startTime',
              fix: 'Provide an endTime that is after startTime',
            },
          ]),
        )
      }

      // Validate all endpoint IDs
      const invalidIds = body.endpointIds.filter((id) => !ObjectId.isValid(id))
      if (invalidIds.length > 0) {
        return reply.code(400).send(
          formatError('INVALID_ID', `Invalid endpoint IDs: ${invalidIds.join(', ')}`),
        )
      }

      const windows = await ctx.adapter.addMaintenanceWindows(body.endpointIds, {
        startTime,
        endTime,
        reason: body.reason,
      })

      return reply.code(201).send({ data: windows })
    })

    fastify.get('/maintenance', async (_request, reply) => {
      const entries = await ctx.adapter.listMaintenanceWindows()
      const now = new Date()
      const data = entries.map(({ endpoint, window: w }) => ({
        windowId: w._id.toHexString(),
        endpointId: endpoint._id.toHexString(),
        endpointName: endpoint.name,
        startTime: w.startTime,
        endTime: w.endTime,
        reason: w.reason,
        status: w.startTime <= now ? 'active' : 'scheduled',
      }))
      return reply.send({ data })
    })

    fastify.delete('/maintenance/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Window ID is not a valid ObjectId'))
      }
      const removed = await ctx.adapter.removeMaintenanceWindow(id)
      if (!removed) {
        return reply.code(404).send(formatError('NOT_FOUND', `Maintenance window ${id} not found`))
      }
      return reply.code(204).send()
    })
  }
}
