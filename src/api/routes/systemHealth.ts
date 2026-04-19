/**
 * System Health routes (auth required).
 *
 * GET  /health/system                     — full system-health snapshot
 * POST /health/system/incidents/:id/ack  — acknowledge an internal incident
 *
 * The snapshot is fully synthesised in-process by the SystemMetricsCollector
 * (src/core/systemMetrics.ts) — no DB reads on the hot path.
 */

import type { FastifyInstance } from 'fastify'
import { systemMetrics } from '../../core/systemMetrics.js'
import { eventBus } from '../../core/eventBus.js'
import { formatError } from '../../utils/errors.js'
import type { AppContext } from '../server.js'

const VALID_RANGES = ['1h', '24h', '7d'] as const
type Range = (typeof VALID_RANGES)[number]

const simulatedOutage: { startedAt: number | null } = { startedAt: null }

export function systemHealthRoutes(_ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/health/system', async (request, reply) => {
      const query = request.query as { range?: string } | undefined
      const rawRange = query?.range
      const range: Range = (VALID_RANGES as readonly string[]).includes(rawRange ?? '')
        ? (rawRange as Range)
        : '24h'

      const snapshot = systemMetrics.getSnapshot(range)
      return reply.send({ data: snapshot })
    })

    // Dev-only: simulate a DB outage to exercise the buffer pipeline end-to-end.
    // Emits db:disconnected, which flips the pipeline into buffering mode.
    // Real check results will accumulate in memory (then spill to disk) until
    // /reconnect is called. Does NOT actually disconnect MongoDB.
    fastify.post('/health/system/test/disconnect', async (_request, reply) => {
      if (simulatedOutage.startedAt) {
        return reply.send({ data: { simulated: true, startedAt: simulatedOutage.startedAt } })
      }
      simulatedOutage.startedAt = Date.now()
      eventBus.emit('db:disconnected', {
        timestamp: new Date(),
        error: 'Simulated outage (dev test)',
      })
      return reply.send({ data: { simulated: true, startedAt: simulatedOutage.startedAt } })
    })

    fastify.post('/health/system/test/reconnect', async (_request, reply) => {
      if (!simulatedOutage.startedAt) {
        return reply.send({ data: { simulated: false, message: 'No simulated outage active' } })
      }
      const outageDurationSeconds = Math.round((Date.now() - simulatedOutage.startedAt) / 1000)
      simulatedOutage.startedAt = null
      eventBus.emit('db:reconnected', {
        timestamp: new Date(),
        outageDurationSeconds,
        bufferedResults: 0,
      })
      return reply.send({ data: { simulated: true, outageDurationSeconds } })
    })

    fastify.post('/health/system/incidents/:id/ack', async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { by?: string }
      const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : 'operator'
      const ok = systemMetrics.acknowledgeIncident(id, by)
      if (!ok) {
        return reply.code(404).send(
          formatError('NOT_FOUND', `Active internal incident ${id} not found`),
        )
      }
      return reply.send({ data: { id, ack: by } })
    })
  }
}
