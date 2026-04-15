/**
 * SSE broker — streams event bus events to connected clients.
 *
 * GET /stream (auth required):
 *   1. Sends buffered event history on connect
 *   2. Streams all event bus events as they occur
 *   3. Sends heartbeat comments at sse.heartbeatInterval
 *
 * No server-side filtering in V1 — clients filter locally.
 * Client tracking: count available via getClientCount() for the health page.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eventBus, type HistoryRecord } from '../core/eventBus.js'
import type { EventMap } from '../core/eventTypes.js'
import type { AppContext } from './server.js'

// ---------------------------------------------------------------------------
// Client tracking
// ---------------------------------------------------------------------------

const clients = new Set<FastifyReply>()

/** Number of currently connected SSE clients. */
export function getClientCount(): number {
  return clients.size
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a single SSE message.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
function sseMessage(event: string, data: unknown): string {
  const json = JSON.stringify(data)
  return `event: ${event}\ndata: ${json}\n\n`
}

/** Send a history record to a single client. */
function sendHistory(reply: FastifyReply, record: HistoryRecord): void {
  reply.raw.write(sseMessage(record.event, record.payload))
}

/** Broadcast an event to all connected clients. */
function broadcast<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  const msg = sseMessage(event, payload)
  for (const client of clients) {
    client.raw.write(msg)
  }
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

/** All event names to forward over SSE. */
const SSE_EVENTS: (keyof EventMap)[] = [
  'check:complete',
  'endpoint:created',
  'endpoint:updated',
  'endpoint:deleted',
  'incident:opened',
  'incident:resolved',
  'system:critical',
  'system:warning',
  'health:update',
  'maintenance:started',
  'maintenance:ended',
  'replay:progress',
  'db:connected',
  'db:disconnected',
  'db:reconnecting',
  'db:reconnected',
  'db:fatal',
]

const unsubscribers: Array<() => void> = []

/** Subscribe to all event bus events and broadcast to SSE clients. */
function subscribeAll(): void {
  for (const event of SSE_EVENTS) {
    const unsub = eventBus.subscribe(
      event,
      (payload) => broadcast(event, payload),
      'standard',
    )
    unsubscribers.push(unsub)
  }
}

/** Tear down all subscriptions (used on server close). */
export function unsubscribeAll(): void {
  for (const unsub of unsubscribers) unsub()
  unsubscribers.length = 0
}

// ---------------------------------------------------------------------------
// Fastify route plugin
// ---------------------------------------------------------------------------

export function sseRoutes(ctx: AppContext) {
  // Subscribe to events once when the plugin is created
  subscribeAll()

  return async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      // Track this client
      clients.add(reply)

      // Send event history on connect
      const history = eventBus.getHistory()
      for (const record of history) {
        sendHistory(reply, record)
      }

      // Send initial connected event
      reply.raw.write(
        sseMessage('sse:connected', {
          timestamp: new Date(),
          historyCount: history.length,
        }),
      )

      // Heartbeat timer
      const heartbeatMs = ctx.config.sse.heartbeatInterval * 1000
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n')
      }, heartbeatMs)

      // Cleanup on disconnect
      request.raw.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(reply)
      })

      // Keep the connection open — do not call reply.send()
      // Fastify will handle the response lifecycle via the raw stream
    })
  }
}
