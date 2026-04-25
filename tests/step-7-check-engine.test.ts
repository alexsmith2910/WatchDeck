/**
 * Step 7 — Check Engine test script
 * Run: npx tsx tests/step-7-check-engine.test.ts
 *
 * Sections 1–4 are pure logic or live-network only (no DB required).
 * Section 5 (scheduler with DB) requires MX_DB_URI.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import dotenv from 'dotenv'

function fakeObjectIdHex(): string {
  return randomBytes(12).toString('hex')
}

import { evaluateStatus } from '../src/checks/evaluators/statusEval.js'
import { runHttpCheck } from '../src/checks/httpCheck.js'
import { runPortCheck } from '../src/checks/portCheck.js'
import { runCheck } from '../src/checks/checkRunner.js'
import { eventBus } from '../src/core/eventBus.js'
import { CheckScheduler } from '../src/core/scheduler.js'
import { MongoDBAdapter } from '../src/storage/mongodb.js'
import type { StorageAdapter } from '../src/storage/adapter.js'
import type { WatchDeckConfig } from '../src/config/types.js'
import type { EndpointDoc } from '../src/storage/types.js'
import type { EventMap } from '../src/core/eventTypes.js'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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

function makeEndpoint(overrides?: Partial<EndpointDoc>): EndpointDoc {
  return {
    id: fakeObjectIdHex(),
    name: 'Test endpoint',
    type: 'http',
    url: 'https://httpbin.org/status/200',
    method: 'GET',
    headers: {},
    expectedStatusCodes: [200],
    checkInterval: 60,
    timeout: 10_000,
    enabled: true,
    status: 'active',
    latencyThreshold: 5_000,
    sslWarningDays: 14,
    failureThreshold: 3,
    recoveryThreshold: 2,
    alertCooldown: 900,
    recoveryAlert: true,
    escalationDelay: 1_800,
    notificationChannelIds: [],
    consecutiveFailures: 0,
    consecutiveHealthy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

/** Minimal config sufficient for the scheduler. */
const testConfig: WatchDeckConfig = {
  port: 4000,
  apiBasePath: '/api/mx',
  dashboardRoute: '/dashboard',
  dashboardMode: 'standalone',
  modules: { sslChecks: false, portChecks: true },
  defaults: {
    checkInterval: 60, timeout: 10_000, expectedStatusCodes: [200],
    latencyThreshold: 5_000, sslWarningDays: 14, failureThreshold: 3,
    recoveryThreshold: 2,
    alertCooldown: 900, recoveryAlert: true, escalationDelay: 1_800,
  },
  retention: { detailedDays: 30, hourlyDays: 90, daily: '1year', notificationLogDays: 60 },
  rateLimits: {
    minCheckInterval: 30, maxConcurrentChecks: 10, perHostMinGap: 2,
    dbReconnectAttempts: 30, dbPoolSize: 10, maxEventListeners: 25,
  },
  buffer: { memoryCapacity: 1_000 },
  sse: { heartbeatInterval: 30 },
  eventHistorySize: 100,
  aggregation: { time: '03:00' },
  cors: { origin: '*', credentials: true },
  authMiddleware: null,
}

// ---------------------------------------------------------------------------
// Section 1 — statusEval
// ---------------------------------------------------------------------------

section('statusEval')

{
  const r = evaluateStatus({
    type: 'http', statusCode: 200, responseTime: 100, errorMessage: null,
    expectedStatusCodes: [200], latencyThreshold: 5_000,
  })
  assert(r.status === 'healthy', 'HTTP 200 in expected list → healthy')
  assert(r.statusReason === null, 'healthy result has null statusReason')
}

{
  const r = evaluateStatus({
    type: 'http', statusCode: 500, responseTime: 100, errorMessage: null,
    expectedStatusCodes: [200], latencyThreshold: 5_000,
  })
  assert(r.status === 'down', 'HTTP 500 not in expected list → down')
  assert(r.statusReason?.includes('500') ?? false, `statusReason includes status code (got: ${r.statusReason})`)
}

{
  const r = evaluateStatus({
    type: 'http', statusCode: 200, responseTime: 6_000, errorMessage: null,
    expectedStatusCodes: [200], latencyThreshold: 5_000,
  })
  assert(r.status === 'degraded', 'latency 6000ms over 5000ms threshold → degraded')
  assert(r.statusReason?.includes('6000ms') ?? false, `statusReason mentions response time (got: ${r.statusReason})`)
}

{
  const r = evaluateStatus({
    type: 'http', statusCode: null, responseTime: 50, errorMessage: 'ECONNREFUSED',
    expectedStatusCodes: [200], latencyThreshold: 5_000,
  })
  assert(r.status === 'down', 'network error with no statusCode → down')
  assert(r.statusReason === 'ECONNREFUSED', `statusReason is the error message (got: ${r.statusReason})`)
}

