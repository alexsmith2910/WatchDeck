/**
 * `buffer` probe — exercises the BufferPipeline.simulateWrite() method which
 * pushes a synthetic record through whichever path is currently active
 * (live ➝ DB ping; or buffering / disk-spill ➝ memory push) and returns the
 * round-trip latency in ms.
 *
 * Mode mapping per spec §5.4:
 *   live       → healthy (or degraded if synthetic-write latency > 500 ms)
 *   standby    → standby
 *   buffering  → degraded
 *   disk-spill → degraded
 *   replaying  → degraded
 *   throw      → down
 *
 * The 500 ms degraded threshold exists so DB ping spikes don't double-report
 * here AND on the db probe — the latter owns reporting database latency. We
 * only flag buffer-degraded when the round-trip is dramatically slow.
 */

import type { ProbeFn } from '../probeTypes.js'
import type { BufferPipeline } from '../../../buffer/pipeline.js'
import type { MemoryBuffer } from '../../../buffer/memoryBuffer.js'
import type { DiskBuffer } from '../../../buffer/diskBuffer.js'
import type { CheckWritePayload } from '../../../storage/types.js'

const LIVE_DEGRADED_MS = 500

export interface BufferProbeDeps {
  pipeline: BufferPipeline
  memBuffer: MemoryBuffer<CheckWritePayload>
  diskBuffer: DiskBuffer
}

export function createBufferProbe(deps: BufferProbeDeps): ProbeFn {
  const { pipeline, memBuffer, diskBuffer } = deps

  return async () => {
    const modeBefore = pipeline.getMode()
    let latencyMs: number | null = null
    try {
      latencyMs = Math.round(await pipeline.simulateWrite())
      const modeAfter = pipeline.getMode()

      let status: 'healthy' | 'degraded' | 'down' | 'standby'
      if (modeAfter === 'standby') {
        status = 'standby'
      } else if (modeAfter !== 'live') {
        // buffering / disk-spill / replaying — pipeline is working but degraded.
        status = 'degraded'
      } else if (latencyMs > LIVE_DEGRADED_MS) {
        status = 'degraded'
      } else {
        status = 'healthy'
      }

      const [diskLines, diskSizeBytes] = await Promise.all([
        diskBuffer.lineCount().catch(() => 0),
        diskBuffer.sizeBytes().catch(() => 0),
      ])

      return {
        subsystemId: 'buffer',
        status,
        latencyMs,
        details: {
          mode: modeAfter,
          modeBefore,
          memorySize: memBuffer.size,
          memoryCapacity: memBuffer.capacity,
          diskLines,
          diskSizeBytes,
        },
        probedAt: Date.now(),
      }
    } catch (err) {
      const [diskLines, diskSizeBytes] = await Promise.all([
        diskBuffer.lineCount().catch(() => 0),
        diskBuffer.sizeBytes().catch(() => 0),
      ])
      return {
        subsystemId: 'buffer',
        status: 'down',
        latencyMs,
        details: {
          mode: modeBefore,
          memorySize: memBuffer.size,
          memoryCapacity: memBuffer.capacity,
          diskLines,
          diskSizeBytes,
        },
        probedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
