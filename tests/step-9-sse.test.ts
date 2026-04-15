/**
 * Step 9 — SSE Broker tests.
 *
 * Tests: heartbeat, live events, auth gating, client tracking,
 * history replay on connect, and replay:progress event forwarding.
 *
 * Usage: npx tsx tests/step-9-sse.test.ts
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MongoDBAdapter } from '../src/storage/mongodb.js'
import { eventBus, initEventBus } from '../src/core/eventBus.js'
import { CheckScheduler } from '../src/core/scheduler.js'
import { buildServer } from '../src/api/server.js'
import { getClientCount } from '../src/api/sse.js'
import { defaults } from '../src/config/defaults.js'
import type { FastifyInstance } from 'fastify'
import type { WatchDeckConfig } from '../src/config/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

dotenv.config({ quiet: true })
if (!process.env.MX_DB_URI) {
  const fallback = path.resolve(projectRoot, '..', 'test_watchdeck', '.env')
  dotenv.config({ path: fallback, quiet: true })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`)
    passed++
  } else {
    console.log(`  ✗  ${label}${detail ? `  →  ${detail}` : ''}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Parse SSE text into an array of { event, data } objects.
 * Heartbeat comments (": heartbeat") are excluded.
 */
function parseSSE(text: string): Array<{ event: string; data: string }> {
  const results: Array<{ event: string; data: string }> = []
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0)
  for (const block of blocks) {
    const lines = block.split('\n')
    let event = 'message'
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (data) results.push({ event, data })
  }
  return results
}

const BASE = '/api/mx'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const dbUri = process.env.MX_DB_URI

if (!dbUri) {
  section('SSE tests  (SKIPPED — MX_DB_URI not set)')
  console.log('  ℹ  Run from a directory with .env to enable SSE tests')
  console.log(`\n── Results: ${passed} passed, ${failed} failed\n`)
  process.exit(0)
}

const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'

const testConfig: WatchDeckConfig = {
  ...(defaults as unknown as WatchDeckConfig),
  apiBasePath: BASE,
  sse: { heartbeatInterval: 2 },
  modules: { discord: true, slack: true, sslChecks: false, portChecks: true, bodyValidation: true },
  rateLimits: { ...(defaults as unknown as WatchDeckConfig).rateLimits, maxEventListeners: 50 },
  authMiddleware: null,
}

initEventBus(testConfig)

const adapter = new MongoDBAdapter(dbUri, dbPrefix, testConfig)

section('Setup')

try {
  await adapter.connect()
  await adapter.migrate()
  assert(true, 'Adapter connected + migrated')
} catch (err) {
  console.log(`  ✗  Setup failed: ${err instanceof Error ? err.message : String(err)}`)
  failed++
  console.log(`\n── Results: ${passed} passed, ${failed} failed\n`)
  process.exit(1)
}

const mockScheduler: Partial<CheckScheduler> & {
  queueSize: number
  runningChecks: number
  scheduleImmediate: (id: string) => boolean
  stop: () => void
} = {
  queueSize: 3,
  runningChecks: 1,
  scheduleImmediate: (_id: string) => true,
  stop: () => {},
}

const server: FastifyInstance = await buildServer({
  adapter,
  scheduler: mockScheduler as unknown as CheckScheduler,
  config: testConfig,
})
await server.listen({ port: 0 })
const address = server.addresses()[0]
const HOST = `http://localhost:${address.port}${BASE}`
assert(true, `Server listening on port ${address.port}`)

// ---------------------------------------------------------------------------
// SSE — basic connection + history replay
// ---------------------------------------------------------------------------

section('SSE — connection and history replay')

// Emit events before connecting so history buffer has content
eventBus.emit('check:complete', {
  timestamp: new Date(),
  endpointId: 'test-001',
  status: 'healthy',
  responseTime: 42,
  statusCode: 200,
  errorMessage: null,
})

eventBus.emit('endpoint:created', {
  timestamp: new Date(),
  endpoint: { name: 'Test EP' } as any,
})

await sleep(50)

// Connect to SSE stream
const controller = new AbortController()
const sseRes = await fetch(`${HOST}/stream`, {
  signal: controller.signal,
  headers: { Accept: 'text/event-stream' },
})

assert(sseRes.status === 200, 'GET /stream → 200')
assert(
  sseRes.headers.get('content-type')?.includes('text/event-stream') === true,
  'Content-Type is text/event-stream',
)

// Read initial burst (history + sse:connected)
const reader = sseRes.body!.getReader()
const decoder = new TextDecoder()

let sseText = ''
const readUntil = async (marker: string, timeoutMs = 3000): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      sleep(100).then(() => ({ value: undefined, done: false })),
    ]) as { value: Uint8Array | undefined; done: boolean }
    if (done) break
    if (value) sseText += decoder.decode(value, { stream: true })
    if (sseText.includes(marker)) return sseText
  }
  return sseText
}

await readUntil('sse:connected')

