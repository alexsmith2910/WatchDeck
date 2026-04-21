/**
 * Probe-based health routes.
 *
 *   GET  /api/health            (auth)  → aggregated SystemHealthSnapshot
 *   GET  /api/health/:subsystem (auth)  → fresh probe result
 *   GET  /api/health/ping       (public)→ light liveness target used by the checker loopback probe
 *
 * `ping` is registered as a PUBLIC route by the parent server module because
 * probes hit it unauthenticated. The two auth-gated handlers are returned as
 * a separate plugin and registered inside the auth scope.
 *
 * Also preserves the dev-only simulated-outage endpoints from the old
 * /health/system route surface.
 */

import type { FastifyInstance } from 'fastify'
import { probeRegistry } from '../../core/health/probeRegistry.js'
import { buildSnapshot } from '../../core/health/snapshot.js'
import { eventBus } from '../../core/eventBus.js'
import { metaFor } from '../../core/health/subsystems.js'
import { formatError } from '../../utils/errors.js'
import type { AppContext } from '../server.js'

/**
 * Public probe routes. Contains only `/health/ping` — the authenticated
 * routes live in `healthProbeAuthedRoutes()` below.
 */
export function healthProbePublicRoutes(_ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    // Minimal liveness target. The checkers probe fetches this URL through
    // the real HTTP path, so this handler must stay fast, DB-free, and
    // unauthenticated.
    fastify.get('/health/ping', async (_req, reply) => {
      return reply.send({ ok: true })
    })
  }
}

const simulatedOutage: { startedAt: number | null } = { startedAt: null }

/** Auth-gated probe routes. Registered inside the auth scope in server.ts. */
export function healthProbeAuthedRoutes(_ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {
    // GET /health — the snapshot the System Health page polls/fetches.
    fastify.get('/health', async (_req, reply) => {
      const snapshot = buildSnapshot()
      return reply.send({ data: snapshot })
    })

    // GET /health/:subsystem — on-demand probe run. Returns the fresh result.
    fastify.get('/health/:subsystem', async (request, reply) => {
      const { subsystem } = request.params as { subsystem: string }
      // Defend against the public /health/ping route accidentally shadowing
      // this handler if registration ordering ever changes — explicitly reject
      // reserved names.
      if (subsystem === 'ping' || subsystem === 'system' || subsystem === 'history') {
        return reply.code(404).send(formatError('NOT_FOUND', `No probe named ${subsystem}`))
      }
      if (!metaFor(subsystem)) {
        return reply.code(404).send(formatError('NOT_FOUND', `No probe named ${subsystem}`))
      }
      const result = await probeRegistry.runOnce(subsystem)
      return reply.send({ data: result })
    })

    // ── Dev-only outage simulation — preserved per §3.4. ─────────────────
    fastify.post('/health/system/test/disconnect', async (_req, reply) => {
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

    fastify.post('/health/system/test/reconnect', async (_req, reply) => {
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
  }
}
