/**
 * Step 5 — Event Bus test script
 * Run with: npx tsx tests/event-bus.test.ts
 *
 * Tests: subscribe/emit, history recording, circular overflow,
 *        initEventBus config wiring, priority error routing (critical/standard/low),
 *        async listener errors, unsubscribe.
 */
import { eventBus, initEventBus } from '../src/core/eventBus.js'
import type { WatchDeckConfig } from '../src/config/types.js'

// ---------------------------------------------------------------------------
// Minimal helpers
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

/** Minimal config shape — only the fields initEventBus actually reads. */
function makeConfig(maxEventListeners: number, eventHistorySize: number): WatchDeckConfig {
  return {
    port: 4000,
    apiBasePath: '/api/mx',
    dashboardRoute: '/dashboard',
    dashboardMode: 'standalone',
    modules: { sslChecks: false, portChecks: false },
    defaults: { checkInterval: 60, timeout: 10000, expectedStatusCodes: [200], latencyThreshold: 5000, sslWarningDays: 14, failureThreshold: 3, recoveryThreshold: 2, alertCooldown: 900, recoveryAlert: true, escalationDelay: 1800 },
    retention: { detailedDays: 30, hourlyDays: 90, daily: '1year', notificationLogDays: 60 },
    rateLimits: { minCheckInterval: 30, maxConcurrentChecks: 10, perHostMinGap: 2, dbReconnectAttempts: 30, dbPoolSize: 10, maxEventListeners },
    buffer: { memoryCapacity: 1000 },
    sse: { heartbeatInterval: 30 },
    eventHistorySize,
    aggregation: { time: '03:00' },
    cors: { origin: '*', credentials: true },
    authMiddleware: null,
  }
}

// ---------------------------------------------------------------------------
// Test 1 — subscribe() and emit
// ---------------------------------------------------------------------------

section('subscribe() and emit')

{
  let received: string | null = null
  const unsub = eventBus.subscribe('system:warning', ({ message }) => {
    received = message
  })
  eventBus.emit('system:warning', { timestamp: new Date(), module: 'test', message: 'hello' })
  assert(received === 'hello', 'subscriber receives correct payload')
  unsub()

  // After unsub, should not fire again
  received = null
  eventBus.emit('system:warning', { timestamp: new Date(), module: 'test', message: 'after-unsub' })
  assert(received === null, 'unsubscribe stops delivery')
}

// ---------------------------------------------------------------------------
// Test 2 — getHistory() records events in order
// ---------------------------------------------------------------------------

section('getHistory() — recording and order')

{
  // Reset to a known small history size for this test
  initEventBus(makeConfig(50, 10))

  const before = eventBus.getHistory().length

  eventBus.emit('system:warning', { timestamp: new Date(), module: 'a', message: 'first' })
  eventBus.emit('system:warning', { timestamp: new Date(), module: 'b', message: 'second' })
  eventBus.emit('system:warning', { timestamp: new Date(), module: 'c', message: 'third' })

  const history = eventBus.getHistory()
  assert(history.length === before + 3, `history grew by 3 (was ${before}, now ${history.length})`)

  const last3 = history.slice(-3)
  assert(
    last3[0].event === 'system:warning' &&
    last3[1].event === 'system:warning' &&
    last3[2].event === 'system:warning',
    'history entries carry correct event name',
  )
  // Timestamps should be non-decreasing
  const tsOk = last3.every((e, i, a) => i === 0 || e.timestamp >= a[i - 1].timestamp)
  assert(tsOk, 'history entries are in chronological order')
}

// ---------------------------------------------------------------------------
// Test 3 — circular overflow (history size = 3, emit 5 events)
// ---------------------------------------------------------------------------

section('Circular buffer overflow')

{
  initEventBus(makeConfig(50, 3))

  for (let i = 1; i <= 5; i++) {
    eventBus.emit('system:warning', { timestamp: new Date(), module: 'overflow', message: `msg-${i}` })
  }

  const history = eventBus.getHistory()
  assert(history.length === 3, `buffer capped at 3 (got ${history.length})`)

  const messages = history
    .filter((h) => h.event === 'system:warning')
    .map((h) => (h.payload as { message: string }).message)

  assert(
    messages[0] === 'msg-3' && messages[1] === 'msg-4' && messages[2] === 'msg-5',
    `oldest entry dropped — retained: [${messages.join(', ')}]`,
  )
}

