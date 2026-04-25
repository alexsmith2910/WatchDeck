/**
 * Seed script — populates WatchDeck with test endpoints via the API.
 *
 * Requires a running server:
 *   Terminal 1:  npx tsx src/bin/cli.ts start --verbose
 *   Terminal 2:  npx tsx tests/seed-endpoints.ts
 *
 * Options (env vars):
 *   PORT=4000       target port  (default: 4000)
 *   BASE=/api/mx    API base path (default: /api/mx)
 *
 * Creates 12 endpoints: 8 healthy HTTP, 1 healthy port, 2 broken HTTP, 1 broken port.
 * Re-running is safe — duplicates will just be added (clean via the dashboard or DB).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? '4000'
const BASE = process.env.BASE ?? '/api/mx'
const HOST = `http://localhost:${PORT}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${HOST}${BASE}${urlPath}`
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
// Endpoint definitions
// ---------------------------------------------------------------------------

const endpoints = [
  // ── Working HTTP endpoints ────────────────────────────────────────────────
  {
    name: 'Google',
    type: 'http',
    url: 'https://www.google.com',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },
  {
    name: 'GitHub',
    type: 'http',
    url: 'https://github.com',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },
  {
    name: 'Cloudflare',
    type: 'http',
    url: 'https://www.cloudflare.com',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 120,
  },
  {
    name: 'JSONPlaceholder API',
    type: 'http',
    url: 'https://jsonplaceholder.typicode.com/posts/1',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },
  {
    name: 'httpbin — 200 OK',
    type: 'http',
    url: 'https://httpbin.org/status/200',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },
  {
    name: 'Example.com',
    type: 'http',
    url: 'https://example.com',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 300,
  },
  {
    name: 'Wikipedia',
    type: 'http',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 120,
  },
  {
    name: 'Hacker News',
    type: 'http',
    url: 'https://news.ycombinator.com',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 120,
  },

  // ── Working port endpoint ─────────────────────────────────────────────────
  {
    name: 'Google DNS (TCP 53)',
    type: 'port',
    host: '8.8.8.8',
    port: 53,
    checkInterval: 120,
  },

  // ── Broken HTTP endpoints ─────────────────────────────────────────────────
  {
    name: 'Dead API Server',
    type: 'http',
    url: 'https://thisdomaindoesnotexist-wd.example',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },
  {
    name: 'httpbin — 503 Error',
    type: 'http',
    url: 'https://httpbin.org/status/503',
    method: 'GET',
    expectedStatusCodes: [200],
    checkInterval: 60,
  },

  // ── Broken port endpoint ──────────────────────────────────────────────────
  {
    name: 'Closed Port (TCP 9999)',
    type: 'port',
    host: '127.0.0.1',
    port: 9999,
    checkInterval: 60,
  },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n  WatchDeck — seed endpoints`)
console.log(`  Target: ${HOST}${BASE}\n`)

// Check server is up
try {
  const probe = await fetch(`${HOST}${BASE}/health/ping`)
  if (!probe.ok) throw new Error(`status ${probe.status}`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`  ✗  Cannot reach server at ${HOST}${BASE}/health/ping — ${msg}`)
  console.error(`     Start the server first: npx tsx src/bin/cli.ts start --verbose\n`)
  process.exit(1)
}

let created = 0
let errors = 0

for (const ep of endpoints) {
  const { status, data } = await req('POST', '/endpoints', ep)
  if (status === 201) {
    const d = (data as Record<string, unknown>)?.data as Record<string, unknown>
    console.log(`  ✓  ${ep.name}  (${d?.id})`)
    created++
  } else {
    const d = data as Record<string, unknown>
    console.log(`  ✗  ${ep.name}  → ${status}: ${d?.message ?? JSON.stringify(d)}`)
    errors++
  }
}

console.log(`\n  Done: ${created} created, ${errors} failed\n`)
process.exit(errors > 0 ? 1 : 0)
