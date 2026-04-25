/**
 * Live ping script — fires real HTTP requests at a running WatchDeck server.
 *
 * Usage:
 *   Terminal 1:  npx watchdeck start --verbose   (or: npx tsx src/bin/cli.ts start --verbose)
 *   Terminal 2:  npx tsx tests/ping-server.ts
 *
 * Options (env vars):
 *   PORT=4000       target port  (default: 4000)
 *   BASE=/api/mx    API base path (default: /api/mx)
 *   DELAY=400       ms between requests (default: 400)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT  = process.env.PORT  ?? '4000'
const BASE  = process.env.BASE  ?? '/api/mx'
const DELAY = parseInt(process.env.DELAY ?? '400', 10)
const HOST  = `http://localhost:${PORT}`

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

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${HOST}${BASE}${path}`
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n  WatchDeck — live ping`)
console.log(`  Target: ${HOST}${BASE}`)
console.log(`  Delay:  ${DELAY}ms between requests`)
console.log(`  (watch the server terminal for colored request logs)\n`)

// Confirm the server is reachable before proceeding
try {
  const probe = await fetch(`${HOST}${BASE}/health/ping`)
  if (!probe.ok) throw new Error(`status ${probe.status}`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`  ✗  Cannot reach server at ${HOST}${BASE}/health/ping — ${msg}`)
  console.error(`     Start the server first: watchdeck start --verbose\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Section 1 — Public health routes
// ---------------------------------------------------------------------------

section('Public health routes')
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/health/ping')
  const d = data as Record<string, unknown>
  assert(status === 200, 'GET /health/ping → 200')
  // Liveness probe — minimal `{ ok: true }` body is intentional. Anything
  // richer belongs on /health proper.
  assert(d?.ok === true, 'body.ok === true')
}
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/health')
  // /health is now a probe-registry snapshot under `data.overall` rather than
  // the flat `{ uptime, db }` shape the original assertion expected. Walk into
  // overall and check process uptime + the active-incidents count instead.
  const overall = ((data as Record<string, unknown>)?.data as Record<string, unknown>)
    ?.overall as Record<string, unknown> | undefined
  assert(status === 200, 'GET /health → 200')
  assert(
    typeof overall?.processUptimeSeconds === 'number',
    'overall.processUptimeSeconds is a number',
    String(overall?.processUptimeSeconds),
  )
  assert(typeof overall?.state === 'string', 'overall.state is a string')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 2 — Error responses (watch for yellow 4xx on server)
// ---------------------------------------------------------------------------

section('Error responses  (expect yellow 4xx in server terminal)')
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/does-not-exist')
  const d = data as Record<string, unknown>
  assert(status === 404, 'GET /does-not-exist → 404')
  assert(d?.code === 'NOT_FOUND', 'code = NOT_FOUND')
}
await sleep(DELAY)

{
  const { status, data } = await req('POST', '/endpoints', {})
  const d = data as Record<string, unknown>
  assert(status === 422, 'POST /endpoints with empty body → 422')
  assert(d?.code === 'VALIDATION_ERROR', 'code = VALIDATION_ERROR')
}
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/endpoints/not-a-real-uuid')
  const d = data as Record<string, unknown>
  // Endpoint IDs are UUIDv7 strings now (no ObjectId-shaped pre-validation).
  // Anything that isn't an existing endpoint comes back as a clean 404; we
  // dropped the eager INVALID_ID 400 to keep the contract simple.
  assert(status === 404, 'GET /endpoints/bad-id → 404')
  assert(d?.code === 'NOT_FOUND', 'code = NOT_FOUND')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 3 — Endpoint CRUD  (green 2xx, then yellow 4xx on delete)
// ---------------------------------------------------------------------------

section('Endpoint CRUD  (green 2xx, then 404 after delete)')
await sleep(DELAY)

let endpointId = ''

{
  const { status, data } = await req('POST', '/endpoints', {
    name:   'Ping Test Endpoint',
    type:   'http',
    url:    'https://example.com',
    enabled: true,
  })
  const d = data as Record<string, unknown>
  endpointId = (d?.data as Record<string, unknown>)?.id as string ?? ''
  assert(status === 201, 'POST /endpoints → 201')
  assert(typeof endpointId === 'string' && endpointId.length > 0, 'got id back', endpointId)
}
await sleep(DELAY)

{
  const { status, data } = await req('GET', `/endpoints/${endpointId}`)
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  assert(status === 200, `GET /endpoints/${endpointId} → 200`)
  assert(d?.name === 'Ping Test Endpoint', 'name matches')
}
await sleep(DELAY)

{
  const { status, data } = await req('PUT', `/endpoints/${endpointId}`, {
    name: 'Ping Test Endpoint (updated)',
  })
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  assert(status === 200, 'PUT /endpoints/:id → 200')
  assert(d?.name === 'Ping Test Endpoint (updated)', 'name updated')
}
await sleep(DELAY)

{
  const { status, data } = await req('PATCH', `/endpoints/${endpointId}/toggle`)
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  assert(status === 200, 'PATCH /endpoints/:id/toggle → 200')
  assert(d?.status === 'paused', 'toggled to paused')
}
await sleep(DELAY)

{
  const { status } = await req('POST', `/endpoints/${endpointId}/recheck`)
  assert(status === 202, 'POST /endpoints/:id/recheck → 202')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 4 — Checks + uptime
// ---------------------------------------------------------------------------

section('Checks + uptime')
await sleep(DELAY)

{
  const { status, data } = await req('GET', `/endpoints/${endpointId}/checks`)
  const d = data as Record<string, unknown>
  assert(status === 200, 'GET /endpoints/:id/checks → 200')
  assert(Array.isArray((d?.data)), 'data is array')
}
await sleep(DELAY)

{
  const { status, data } = await req('GET', `/endpoints/${endpointId}/uptime`)
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  assert(status === 200, 'GET /endpoints/:id/uptime → 200')
  assert('24h' in (d ?? {}), 'has 24h field')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 5 — Incidents
// ---------------------------------------------------------------------------

section('Incidents')
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/incidents')
  const d = data as Record<string, unknown>
  assert(status === 200, 'GET /incidents → 200')
  assert(Array.isArray(d?.data), 'data is array')
}
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/incidents/active')
  const d = data as Record<string, unknown>
  assert(status === 200, 'GET /incidents/active → 200')
  assert(Array.isArray(d?.data), 'data is array')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 6 — Notifications
// ---------------------------------------------------------------------------

section('Notification channels')
await sleep(DELAY)

let channelId = ''

{
  const { status, data } = await req('POST', '/notifications/channels', {
    name:             'Ping Test Channel',
    type:             'discord',
    // The channel registry now validates Discord webhook URLs against the
    // real `{id}/{token}` shape. Synthetic IDs/tokens that look right pass
    // structural checks; the URL is never actually called during this test.
    discordWebhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678',
    deliveryPriority: 'standard',
  })
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  channelId = d?.id as string ?? ''
  assert(status === 201, 'POST /notifications/channels → 201')
  assert(d?.name === 'Ping Test Channel', 'name matches')
}
await sleep(DELAY)

{
  const { status } = await req('GET', '/notifications/channels')
  assert(status === 200, 'GET /notifications/channels → 200')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 7 — Settings
// ---------------------------------------------------------------------------

section('Settings')
await sleep(DELAY)

{
  const { status, data } = await req('GET', '/settings')
  const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
  assert(status === 200, 'GET /settings → 200')
  assert(d?.id === 'global', 'id = "global"')
}
await sleep(DELAY)

{
  const { status } = await req('PUT', '/settings', { theme: 'dark' })
  assert(status === 200, 'PUT /settings → 200')
}
await sleep(DELAY)

// ---------------------------------------------------------------------------
// Section 8 — Cleanup (DELETE — watch for red DELETE in server terminal)
// ---------------------------------------------------------------------------

section('Cleanup  (expect red DELETE in server terminal)')
await sleep(DELAY)

if (channelId) {
  const { status } = await req('DELETE', `/notifications/channels/${channelId}`)
  assert(status === 204, 'DELETE /notifications/channels/:id → 204')
  await sleep(DELAY)
}

if (endpointId) {
  const { status } = await req('DELETE', `/endpoints/${endpointId}?mode=hard`)
  assert(status === 204, `DELETE /endpoints/${endpointId}?mode=hard → 204`)
  await sleep(DELAY)

  const { status: getStatus } = await req('GET', `/endpoints/${endpointId}`)
  assert(getStatus === 404, 'hard-deleted endpoint → 404')
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n── Results: ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
