/**
 * Fastify server factory.
 *
 * buildServer() wires up:
 *   - CORS (@fastify/cors)
 *   - Custom error handler (WatchDeck error format)
 *   - Public routes: GET /health, GET /health/ping (no auth)
 *   - Auth-gated scope: all other routes
 *
 * The returned FastifyInstance is not yet listening — call listen() in start.ts.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './middleware/auth.js'
import { errorHandler } from './utils/errorHandler.js'
import { healthRoutes, healthHistoryRoutes } from './routes/health.js'
import { endpointsRoutes } from './routes/endpoints.js'
import { checksRoutes } from './routes/checks.js'
import { incidentsRoutes } from './routes/incidents.js'
import { notificationsRoutes } from './routes/notifications.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { settingsRoutes } from './routes/settings.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'
import type { CheckScheduler } from '../core/scheduler.js'

export interface AppContext {
  adapter: StorageAdapter
  scheduler: CheckScheduler
  config: WatchDeckConfig
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  // ── CORS ────────────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: ctx.config.cors.origin,
    credentials: ctx.config.cors.credentials,
  })

  // ── Error handler ────────────────────────────────────────────────────────────
  fastify.setErrorHandler(errorHandler)

  const base = ctx.config.apiBasePath

  // ── Public routes (no auth) ──────────────────────────────────────────────────
  await fastify.register(healthRoutes(ctx), { prefix: base })

  // ── Auth-gated scope ─────────────────────────────────────────────────────────
  await fastify.register(async (app) => {
    await app.register(authPlugin, { config: ctx.config })

    await app.register(healthHistoryRoutes(ctx), { prefix: base })
    await app.register(endpointsRoutes(ctx), { prefix: base })
    await app.register(checksRoutes(ctx), { prefix: base })
    await app.register(incidentsRoutes(ctx), { prefix: base })
    await app.register(notificationsRoutes(ctx), { prefix: base })
    await app.register(maintenanceRoutes(ctx), { prefix: base })
    await app.register(settingsRoutes(ctx), { prefix: base })
  })

  return fastify
}
