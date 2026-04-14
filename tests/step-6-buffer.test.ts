/**
 * Step 6 — Buffer Pipeline test script
 * Run: npx tsx tests/step-6-buffer.test.ts
 *
 * Sections 1-3 are pure / file-I/O only.
 * Section 4 (replay integration) and Section 5 (CLI observe) require MX_DB_URI.
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFile, unlink, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { ObjectId } from 'mongodb'
import dotenv from 'dotenv'

import { MemoryBuffer } from '../src/buffer/memoryBuffer.js'
import { DiskBuffer } from '../src/buffer/diskBuffer.js'
import { replayFromDisk } from '../src/buffer/replay.js'
import { MongoDBAdapter } from '../src/storage/mongodb.js'
import type { WatchDeckConfig } from '../src/config/types.js'
import type { CheckWritePayload } from '../src/storage/types.js'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// Load .env from cwd (run from test_watchdeck) or the sibling test project dir.
dotenv.config({ quiet: true })
if (!process.env.MX_DB_URI) {
  const fallback = path.resolve(projectRoot, '..', 'test_watchdeck', '.env')
  dotenv.config({ path: fallback, quiet: true })
}

// Paths
const tempBufferPath = path.join(os.tmpdir(), `wd-test-${Date.now()}.jsonl`)
const realBufferPath = path.join(os.homedir(), '.watchdeck', 'buffer.jsonl')

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

function makePayload(overrides?: Partial<CheckWritePayload>): CheckWritePayload {
  return {
    timestamp: new Date(),
    endpointId: new ObjectId().toHexString(),
    status: 'healthy',
    responseTime: 42,
    statusCode: 200,
    errorMessage: null,
    ...overrides,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// Section 1 — MemoryBuffer
// ---------------------------------------------------------------------------

section('MemoryBuffer')

{
  const buf = new MemoryBuffer<number>(3)

  assert(buf.isEmpty(), 'starts empty')
  assert(!buf.isFull(), 'not full when empty')
  assert(buf.size === 0, 'size = 0 on creation')

  assert(buf.push(1) === true, 'push 1 accepted')
  assert(buf.push(2) === true, 'push 2 accepted')
  assert(buf.push(3) === true, 'push 3 — at capacity')
  assert(buf.isFull(), 'isFull() true at capacity')
  assert(buf.push(4) === false, 'push 4 rejected when full')
  assert(buf.size === 3, `size = 3 (got ${buf.size})`)

  const items = buf.flush()
  assert(items.length === 3, `flush returns 3 items (got ${items.length})`)
  assert(JSON.stringify(items) === '[1,2,3]', `flush order correct: ${JSON.stringify(items)}`)
  assert(buf.isEmpty(), 'empty after flush')
  assert(buf.size === 0, 'size = 0 after flush')

  assert(buf.push(99) === true, 'push accepted again after flush')
  assert(buf.size === 1, 'size = 1 after post-flush push')
}

// ---------------------------------------------------------------------------
// Section 2 — DiskBuffer
// ---------------------------------------------------------------------------

section('DiskBuffer — basic operations')

{
  const buf = new DiskBuffer(tempBufferPath)

  assert(await buf.isEmpty(), 'isEmpty() true before first write')
  assert(await buf.lineCount() === 0, 'lineCount = 0 before first write')

  const p1 = makePayload({ status: 'healthy' })
  const p2 = makePayload({ status: 'degraded' })
  const p3 = makePayload({ status: 'down' })

  await buf.append([p1, p2, p3])
  assert(await buf.lineCount() === 3, `lineCount = 3 after append (got ${await buf.lineCount()})`)
  assert(!(await buf.isEmpty()), 'not empty after append')

  const batch = await buf.readBatch(2)
  assert(batch.length === 2, `readBatch(2) returns 2 items (got ${batch.length})`)
  assert((batch[0] as CheckWritePayload).status === 'healthy', 'first item is healthy')
  assert((batch[1] as CheckWritePayload).status === 'degraded', 'second item is degraded')

  // readBatch does not consume — lineCount unchanged
  assert(await buf.lineCount() === 3, 'readBatch does not consume (lineCount still 3)')

  await buf.truncateBatch(2)
  assert(await buf.lineCount() === 1, `lineCount = 1 after truncateBatch(2) (got ${await buf.lineCount()})`)
  const leftover = (await buf.readBatch(10))[0] as CheckWritePayload
  assert(leftover.status === 'down', `remaining entry is 'down' (got '${leftover.status}')`)

  await buf.truncateBatch(1)
  assert(await buf.isEmpty(), 'empty after truncating last entry')
}

// ---------------------------------------------------------------------------
// Section 3 — DiskBuffer corrupted line skipping
// ---------------------------------------------------------------------------

section('DiskBuffer — corrupted line skipping')

{
  const buf = new DiskBuffer(tempBufferPath)
  const good = makePayload()

  // Write good, corrupt, good  (total 3 lines)
  await buf.append([good])
  await appendFile(tempBufferPath, 'THIS IS NOT JSON\n', 'utf8')
  await buf.append([good])

  let warnFired = false
  const { eventBus } = await import('../src/core/eventBus.js')
  const unsub = eventBus.subscribe('system:warning', ({ module }) => {
    if (module === 'disk-buffer') warnFired = true
  })

  const batch = await buf.readBatch(10)
  unsub()

  assert(batch.length === 2, `2 valid items returned — corrupted line skipped (got ${batch.length})`)
  assert(warnFired, 'system:warning emitted for corrupted line')

  await buf.truncateBatch(3) // clear all 3 raw lines
}

// ---------------------------------------------------------------------------
// Section 4 — Replay integration (needs DB)
// ---------------------------------------------------------------------------

const dbUri = process.env.MX_DB_URI
const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'

if (!dbUri) {
  section('Replay integration  (SKIPPED — MX_DB_URI not set)')
  console.log('  ℹ  Run from a directory with .env to enable DB tests')
} else {
  section('Replay integration')

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
    const buf = new DiskBuffer(tempBufferPath)

    // Seed 5 payloads
    const payloads = Array.from({ length: 5 }, () => makePayload())
    await buf.append(payloads)
    assert(await buf.lineCount() === 5, 'seeded 5 entries')

    const result = await replayFromDisk(adapter, buf)
    assert(result.replayed === 5, `replayed = 5 (got ${result.replayed})`)
    assert(result.errors === 0, `errors = 0 (got ${result.errors})`)
    assert(await buf.isEmpty(), 'disk buffer empty after successful replay')

    await adapter.disconnect()
    console.log('  ✓  Adapter disconnected')
    passed++
  }
}

// ---------------------------------------------------------------------------
// Section 5 — Startup replay observe (seeds buffer, runs CLI)
// ---------------------------------------------------------------------------

const cliBin = path.join(projectRoot, 'dist', 'bin', 'cli.js')
const testProjectDir = path.resolve(projectRoot, '..', 'test_watchdeck')
const canObserve = dbUri && await fileExists(cliBin) && await fileExists(testProjectDir)

if (!canObserve) {
  section('Startup replay observe  (SKIPPED)')
  if (!dbUri) console.log('  ℹ  No MX_DB_URI')
  if (!await fileExists(cliBin)) console.log('  ℹ  No dist/ — run npm run build first')
  if (!await fileExists(testProjectDir)) console.log('  ℹ  No test_watchdeck directory found')
} else {
  section('Startup replay observe')

  // Seed 3 entries into the real buffer
  const buf = new DiskBuffer(realBufferPath)
  const seed = Array.from({ length: 3 }, (_, i) =>
    makePayload({ status: i === 0 ? 'healthy' : i === 1 ? 'degraded' : 'down' }),
  )
  await buf.append(seed)
  assert(await buf.lineCount() === 3, 'seeded 3 entries into real buffer')

  // Spawn watchdeck start, collect output, kill after 12 s
  const output = await new Promise<string>((resolve) => {
    let out = ''
    const proc = spawn('node', [cliBin, 'start'], {
      cwd: testProjectDir,
      env: process.env,
    })
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { out += chunk.toString() })
    setTimeout(() => { proc.kill(); resolve(out) }, 12_000)
    proc.on('exit', () => resolve(out))
  })

  console.log('\n  CLI output:')
  for (const line of output.split('\n')) {
    console.log('  ' + line)
  }

  // Buffer should be empty — replay consumed all entries
  assert(await buf.isEmpty(), 'real disk buffer empty after startup replay')
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

try { await unlink(tempBufferPath) } catch { /* already gone */ }

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`── Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
