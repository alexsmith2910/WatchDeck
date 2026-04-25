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

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import chalk from 'chalk'
import authPlugin from './middleware/auth.js'
import { errorHandler } from './utils/errorHandler.js'
import { formatError } from '../utils/errors.js'
import { healthHistoryRoutes } from './routes/health.js'
import { endpointsRoutes } from './routes/endpoints.js'
import { checksRoutes } from './routes/checks.js'
import { incidentsRoutes } from './routes/incidents.js'
import { notificationsRoutes } from './routes/notifications.js'
import { settingsRoutes } from './routes/settings.js'
import { healthProbePublicRoutes, healthProbeAuthedRoutes } from './routes/healthProbes.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'
import { sseRoutes } from './sse.js'
import { dashboardPlugin } from './dashboard.js'
import type { CheckScheduler } from '../core/scheduler.js'
import type { NotificationDispatcher } from '../notifications/dispatcher.js'

export interface AppContext {
  adapter: StorageAdapter
  scheduler: CheckScheduler
  config: WatchDeckConfig
  /** Wired up in start.ts — routes read metrics + call test/retry paths through it. */
  notifications?: NotificationDispatcher
  logRequests?: boolean
  /**
   * When true, register the dashboard SPA plugin at `config.dashboardRoute`.
   * False for `--api-only` and for `dashboardMode: 'mounted'` (the host app
   * embeds the dashboard component itself).
   */
  serveDashboard?: boolean
}

// ---------------------------------------------------------------------------
// Request log formatting
// ---------------------------------------------------------------------------

const OBJECTID_RE = /[0-9a-f]{24}/g
const PATH_WIDTH = 42

function methodColor(method: string): string {
  switch (method) {
    case 'GET':    return chalk.cyan(method.padEnd(6))
    case 'POST':   return chalk.yellow(method.padEnd(6))
    case 'PUT':    return chalk.magenta(method.padEnd(6))
    case 'PATCH':  return chalk.magenta(method.padEnd(6))
    case 'DELETE': return chalk.red(method.padEnd(6))
    default:       return chalk.white(method.padEnd(6))
  }
}

function statusColor(code: number): string {
  const s = String(code)
  if (code < 300) return chalk.green(s)
  if (code < 400) return chalk.cyan(s)
  if (code < 500) return chalk.yellow(s)
  return chalk.red(s)
}

/**
 * Format the URL for display:
 *   1. Strip query string
 *   2. Strip the API base path prefix (e.g. /api/mx)
 *   3. Abbreviate 24-hex ObjectIds → first6…last4
 *   4. Pad/truncate to PATH_WIDTH
 */
function formatPath(url: string, basePath: string): string {
  const bare = url.split('?')[0] ?? url
  const stripped = bare.startsWith(basePath) ? bare.slice(basePath.length) || '/' : bare
  const abbrev = stripped.replace(OBJECTID_RE, (id) => `${id.slice(0, 6)}…${id.slice(-4)}`)
  if (abbrev.length <= PATH_WIDTH) return abbrev.padEnd(PATH_WIDTH)
  return abbrev.slice(0, PATH_WIDTH - 1) + '…'
}

function logRequest(method: string, url: string, statusCode: number, ms: number, basePath: string): void {
  const time = chalk.dim(`${Math.round(ms)}ms`)
  const path = chalk.white(formatPath(url, basePath))
  console.log(`  ${chalk.dim('→')}  ${methodColor(method)} ${path}  ${statusColor(statusCode)}  ${time}`)
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

  // ── Not found handler ────────────────────────────────────────────────────────
  fastify.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    void reply.code(404).send(formatError('NOT_FOUND', 'Route not found'))
  })

  // ── Request logger (verbose mode only) ──────────────────────────────────────
  if (ctx.logRequests) {
    const basePath = ctx.config.apiBasePath
    fastify.addHook('onResponse', (request, reply, done) => {
      logRequest(request.method, request.url, reply.statusCode, reply.elapsedTime, basePath)
      done()
    })
  }

  const base = ctx.config.apiBasePath

  // ── Public routes (no auth) ──────────────────────────────────────────────────
  // GET /health/ping is the only public route — superseded the legacy
  // unauthenticated /health snapshot per the system-health redesign.
  await fastify.register(healthProbePublicRoutes(ctx), { prefix: base })

  // ── Auth-gated scope ─────────────────────────────────────────────────────────
  await fastify.register(async (app) => {
    await app.register(authPlugin, { config: ctx.config })

    await app.register(healthHistoryRoutes(ctx), { prefix: base })
    await app.register(endpointsRoutes(ctx), { prefix: base })
    await app.register(checksRoutes(ctx), { prefix: base })
    await app.register(incidentsRoutes(ctx), { prefix: base })
    await app.register(notificationsRoutes(ctx), { prefix: base })
    await app.register(settingsRoutes(ctx), { prefix: base })
    await app.register(healthProbeAuthedRoutes(ctx), { prefix: base })
    await app.register(sseRoutes(ctx), { prefix: base })
  })

  // ── Dashboard SPA (standalone mode only) ─────────────────────────────────
  // Registered last so the API + SSE route prefixes win against any catch-all
  // collision. Skipped in api-only and mounted modes.
  if (ctx.serveDashboard) {
    await fastify.register(
      dashboardPlugin({
        dashboardRoute: ctx.config.dashboardRoute,
        apiBasePath: ctx.config.apiBasePath,
      }),
    )
  }

  return fastify
}