{
  const r = evaluateStatus({
    type: 'http', statusCode: 201, responseTime: 50, errorMessage: null,
    expectedStatusCodes: [200, 201, 204], latencyThreshold: 5_000,
  })
  assert(r.status === 'healthy', '201 in multi-code expected list → healthy')
}

{
  const r = evaluateStatus({
    type: 'port', statusCode: null, responseTime: 10, errorMessage: null,
    expectedStatusCodes: [], latencyThreshold: 5_000, portOpen: true,
  })
  assert(r.status === 'healthy', 'port open, low latency → healthy')
}

{
  const r = evaluateStatus({
    type: 'port', statusCode: null, responseTime: 10, errorMessage: 'ECONNREFUSED',
    expectedStatusCodes: [], latencyThreshold: 5_000, portOpen: false,
  })
  assert(r.status === 'down', 'port refused → down')
}

{
  const r = evaluateStatus({
    type: 'port', statusCode: null, responseTime: 6_000, errorMessage: null,
    expectedStatusCodes: [], latencyThreshold: 5_000, portOpen: true,
  })
  assert(r.status === 'degraded', 'port open but high latency → degraded')
}

// ---------------------------------------------------------------------------
// Section 2 — httpCheck (live network)
// ---------------------------------------------------------------------------

section('httpCheck — live network')

{
  const r = await runHttpCheck({ url: 'https://httpbin.org/status/200', timeout: 15_000 })
  assert(r.statusCode === 200, `GET /status/200 → statusCode 200 (got: ${r.statusCode})`)
  assert(r.responseTime > 0, `responseTime > 0 (got: ${r.responseTime})`)
  assert(r.errorMessage === null, `no errorMessage on success (got: ${r.errorMessage})`)
}

{
  const r = await runHttpCheck({ url: 'https://httpbin.org/status/500', timeout: 15_000 })
  assert(r.statusCode === 500, `GET /status/500 → statusCode 500 (got: ${r.statusCode})`)
  assert(r.errorMessage === null, `non-2xx does not set errorMessage (got: ${r.errorMessage})`)
}

{
  const r = await runHttpCheck({
    url: 'https://this-domain-does-not-exist-watchdeck.invalid',
    timeout: 5_000,
  })
  assert(r.statusCode === null, 'non-existent domain → null statusCode')
  assert(!!r.errorMessage, `non-existent domain → errorMessage set (got: ${r.errorMessage})`)
  assert(r.responseTime > 0, `responseTime still recorded on DNS error (got: ${r.responseTime})`)
}

{
  const r = await runHttpCheck({ url: 'not-a-url' })
  assert(r.statusCode === null, 'invalid URL → null statusCode')
  assert(r.errorMessage?.includes('Invalid URL') ?? false, `errorMessage says Invalid URL (got: ${r.errorMessage})`)
  assert(r.responseTime === 0, `invalid URL bails before timing (got: ${r.responseTime})`)
}

// ---------------------------------------------------------------------------
// Section 3 — portCheck (live network)
// ---------------------------------------------------------------------------

section('portCheck — live network')

{
  const r = await runPortCheck({ host: 'example.com', port: 80, timeout: 10_000 })
  assert(r.portOpen === true, 'port 80 on example.com → open')
  assert(r.responseTime > 0, `responseTime > 0 (got: ${r.responseTime})`)
  assert(r.errorMessage === null, `no errorMessage when open (got: ${r.errorMessage})`)
}

{
  const r = await runPortCheck({ host: 'localhost', port: 1, timeout: 3_000 })
  assert(r.portOpen === false, 'port 1 on localhost → not open')
  assert(r.responseTime > 0, `responseTime still recorded on refused (got: ${r.responseTime})`)
  assert(!!r.errorMessage, `errorMessage set when refused (got: ${r.errorMessage})`)
}

// ---------------------------------------------------------------------------
// Section 4 — checkRunner (event emission)
// ---------------------------------------------------------------------------

section('checkRunner — check:complete event')

{
  const endpoint = makeEndpoint({ url: 'https://httpbin.org/status/200' })
  let received: EventMap['check:complete'] | null = null
  const unsub = eventBus.subscribe('check:complete', (p) => { received = p })

  await runCheck(endpoint)
  unsub()

  assert(received !== null, 'check:complete emitted for HTTP check')
  assert(received!.endpointId === endpoint.id, 'endpointId matches')
  assert(['healthy', 'degraded', 'down'].includes(received!.status), `status is valid (got: ${received!.status})`)
  assert(received!.responseTime > 0, `responseTime > 0 (got: ${received!.responseTime})`)
  assert(received!.timestamp instanceof Date, 'timestamp is a Date')
}

