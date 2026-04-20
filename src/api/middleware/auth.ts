/**
 * Auth middleware plugin.
 *
 * If config.authMiddleware is null, all requests pass through.
 * If a function is provided, it is called with (request, reply). The user's
 * function must either complete normally (allowing the request) or call
 * reply.code(401).send() / throw an error to reject it.
 *
 * Registered as a Fastify `preHandler` hook on the protected route scope.
 *
 * Localhost bypass: GET requests to /health* from the loopback interface
 * skip the user's middleware. This lets `watchdeck status` query the snapshot
 * without needing a token. The health surface is read-only and never returns
 * user check data, and `request.ip` is the real socket IP (Fastify is built
 * without `trustProxy`, so `X-Forwarded-For` can't spoof this).
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { WatchDeckConfig } from '../../config/types.js'
import { formatError } from '../../utils/errors.js'

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/**
 * Bypass auth for `GET /health` and `GET /health/<subsystem>` when the caller
 * is on the loopback interface. `/health/ping` is already a public route so it
 * never reaches this middleware. POSTs (outage simulation, incident ack) and
 * `/health/history` still require auth.
 */
function isLocalHealthRead(request: FastifyRequest, basePath: string): boolean {
  if (request.method !== 'GET') return false
  if (!isLoopback(request.ip)) return false
  const url = request.url.split('?')[0] ?? request.url
  const rel = url.startsWith(basePath) ? url.slice(basePath.length) : url
  if (rel === '/health') return true
  if (rel.startsWith('/health/') && rel !== '/health/history') return true
  return false
}

// ---------------------------------------------------------------------------
// Counters consumed by the `auth` health probe
// ---------------------------------------------------------------------------

interface AuthEvent { ts: number; ok: boolean }

class AuthMetrics {
  private events: AuthEvent[] = []
  totalAttempts = 0
  totalFailures = 0

  record(ok: boolean): void {
    this.totalAttempts += 1
    if (!ok) this.totalFailures += 1
    const now = Date.now()
    this.events.push({ ts: now, ok })
    // Keep ~10 minutes of rolling history; the probe only needs 5.
    const cutoff = now - 10 * 60 * 1000
    while (this.events.length > 0 && this.events[0]!.ts < cutoff) {
      this.events.shift()
    }
  }

  /** Failure rate over the last 5 minutes (0..1). 0 if no attempts. */
  failureRate(): number {
    const cutoff = Date.now() - 5 * 60 * 1000
    let total = 0
    let failed = 0
    for (const e of this.events) {
      if (e.ts < cutoff) continue
      total += 1
      if (!e.ok) failed += 1
    }
    return total === 0 ? 0 : failed / total
  }
}

export const authMetrics = new AuthMetrics()

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const authPlugin: FastifyPluginAsync<{ config: WatchDeckConfig }> = async (fastify, opts) => {
  const { authMiddleware, apiBasePath } = opts.config

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (authMiddleware === null) return
    if (isLocalHealthRead(request, apiBasePath)) return

    try {
      await authMiddleware(request, reply)
      // If the middleware completed without sending an error response, count as success.
      if (!reply.sent || reply.statusCode < 400) {
        authMetrics.record(true)
      } else {
        authMetrics.record(false)
      }
    } catch (err) {
      authMetrics.record(false)
      const msg = err instanceof Error ? err.message : 'Authentication failed'
      if (!reply.sent) {
        await reply.code(401).send(formatError('UNAUTHORIZED', msg))
      }
    }
  })
}

export default fp(authPlugin, { name: 'watchdeck-auth' })
