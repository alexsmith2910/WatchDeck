import type { StorageAdapter } from '../storage/adapter.js'
import type { CheckWritePayload } from '../storage/types.js'
import type { DiskBuffer } from './diskBuffer.js'
import { eventBus } from '../core/eventBus.js'

const BATCH_SIZE = 100
const BATCH_PAUSE_MS = 50
const RETRY_ATTEMPTS = 3
const RETRY_GAP_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface ReplayResult {
  replayed: number
  errors: number
}

/**
 * Replay buffered check results from disk to the database.
 *
 * Processes in batches of 100 with 50ms pauses between batches.
 * Each batch retries up to 3 times with 5-second gaps before giving up.
 * On batch failure after all retries the replay stops — remaining entries
 * stay on disk for the next reconnect attempt.
 *
 * Emits replay:progress events throughout so the SSE broker can stream
 * progress to connected dashboard clients.
 */
export async function replayFromDisk(
  adapter: StorageAdapter,
  diskBuffer: DiskBuffer,
): Promise<ReplayResult> {
  const totalLines = await diskBuffer.lineCount()
  if (totalLines === 0) return { replayed: 0, errors: 0 }

  const totalBatches = Math.ceil(totalLines / BATCH_SIZE)
  let replayed = 0
  let errors = 0
  let batchNum = 0

  while (!(await diskBuffer.isEmpty())) {
    const rawBatch = await diskBuffer.readBatch(BATCH_SIZE)
    if (rawBatch.length === 0) break

    batchNum++

    eventBus.emit('replay:progress', {
      timestamp: new Date(),
      status: 'running',
      batchCurrent: batchNum,
      batchTotal: totalBatches,
      resultsCurrent: replayed,
      resultsTotal: totalLines,
      errors,
      percentComplete: Math.round((replayed / totalLines) * 100),
    })

    const batch = rawBatch as CheckWritePayload[]
    let success = false

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        await adapter.saveManyChecks(batch)
        await diskBuffer.truncateBatch(rawBatch.length)
        replayed += rawBatch.length
        success = true
        break
      } catch {
        if (attempt < RETRY_ATTEMPTS) {
          await sleep(RETRY_GAP_MS)
        }
      }
    }

    if (!success) {
      errors += rawBatch.length
      // Leave remaining entries on disk — stop here, try again on next reconnect.
      break
    }

    await sleep(BATCH_PAUSE_MS)
  }

  eventBus.emit('replay:progress', {
    timestamp: new Date(),
    status: errors === 0 ? 'complete' : 'failed',
    batchCurrent: batchNum,
    batchTotal: totalBatches,
    resultsCurrent: replayed,
    resultsTotal: totalLines,
    errors,
    percentComplete: totalLines > 0 ? Math.round((replayed / totalLines) * 100) : 100,
  })

  return { replayed, errors }
}
