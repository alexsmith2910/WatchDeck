/**
 * Auth-gated health history route.
 *
 * GET /health/history — recent system events (auth required).
 *
 * The public /health/ping liveness target and the /health snapshot now live
 * in routes/healthProbes.ts as part of the probe-based health system.
 */

import type { FastifyInstance } from 'fastify'
import { getClientCount } from '../sse.js'
import type { AppContext } from '../server.js'

/** Auth-protected history route — registered inside the auth scope in server.ts. */
export function healthHistoryRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/health/history', async (_req, reply) => {
      const events = await ctx.adapter.getSystemEvents(50)
      return reply.send({ data: events, sseClients: getClientCount() })
    })
  }
}
