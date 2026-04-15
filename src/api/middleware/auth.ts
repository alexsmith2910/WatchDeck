/**
 * Auth middleware plugin.
 *
 * If config.authMiddleware is null, all requests pass through.
 * If a function is provided, it is called with (request, reply). The user's
 * function must either complete normally (allowing the request) or call
 * reply.code(401).send() / throw an error to reject it.
 *
 * Registered as a Fastify `preHandler` hook on the protected route scope.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { WatchDeckConfig } from '../../config/types.js'
import { formatError } from '../../utils/errors.js'

const authPlugin: FastifyPluginAsync<{ config: WatchDeckConfig }> = async (fastify, opts) => {
  const { authMiddleware } = opts.config

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (authMiddleware === null) return

    try {
      await authMiddleware(request, reply)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed'
      if (!reply.sent) {
        await reply.code(401).send(formatError('UNAUTHORIZED', msg))
      }
    }
  })
}

export default fp(authPlugin, { name: 'watchdeck-auth' })