// ---------------------------------------------------------------------------
// Test 4 — initEventBus wires maxListeners from config
// ---------------------------------------------------------------------------

section('initEventBus() — maxListeners from config')

{
  initEventBus(makeConfig(42, 100))
  // EventEmitter.getMaxListeners() returns what was set
  const maxL = (eventBus as unknown as { getMaxListeners(): number }).getMaxListeners()
  assert(maxL === 42, `maxListeners set to 42 from config (got ${maxL})`)
}

// ---------------------------------------------------------------------------
// Test 5 — priority: critical subscriber error → system:critical event
// ---------------------------------------------------------------------------

section('Priority: critical — error emits system:critical')

{
  initEventBus(makeConfig(50, 100))

  let criticalFired: string | null = null
  const unsubObserver = eventBus.subscribe('system:critical', ({ module }) => {
    criticalFired = module
  })

  const unsubThrower = eventBus.subscribe('health:update', () => {
    throw new Error('boom')
  }, 'critical')

  eventBus.emit('health:update', { timestamp: new Date(), component: 'db', status: 'down' })

  assert(criticalFired !== null, 'system:critical was emitted')
  assert(criticalFired === 'health:update', `system:critical module = "health:update" (got "${criticalFired}")`)
  unsubObserver()
  unsubThrower()
}

// ---------------------------------------------------------------------------
// Test 6 — priority: standard subscriber error → system:warning event
// ---------------------------------------------------------------------------

section('Priority: standard — error emits system:warning')

{
  let warningModule: string | null = null
  const unsubObserver = eventBus.subscribe('system:warning', ({ module }) => {
    warningModule = module
  })

  const unsubThrower = eventBus.subscribe('health:update', () => {
    throw new Error('standard-boom')
  }, 'standard')

  eventBus.emit('health:update', { timestamp: new Date(), component: 'db', status: 'degraded' })

  assert(warningModule !== null, 'system:warning was emitted')
  assert(warningModule === 'health:update', `system:warning module = "health:update" (got "${warningModule}")`)
  unsubObserver()
  unsubThrower()
}

// ---------------------------------------------------------------------------
// Test 7 — priority: low subscriber error → only console.error, no event
// ---------------------------------------------------------------------------

section('Priority: low — error goes to console only, no event emitted')

{
  let warningFired = false
  let criticalFired = false
  const u1 = eventBus.subscribe('system:warning', () => { warningFired = true })
  const u2 = eventBus.subscribe('system:critical', () => { criticalFired = true })

  // Patch console.error to detect it was called
  let consoleErrorCalled = false
  const origError = console.error
  console.error = (..._args: unknown[]) => { consoleErrorCalled = true }

  const unsubThrower = eventBus.subscribe('health:update', () => {
    throw new Error('low-boom')
  }, 'low')

  eventBus.emit('health:update', { timestamp: new Date(), component: 'db', status: 'healthy' })

  console.error = origError

  assert(!warningFired, 'system:warning NOT emitted for low priority')
  assert(!criticalFired, 'system:critical NOT emitted for low priority')
  assert(consoleErrorCalled, 'console.error was called for low priority')
  u1()
  u2()
  unsubThrower()
}

// ---------------------------------------------------------------------------
// Test 8 — async listener error handling
// ---------------------------------------------------------------------------

section('Async listener errors are caught')

{
  let warningFired = false
  const unsubObserver = eventBus.subscribe('system:warning', () => { warningFired = true })

  const unsubThrower = eventBus.subscribe('health:update', async () => {
    await sleep(10)
    throw new Error('async-boom')
  }, 'standard')

  eventBus.emit('health:update', { timestamp: new Date(), component: 'api', status: 'down' })

  // Give the async error time to propagate
  await sleep(50)

  assert(warningFired, 'system:warning emitted after async subscriber throws')
  unsubObserver()
  unsubThrower()
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`── Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