const messages = parseSSE(sseText)
const historyEvents = messages.filter((m) => m.event !== 'sse:connected')
const connectedMsg = messages.find((m) => m.event === 'sse:connected')

assert(historyEvents.length >= 2, `History events received (${historyEvents.length} >= 2)`)

const hasCheckComplete = historyEvents.some((m) => m.event === 'check:complete')
assert(hasCheckComplete, 'History includes check:complete event')

const hasEndpointCreated = historyEvents.some((m) => m.event === 'endpoint:created')
assert(hasEndpointCreated, 'History includes endpoint:created event')

assert(connectedMsg !== undefined, 'Received sse:connected event')
if (connectedMsg) {
  const data = JSON.parse(connectedMsg.data)
  assert(typeof data.historyCount === 'number', `sse:connected has historyCount (${data.historyCount})`)
}

// ---------------------------------------------------------------------------
// SSE — client tracking
// ---------------------------------------------------------------------------

section('SSE — client tracking')

assert(getClientCount() >= 1, `Client count >= 1 (got ${getClientCount()})`)

// Open a second connection
const controller2 = new AbortController()
const sseRes2 = await fetch(`${HOST}/stream`, {
  signal: controller2.signal,
  headers: { Accept: 'text/event-stream' },
})
assert(sseRes2.status === 200, 'Second SSE connection → 200')

await sleep(200)
assert(getClientCount() >= 2, `Client count >= 2 after second connect (got ${getClientCount()})`)

// Close the second connection
controller2.abort()
await sleep(300)
assert(getClientCount() >= 1, `Client count >= 1 after second disconnects (got ${getClientCount()})`)

// ---------------------------------------------------------------------------
// SSE — live events broadcast
// ---------------------------------------------------------------------------

section('SSE — live event broadcast')

sseText = ''

eventBus.emit('incident:opened', {
  timestamp: new Date(),
  incident: { _id: 'inc-test-001', status: 'active' } as any,
})

await sleep(200)
await readUntil('incident:opened', 2000)
const liveMessages = parseSSE(sseText)
const incidentMsg = liveMessages.find((m) => m.event === 'incident:opened')

assert(incidentMsg !== undefined, 'Live incident:opened received over SSE')
if (incidentMsg) {
  const data = JSON.parse(incidentMsg.data)
  assert(data.incident?._id === 'inc-test-001', 'incident._id matches')
}

// replay:progress
sseText = ''
eventBus.emit('replay:progress', {
  timestamp: new Date(),
  status: 'running',
  batchCurrent: 1,
  batchTotal: 5,
  resultsCurrent: 100,
  resultsTotal: 500,
  errors: 0,
  percentComplete: 20,
})

await sleep(200)
await readUntil('replay:progress', 2000)
const replayMessages = parseSSE(sseText)
const replayMsg = replayMessages.find((m) => m.event === 'replay:progress')
assert(replayMsg !== undefined, 'replay:progress received over SSE')
if (replayMsg) {
  const data = JSON.parse(replayMsg.data)
  assert(data.percentComplete === 20, 'replay:progress percentComplete = 20')
  assert(data.status === 'running', 'replay:progress status = "running"')
}

// ---------------------------------------------------------------------------
// SSE — heartbeat
// ---------------------------------------------------------------------------

section('SSE — heartbeat')

sseText = ''
await sleep(2500)
await readUntil('heartbeat', 1000)
assert(sseText.includes(': heartbeat'), 'Heartbeat comment received within interval')

// ---------------------------------------------------------------------------
// SSE — auth middleware gating
// ---------------------------------------------------------------------------

section('SSE — auth middleware')

const authConfig: WatchDeckConfig = {
  ...testConfig,
  authMiddleware: async (_req: any, reply: any) => {
    await reply.code(401).send({ error: true, code: 'UNAUTHORIZED', message: 'Denied' })
  },
} as any

const authServer = await buildServer({
  adapter,
  scheduler: mockScheduler as unknown as CheckScheduler,
  config: authConfig,
})
await authServer.listen({ port: 0 })
const authAddress = authServer.addresses()[0]
const authBase = `http://localhost:${authAddress.port}${BASE}`

const authRes = await fetch(`${authBase}/stream`)
assert(authRes.status === 401, 'SSE stream returns 401 when auth rejects')

const healthRes = await fetch(`${authBase}/health/ping`)
assert(healthRes.status === 200, 'Public health/ping still returns 200')

await authServer.close()

// ---------------------------------------------------------------------------
// SSE — client count in health/history
// ---------------------------------------------------------------------------

section('SSE — client count in health/history')

const historyRes = await fetch(`${HOST}/health/history`)
const historyData = (await historyRes.json()) as Record<string, unknown>
assert(historyRes.status === 200, 'GET /health/history → 200')
assert(typeof historyData.sseClients === 'number', `sseClients field present (${historyData.sseClients})`)

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

section('Cleanup')

controller.abort()
await sleep(200)

await server.close()
await adapter.disconnect()
assert(true, 'Server closed + adapter disconnected')

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n── Results: ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