{
  const endpoint = makeEndpoint({
    url: 'https://httpbin.org/status/503',
    expectedStatusCodes: [200],
  })
  let received: EventMap['check:complete'] | null = null
  const unsub = eventBus.subscribe('check:complete', (p) => { received = p })

  await runCheck(endpoint)
  unsub()

  assert(received!.status === 'down', `503 with expected [200] → down (got: ${received!.status})`)
  assert(!!received!.errorMessage, `errorMessage set for down status (got: ${received!.errorMessage})`)
}

{
  const endpoint = makeEndpoint({
    type: 'port',
    url: undefined,
    host: 'example.com',
    port: 80,
    expectedStatusCodes: undefined,
  })
  let received: EventMap['check:complete'] | null = null
  const unsub = eventBus.subscribe('check:complete', (p) => { received = p })

  await runCheck(endpoint)
  unsub()

  assert(received !== null, 'check:complete emitted for port check')
  assert(received!.statusCode === null, 'statusCode is null for port check')
  assert(received!.responseTime > 0, `responseTime > 0 (got: ${received!.responseTime})`)
}

// ---------------------------------------------------------------------------
// Section 5 — CheckScheduler (needs DB)
// ---------------------------------------------------------------------------

const dbUri = process.env.MX_DB_URI
const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'
// This block uses MongoDBAdapter directly. When the env URI points at a
// non-Mongo backend (e.g. Postgres dev DB) skip cleanly rather than blow up
// with "expected mongodb://" — the scheduler logic is identical across
// adapters, so a Mongo box on CI covers what we need.
const isMongo = dbUri?.startsWith('mongodb://') || dbUri?.startsWith('mongodb+srv://')

if (!dbUri) {
  section('CheckScheduler — DB integration  (SKIPPED — MX_DB_URI not set)')
  console.log('  ℹ  Run from a directory with .env to enable DB tests')
} else if (!isMongo) {
  section('CheckScheduler — DB integration  (SKIPPED — non-Mongo URI)')
  console.log('  ℹ  This test exercises MongoDBAdapter directly; switch MX_DB_URI to a mongodb:// URI to run')
} else {
  section('CheckScheduler — DB integration')

  const { defaults } = await import('../src/config/defaults.js')
  const adapter = new MongoDBAdapter(dbUri, dbPrefix, defaults as unknown as WatchDeckConfig)

  let connected = false
  try {
    await adapter.connect()
    connected = true
    console.log('  ✓  Adapter connected')
    passed++
  } catch (err) {
    console.log(`  ✗  Adapter connect failed: ${err instanceof Error ? err.message : String(err)}`)
    failed++
  }

  if (connected) {
    // Boot scheduler — loads endpoints from DB (likely empty in test env)
    const scheduler = new CheckScheduler(adapter as unknown as StorageAdapter, testConfig)
    await scheduler.init()
    assert(scheduler.queueSize >= 0, `scheduler inits without error (queueSize: ${scheduler.queueSize})`)

    // endpoint:created event inserts into queue
    const ep = makeEndpoint({ status: 'active', enabled: true })
    const sizeBefore = scheduler.queueSize
    eventBus.emit('endpoint:created', { timestamp: new Date(), endpoint: ep })
    assert(scheduler.queueSize === sizeBefore + 1, `endpoint:created increases queueSize by 1 (${sizeBefore} → ${scheduler.queueSize})`)

    // scheduleImmediate finds existing endpoint
    assert(scheduler.scheduleImmediate(ep.id) === true, 'scheduleImmediate returns true for known endpoint')
    assert(scheduler.scheduleImmediate('000000000000000000000000') === false, 'scheduleImmediate returns false for unknown endpoint')

    // endpoint:deleted removes from queue
    eventBus.emit('endpoint:deleted', { timestamp: new Date(), endpointId: ep.id, name: ep.name })
    assert(scheduler.queueSize === sizeBefore, `endpoint:deleted decreases queueSize back (got: ${scheduler.queueSize})`)

    // Port checks excluded when module disabled
    const portConfig = { ...testConfig, modules: { ...testConfig.modules, portChecks: false } }
    const scheduler2 = new CheckScheduler(adapter as unknown as StorageAdapter, portConfig)
    await scheduler2.init()
    const portEp = makeEndpoint({ type: 'port', url: undefined, host: 'example.com', port: 80 })
    const sizeBefore2 = scheduler2.queueSize
    eventBus.emit('endpoint:created', { timestamp: new Date(), endpoint: portEp })
    assert(scheduler2.queueSize === sizeBefore2, 'port endpoint not inserted when portChecks module is disabled')
    scheduler2.stop()

    scheduler.stop()
    await adapter.disconnect()
    console.log('  ✓  Adapter disconnected')
    passed++
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`── Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
