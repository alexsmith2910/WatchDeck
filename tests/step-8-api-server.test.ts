/**
 * Step 8 — API Server test script
 * Run: npx tsx tests/step-8-api-server.test.ts
 *
 * Section 1 — Pagination utilities (pure, no DB)
 * Section 2 — API routes via Fastify inject (requires MX_DB_URI)
 *
 * Uses server.inject() — no real TCP socket needed.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectId } from 'mongodb'
import dotenv from 'dotenv'

import { parsePagination, toEnvelope } from '../src/api/utils/pagination.js'
import type { DbPage } from '../src/storage/types.js'
import { MongoDBAdapter } from '../src/storage/mongodb.js'
import { buildServer } from '../src/api/server.js'
import type { CheckScheduler } from '../src/core/scheduler.js'
import type { WatchDeckConfig } from '../src/config/types.js'
import { defaults } from '../src/config/defaults.js'

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

const BASE = '/api/mx'

// ---------------------------------------------------------------------------
// Section 1 — Pagination utilities (pure)
// ---------------------------------------------------------------------------

section('Pagination utilities')

{
  const p = parsePagination({})
  assert(p.limit === 20, 'default limit is 20')
  assert(p.cursor === undefined, 'cursor undefined when not provided')
}

{
  const p = parsePagination({ limit: '50', cursor: 'abc123' })
  assert(p.limit === 50, 'limit parsed from string "50"')
  assert(p.cursor === 'abc123', 'cursor passed through')
}

{
  const p = parsePagination({ limit: '999' })
  assert(p.limit === 100, 'limit capped at 100 (got 999)')
}

{
  const p = parsePagination({ limit: 'notanumber' })
  assert(p.limit === 20, 'invalid limit string falls back to 20')
}

{
  const page: DbPage<{ _id: ObjectId; name: string }> = {
    items: [{ _id: new ObjectId(), name: 'a' }, { _id: new ObjectId(), name: 'b' }],
    total: 10,
    hasMore: true,
    nextCursor: 'cursor-next',
    prevCursor: 'cursor-prev',
  }
  const env = toEnvelope(page, 20)
  assert(env.data.length === 2, 'toEnvelope: data array has correct length')
  assert(env.pagination.total === 10, 'toEnvelope: total forwarded')
  assert(env.pagination.hasMore === true, 'toEnvelope: hasMore forwarded')
  assert(env.pagination.nextCursor === 'cursor-next', 'toEnvelope: nextCursor forwarded')
  assert(env.pagination.limit === 20, 'toEnvelope: limit recorded')
}

{
  const page: DbPage<{ _id: ObjectId }> = {
    items: [],
    total: 0,
    hasMore: false,
    nextCursor: null,
    prevCursor: null,
  }
  const env = toEnvelope(page, 20)
  assert(env.pagination.nextCursor === null, 'toEnvelope: nextCursor null when no more pages')
  assert(env.pagination.hasMore === false, 'toEnvelope: hasMore false on last page')
}

// ---------------------------------------------------------------------------
// Section 2 — API routes (requires MX_DB_URI)
// ---------------------------------------------------------------------------

const dbUri = process.env.MX_DB_URI
const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'

if (!dbUri) {
  section('API routes  (SKIPPED — MX_DB_URI not set)')
  console.log('  ℹ  Run from a directory with .env to enable server tests')
} else {
  section('API routes — setup')

  const testConfig: WatchDeckConfig = {
    ...(defaults as unknown as WatchDeckConfig),
    apiBasePath: BASE,
    modules: { discord: true, slack: true, sslChecks: false, portChecks: true, bodyValidation: true },
    rateLimits: { ...(defaults as unknown as WatchDeckConfig).rateLimits, maxEventListeners: 50 },
    authMiddleware: null,
  }

  const mockScheduler: Partial<CheckScheduler> & {
    queueSize: number
    runningChecks: number
    scheduleImmediate: (id: string) => boolean
  } = {
    queueSize: 3,
    runningChecks: 1,
    scheduleImmediate: (_id: string) => true,
  }

  const adapter = new MongoDBAdapter(dbUri, dbPrefix, testConfig)
  let serverReady = false

  try {
    await adapter.connect()
    await adapter.migrate()
    console.log('  ✓  Adapter connected + migrated')
    passed++
    serverReady = true
  } catch (err) {
    console.log(`  ✗  Setup failed: ${err instanceof Error ? err.message : String(err)}`)
    failed++
  }

  if (serverReady) {
    const server = await buildServer({
      adapter,
      scheduler: mockScheduler as unknown as CheckScheduler,
      config: testConfig,
    })

    // Track created IDs for cleanup
    const createdEndpointIds: string[] = []
    const createdChannelIds: string[] = []
    const createdWindowIds: string[] = []

    // ── Health ──────────────────────────────────────────────────────────────

    section('API routes — health')

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/health/ping` })
      const body = JSON.parse(res.body) as { status: string }
      assert(res.statusCode === 200, 'GET /health/ping → 200')
      assert(body.status === 'ok', 'GET /health/ping body.status = "ok"')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/health` })
      const body = JSON.parse(res.body) as {
        status: string; db: unknown; scheduler: unknown; uptime: number
      }
      assert(res.statusCode === 200, 'GET /health → 200')
      assert(typeof body.status === 'string', 'GET /health has status field')
      assert(body.db !== undefined, 'GET /health has db field')
      assert(body.scheduler !== undefined, 'GET /health has scheduler field')
      assert(typeof body.uptime === 'number', 'GET /health has numeric uptime')
    }

    // ── Error format ─────────────────────────────────────────────────────────

    section('API routes — error format')

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/does-not-exist` })
      const body = JSON.parse(res.body) as { error: boolean; code: string }
      assert(res.statusCode === 404, 'unknown route → 404')
      assert(body.error === true, '404 body.error = true')
      assert(typeof body.code === 'string', '404 body.code is a string')
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints`,
        payload: {},
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { error: boolean; code: string; errors?: unknown[] }
      assert(res.statusCode === 422, 'POST /endpoints with empty body → 422')
      assert(body.code === 'VALIDATION_ERROR', 'validation error code is VALIDATION_ERROR')
      assert(Array.isArray(body.errors), 'validation error includes errors array')
    }

    // ── Endpoints CRUD ───────────────────────────────────────────────────────

    section('API routes — endpoints CRUD')

    let httpEndpointId = ''
    let portEndpointId = ''

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints`,
        payload: { name: 'Test HTTP', type: 'http', url: 'https://httpbin.org/status/200' },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { _id: string; name: string; checkInterval: number } }
      assert(res.statusCode === 201, 'POST /endpoints (HTTP) → 201')
      assert(body.data.name === 'Test HTTP', 'created endpoint has correct name')
      assert(body.data.checkInterval === defaults.defaults.checkInterval, 'default checkInterval applied')
      httpEndpointId = body.data._id
      if (httpEndpointId) createdEndpointIds.push(httpEndpointId)
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints`,
        payload: { name: 'Test Port', type: 'port', host: 'example.com', port: 80 },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { _id: string; type: string } }
      assert(res.statusCode === 201, 'POST /endpoints (port) → 201')
      assert(body.data.type === 'port', 'port endpoint has type = "port"')
      portEndpointId = body.data._id
      if (portEndpointId) createdEndpointIds.push(portEndpointId)
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints`,
        payload: { name: 'Missing URL', type: 'http' },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { code: string; errors: Array<{ field: string }> }
      assert(res.statusCode === 422, 'POST /endpoints missing url → 422')
      assert(body.errors.some((e) => e.field === 'body.url'), 'error points at body.url')
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints`,
        payload: { name: 'Bad URL', type: 'http', url: 'not-a-url' },
        headers: { 'content-type': 'application/json' },
      })
      assert(res.statusCode === 422, 'POST /endpoints invalid URL → 422')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/endpoints` })
      const body = JSON.parse(res.body) as { data: unknown[]; pagination: { total: number } }
      assert(res.statusCode === 200, 'GET /endpoints → 200')
      assert(Array.isArray(body.data), 'GET /endpoints returns data array')
      assert(typeof body.pagination.total === 'number', 'GET /endpoints has pagination.total')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/endpoints/archived` })
      const body = JSON.parse(res.body) as { data: unknown[] }
      assert(res.statusCode === 200, 'GET /endpoints/archived → 200')
      assert(Array.isArray(body.data), 'GET /endpoints/archived returns data array')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/endpoints/${httpEndpointId}` })
      const body = JSON.parse(res.body) as { data: { _id: string }; latestCheck: unknown }
      assert(res.statusCode === 200, 'GET /endpoints/:id → 200')
      assert(body.data._id === httpEndpointId, 'GET /endpoints/:id returns correct endpoint')
      assert('latestCheck' in body, 'GET /endpoints/:id includes latestCheck field')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/endpoints/not-a-valid-id` })
      const body = JSON.parse(res.body) as { code: string }
      assert(res.statusCode === 400, 'GET /endpoints/:id with invalid ObjectId → 400')
      assert(body.code === 'INVALID_ID', 'error code is INVALID_ID')
    }

    {
      const fakeId = new ObjectId().toHexString()
      const res = await server.inject({ method: 'GET', url: `${BASE}/endpoints/${fakeId}` })
      assert(res.statusCode === 404, 'GET /endpoints/:id non-existent → 404')
    }

    {
      const res = await server.inject({
        method: 'PUT',
        url: `${BASE}/endpoints/${httpEndpointId}`,
        payload: { name: 'Updated HTTP', checkInterval: 120 },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { name: string; checkInterval: number } }
      assert(res.statusCode === 200, 'PUT /endpoints/:id → 200')
      assert(body.data.name === 'Updated HTTP', 'PUT /endpoints/:id updates name')
      assert(body.data.checkInterval === 120, 'PUT /endpoints/:id updates checkInterval')
    }

    {
      const res = await server.inject({
        method: 'PATCH',
        url: `${BASE}/endpoints/${httpEndpointId}/toggle`,
      })
      const body = JSON.parse(res.body) as { data: { status: string } }
      assert(res.statusCode === 200, 'PATCH /endpoints/:id/toggle → 200')
      assert(body.data.status === 'paused', 'toggle: active → paused')
    }

    {
      // Toggle back to active
      const res = await server.inject({
        method: 'PATCH',
        url: `${BASE}/endpoints/${httpEndpointId}/toggle`,
      })
      const body = JSON.parse(res.body) as { data: { status: string } }
      assert(res.statusCode === 200, 'PATCH toggle a second time → 200')
      assert(body.data.status === 'active', 'toggle: paused → active')
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/endpoints/${httpEndpointId}/recheck`,
      })
      const body = JSON.parse(res.body) as { status: string }
      assert(res.statusCode === 202, 'POST /endpoints/:id/recheck → 202')
      assert(body.status === 'scheduled', 'recheck body.status = "scheduled"')
    }

    // ── Checks ────────────────────────────────────────────────────────────────

    section('API routes — checks')

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}/checks`,
      })
      const body = JSON.parse(res.body) as { data: unknown[]; pagination: unknown }
      assert(res.statusCode === 200, 'GET /endpoints/:id/checks → 200')
      assert(Array.isArray(body.data), 'checks returns data array')
      assert(body.pagination !== undefined, 'checks has pagination envelope')
    }

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}/uptime`,
      })
      const body = JSON.parse(res.body) as { data: Record<string, number> }
      assert(res.statusCode === 200, 'GET /endpoints/:id/uptime → 200')
      assert(typeof body.data['24h'] === 'number', 'uptime has 24h field')
      assert(typeof body.data['7d'] === 'number', 'uptime has 7d field')
      assert(typeof body.data['30d'] === 'number', 'uptime has 30d field')
      assert(typeof body.data['90d'] === 'number', 'uptime has 90d field')
    }

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}/hourly`,
      })
      const body = JSON.parse(res.body) as { data: unknown[] }
      assert(res.statusCode === 200, 'GET /endpoints/:id/hourly → 200')
      assert(Array.isArray(body.data), 'hourly returns data array')
    }

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}/daily`,
      })
      const body = JSON.parse(res.body) as { data: unknown[] }
      assert(res.statusCode === 200, 'GET /endpoints/:id/daily → 200')
      assert(Array.isArray(body.data), 'daily returns data array')
    }

    // ── Incidents ─────────────────────────────────────────────────────────────

    section('API routes — incidents')

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/incidents` })
      const body = JSON.parse(res.body) as { data: unknown[]; pagination: unknown }
      assert(res.statusCode === 200, 'GET /incidents → 200')
      assert(Array.isArray(body.data), 'incidents returns data array')
      assert(body.pagination !== undefined, 'incidents has pagination envelope')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/incidents/active` })
      const body = JSON.parse(res.body) as { data: unknown[] }
      assert(res.statusCode === 200, 'GET /incidents/active → 200')
      assert(Array.isArray(body.data), 'active incidents returns data array')
    }

    {
      const fakeId = new ObjectId().toHexString()
      const res = await server.inject({ method: 'GET', url: `${BASE}/incidents/${fakeId}` })
      assert(res.statusCode === 404, 'GET /incidents/:id non-existent → 404')
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    section('API routes — notifications')

    let channelId = ''

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/notifications/channels` })
      const body = JSON.parse(res.body) as { data: unknown[] }
      assert(res.statusCode === 200, 'GET /notifications/channels → 200')
      assert(Array.isArray(body.data), 'channels returns data array')
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/notifications/channels`,
        payload: { type: 'discord', name: 'Test Discord', discordWebhookUrl: 'https://discord.com/api/webhooks/test' },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { _id: string; type: string; name: string } }
      assert(res.statusCode === 201, 'POST /notifications/channels → 201')
      assert(body.data.type === 'discord', 'created channel has correct type')
      assert(body.data.name === 'Test Discord', 'created channel has correct name')
      channelId = body.data._id
      if (channelId) createdChannelIds.push(channelId)
    }

    {
      const res = await server.inject({
        method: 'PUT',
        url: `${BASE}/notifications/channels/${channelId}`,
        payload: { name: 'Renamed Discord', deliveryPriority: 'critical' },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { name: string; deliveryPriority: string } }
      assert(res.statusCode === 200, 'PUT /notifications/channels/:id → 200')
      assert(body.data.name === 'Renamed Discord', 'channel name updated')
      assert(body.data.deliveryPriority === 'critical', 'channel deliveryPriority updated')
    }

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/notifications/log`,
      })
      const body = JSON.parse(res.body) as { data: unknown[]; pagination: unknown }
      assert(res.statusCode === 200, 'GET /notifications/log → 200')
      assert(body.pagination !== undefined, 'notification log has pagination envelope')
    }

    // ── Maintenance ───────────────────────────────────────────────────────────

    section('API routes — maintenance')

    let windowId = ''

    {
      const startTime = new Date(Date.now() + 60_000).toISOString()
      const endTime = new Date(Date.now() + 3_600_000).toISOString()
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/maintenance`,
        payload: {
          endpointIds: [httpEndpointId],
          startTime,
          endTime,
          reason: 'Test maintenance',
        },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: Array<{ _id: string }> }
      assert(res.statusCode === 201, 'POST /maintenance → 201')
      assert(Array.isArray(body.data), 'POST /maintenance returns array of windows')
      assert(body.data.length === 1, 'one window created for one endpointId')
      windowId = body.data[0]?._id ?? ''
      if (windowId) createdWindowIds.push(windowId)
    }

    {
      const res = await server.inject({
        method: 'POST',
        url: `${BASE}/maintenance`,
        payload: {
          endpointIds: [httpEndpointId],
          startTime: new Date(Date.now() + 3_600_000).toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
          reason: 'Bad window',
        },
        headers: { 'content-type': 'application/json' },
      })
      assert(res.statusCode === 422, 'POST /maintenance with endTime before startTime → 422')
    }

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/maintenance` })
      const body = JSON.parse(res.body) as { data: Array<{ windowId: string; status: string }> }
      assert(res.statusCode === 200, 'GET /maintenance → 200')
      assert(Array.isArray(body.data), 'GET /maintenance returns data array')
      const ourWindow = body.data.find((w) => w.windowId === windowId)
      assert(ourWindow !== undefined, 'created window appears in list')
      assert(ourWindow?.status === 'scheduled', 'future window has status = "scheduled"')
    }

    {
      const res = await server.inject({
        method: 'DELETE',
        url: `${BASE}/maintenance/${windowId}`,
      })
      assert(res.statusCode === 204, 'DELETE /maintenance/:id → 204')
      createdWindowIds.splice(createdWindowIds.indexOf(windowId), 1)
    }

    {
      const res = await server.inject({
        method: 'DELETE',
        url: `${BASE}/maintenance/${windowId}`,
      })
      assert(res.statusCode === 404, 'DELETE /maintenance/:id already gone → 404')
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    section('API routes — settings')

    {
      const res = await server.inject({ method: 'GET', url: `${BASE}/settings` })
      const body = JSON.parse(res.body) as { data: { _id: string } }
      assert(res.statusCode === 200, 'GET /settings → 200')
      assert(body.data._id === 'global', 'settings doc has _id = "global"')
    }

    {
      const res = await server.inject({
        method: 'PUT',
        url: `${BASE}/settings`,
        payload: { theme: 'dark', customKey: 42 },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { theme: string; customKey: number } }
      assert(res.statusCode === 200, 'PUT /settings → 200')
      assert(body.data.theme === 'dark', 'PUT /settings persists theme value')
      assert(body.data.customKey === 42, 'PUT /settings persists arbitrary fields')
    }

    {
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}/settings`,
      })
      const body = JSON.parse(res.body) as { data: Record<string, unknown> }
      assert(res.statusCode === 200, 'GET /endpoints/:id/settings → 200')
      assert('checkInterval' in body.data, 'endpoint settings includes checkInterval')
      assert('timeout' in body.data, 'endpoint settings includes timeout')
    }

    {
      const res = await server.inject({
        method: 'PUT',
        url: `${BASE}/endpoints/${httpEndpointId}/settings`,
        payload: { checkInterval: 300, latencyThreshold: 2000 },
        headers: { 'content-type': 'application/json' },
      })
      const body = JSON.parse(res.body) as { data: { checkInterval: number; latencyThreshold: number } }
      assert(res.statusCode === 200, 'PUT /endpoints/:id/settings → 200')
      assert(body.data.checkInterval === 300, 'endpoint checkInterval updated to 300')
      assert(body.data.latencyThreshold === 2000, 'endpoint latencyThreshold updated to 2000')
    }

    // ── Auth middleware ───────────────────────────────────────────────────────

    section('API routes — auth middleware')

    {
      // Server with auth that always rejects
      const authConfig: WatchDeckConfig = {
        ...testConfig,
        authMiddleware: async (_req, reply) => {
          await (reply as { code(n: number): { send(b: unknown): void } })
            .code(401)
            .send({ error: true, code: 'UNAUTHORIZED', message: 'Test rejection' })
        },
      }
      const authServer = await buildServer({
        adapter,
        scheduler: mockScheduler as unknown as CheckScheduler,
        config: authConfig,
      })

      const rejectedRes = await authServer.inject({
        method: 'GET',
        url: `${BASE}/endpoints`,
      })
      assert(rejectedRes.statusCode === 401, 'auth: protected route returns 401 when middleware rejects')

      const publicRes = await authServer.inject({
        method: 'GET',
        url: `${BASE}/health/ping`,
      })
      assert(publicRes.statusCode === 200, 'auth: public health/ping still returns 200')

      await authServer.close()
    }

    // ── Delete endpoints (archive default, hard delete) ───────────────────────

    section('API routes — delete')

    {
      const res = await server.inject({
        method: 'DELETE',
        url: `${BASE}/endpoints/${portEndpointId}`,
      })
      assert(res.statusCode === 204, 'DELETE /endpoints/:id (default archive) → 204')
      createdEndpointIds.splice(createdEndpointIds.indexOf(portEndpointId), 1)

      const check = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${portEndpointId}`,
      })
      const body = JSON.parse(check.body) as { data: { status: string } }
      assert(body.data.status === 'archived', 'archived endpoint has status = "archived"')
    }

    {
      const res = await server.inject({
        method: 'DELETE',
        url: `${BASE}/endpoints/${httpEndpointId}?mode=hard`,
      })
      assert(res.statusCode === 204, 'DELETE /endpoints/:id?mode=hard → 204')
      createdEndpointIds.splice(createdEndpointIds.indexOf(httpEndpointId), 1)

      const check = await server.inject({
        method: 'GET',
        url: `${BASE}/endpoints/${httpEndpointId}`,
      })
      assert(check.statusCode === 404, 'hard-deleted endpoint returns 404 on subsequent GET')
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    section('Cleanup')

    for (const id of createdEndpointIds) {
      await adapter.deleteEndpoint(id).catch(() => {})
    }
    for (const id of createdChannelIds) {
      await adapter.deleteNotificationChannel(id).catch(() => {})
    }
    for (const id of createdWindowIds) {
      await adapter.removeMaintenanceWindow(id).catch(() => {})
    }

    await server.close()
    await adapter.disconnect()
    console.log('  ✓  Server closed + adapter disconnected')
    passed++
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`── Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
