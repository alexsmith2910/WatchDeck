/**
 * Health routes — all public, no auth.
 *
 * GET /health        — system status (DB, scheduler, uptime)
 * GET /health/ping   — always 200 { status: "ok" }
 * GET /health/history — recent system events (auth required — registered separately)
 */

import type { FastifyInstance } from 'fastify'
import { getClientCount } from '../sse.js'
import type { AppContext } from '../server.js'

export function healthRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    // GET /health/ping — lightest possible liveness probe
    fastify.get('/health/ping', async (_req, reply) => {
      return reply.send({ status: 'ok' })
    })

    // GET /health — full system status
    fastify.get('/health', async (_req, reply) => {
      const db = await ctx.adapter.healthCheck()
      return reply.send({
        status: db.status,
        db: { status: db.status, latencyMs: db.latencyMs },
        scheduler: {
          running: true,
          queueSize: ctx.scheduler.queueSize,
          activeChecks: ctx.scheduler.runningChecks,
        },
        uptime: Math.floor(process.uptime()),
        timestamp: new Date(),
      })
    })
  }
}

/** Auth-protected history route — registered inside the auth scope in server.ts. */
export function healthHistoryRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/health/history', async (_req, reply) => {
      const events = await ctx.adapter.getSystemEvents(50)
      return reply.send({ data: events, sseClients: getClientCount() })
    })
  }
}
