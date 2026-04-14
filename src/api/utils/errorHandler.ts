/**
 * Fastify error handler.
 *
 * Intercepts Fastify's default error responses and reformats them into the
 * standard WatchDeck error shape:
 *   { error: true, code, message, errors?: [...] }
 *
 * Handles:
 *  - JSON Schema validation failures (400/422 from Fastify)
 *  - 404 Not Found
 *  - All other errors (preserves status code, normalises body)
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { formatError } from '../../utils/errors.js'

export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Fastify schema validation errors
  if (error.validation && error.validation.length > 0) {
    const errors = error.validation.map((v) => {
      const instancePath = v.instancePath.replace(/^\//, '').replace(/\//g, '.')
      const field = instancePath
        ? `body.${instancePath}`
        : v.params && 'missingProperty' in v.params
          ? `body.${String(v.params.missingProperty)}`
          : 'body'

      return {
        field,
        value: null as unknown,
        expected: v.message ?? 'valid value',
        fix: `Provide a valid value for ${field}`,
      }
    })

    void reply.code(422).send(
      formatError(
        'VALIDATION_ERROR',
        `Request body has ${errors.length} error${errors.length === 1 ? '' : 's'}`,
        errors,
      ),
    )
    return
  }

  const status = error.statusCode ?? 500

  if (status === 404) {
    void reply.code(404).send(formatError('NOT_FOUND', error.message || 'Route not found'))
    return
  }

  if (status === 401) {
    void reply.code(401).send(formatError('UNAUTHORIZED', error.message || 'Authentication required'))
    return
  }

  if (status === 403) {
    void reply.code(403).send(formatError('FORBIDDEN', error.message || 'Access denied'))
    return
  }

  // Generic fallback
  void reply.code(status).send(
    formatError('INTERNAL_ERROR', error.message || 'An unexpected error occurred'),
  )
}
