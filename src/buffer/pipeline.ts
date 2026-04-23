import type { StorageAdapter } from '../storage/adapter.js'
import type { CheckWritePayload } from '../storage/types.js'
import type { EventMap } from '../core/eventTypes.js'
import { eventBus } from '../core/eventBus.js'
import { MemoryBuffer } from './memoryBuffer.js'
import { DiskBuffer } from './diskBuffer.js'
import { replayFromDisk } from './replay.js'
import type { OutageTracker } from './outageTracker.js'

/**
 * Buffer pipeline — routes check results from the check engine to MongoDB,
 * falling back to an in-memory buffer (then disk) when the DB is unavailable.
 *
 * Modes (exposed to the health probe):
 *   - `live`       — DB connected; checks are written through directly.
 *   - `standby`    — DB connected, memory buffer empty, no recent write
 *                    failures. The default resting state with no traffic.
 *   - `buffering`  — DB disconnected; new checks land in the memory buffer.
 *   - `disk-spill` — Memory buffer is full and we are spilling to disk.
 *   - `replaying`  — DB reconnected and we are draining memory + disk.
 *
 * `simulateWrite()` exercises the pipeline through the same `handleCheck()`
 * path that real traffic takes, but with a synthetic payload that is never
 * persisted. The health probe calls it to measure end-to-end buffer latency.
 */

export type BufferMode = 'live' | 'standby' | 'buffering' | 'disk-spill' | 'replaying'

const RECENT_FAILURE_WINDOW_MS = 60_000 // 1 minute

export class BufferPipeline {
  private mode: BufferMode = 'standby'
  /** Epoch ms of the most recent successful live write. 0 until one happens. */
  private lastLiveWriteAt = 0
  /** Epoch ms of the most recent write failure. 0 until one happens. */
  private lastFailureAt = 0

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly memBuffer: MemoryBuffer<CheckWritePayload>,
    private readonly diskBuffer: DiskBuffer,
    private readonly outageTracker: OutageTracker,
  ) {}

  /**
   * Current write mode. Also called from inside the class after state
   * changes so the computed `standby` result is always fresh.
   */
  getMode(): BufferMode {
    if (this.mode === 'buffering' || this.mode === 'disk-spill' || this.mode === 'replaying') {
      return this.mode
    }
    // `live` and `standby` are computed from runtime state — not stored.
    if (!this.adapter.isConnected()) return 'buffering'
    if (this.lastFailureAt > Date.now() - RECENT_FAILURE_WINDOW_MS) return 'live'
    if (!this.memBuffer.isEmpty()) return 'live'
    if (this.lastLiveWriteAt === 0) return 'standby'
    // Within the last RECENT_FAILURE_WINDOW_MS someone wrote successfully? Call it live.
    if (this.lastLiveWriteAt > Date.now() - RECENT_FAILURE_WINDOW_MS) return 'live'
    return 'standby'
  }

  register(): void {
    eventBus.subscribe('db:disconnected', () => { this.mode = 'buffering' }, 'critical')
    eventBus.subscribe('check:complete', (payload) => { void this.handleCheck(payload) }, 'critical')
    eventBus.subscribe('db:reconnected', () => { void this.handleReconnect() }, 'critical')
  }

  // ---------------------------------------------------------------------------
  // Synthetic write for health probe
  // ---------------------------------------------------------------------------

  /**
   * Run a synthetic write through the same happy path real traffic uses. The
   * payload is never persisted: in live mode we only measure the adapter ping
   * latency; in buffered modes we push and immediately remove the sentinel.
   * Returns the round-trip time in ms.
   */
  async simulateWrite(): Promise<number> {
    const start = performance.now()
    const mode = this.getMode()

    if ((mode === 'live' || mode === 'standby') && this.adapter.isConnected()) {
      // Exercise the adapter end of the hot path without persisting a row.
      // Implementations do a ping which is the same round-trip a real write
      // would experience before the insert.
      await this.adapter.healthCheck()
      return performance.now() - start
    }

    // In buffering / disk-spill / replaying we measure the memory path. The
    // sentinel must not leak into the real buffered set.
    const sentinel: CheckWritePayload = {
      timestamp: new Date(),
      endpointId: '000000000000000000000000',
      status: 'healthy',
      responseTime: 0,
      statusCode: null,
      errorMessage: '__watchdeck_synthetic_probe__',
      sslDaysRemaining: null,
    }
    if (this.memBuffer.push(sentinel)) {
      // flush() empties the buffer atomically, so we must filter the sentinel
      // out and re-push the real items to preserve accumulated backlog.
      const drained = this.memBuffer.flush()
      for (const item of drained) {
        if (item.errorMessage === '__watchdeck_synthetic_probe__') continue
        this.memBuffer.push(item)
      }
    }
    return performance.now() - start
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private async handleCheck(payload: EventMap['check:complete']): Promise<void> {
    const item: CheckWritePayload = {
      timestamp: payload.timestamp,
      endpointId: payload.endpointId,
      status: payload.status,
      responseTime: payload.responseTime,
      statusCode: payload.statusCode,
      errorMessage: payload.errorMessage,
      sslDaysRemaining: payload.sslDaysRemaining,
      bodyBytes: payload.bodyBytes,
      bodyBytesTruncated: payload.bodyBytesTruncated,
      ...(payload.assertionResult ? { assertionResult: payload.assertionResult } : {}),
    }

    // Happy path: DB connected and we are not actively draining.
    if (
      (this.mode === 'live' || this.mode === 'standby') &&
      this.adapter.isConnected()
    ) {
      try {
        await this.adapter.saveCheck(item)
        this.lastLiveWriteAt = Date.now()
        return
      } catch {
        // Unexpected write failure — switch to buffering until we understand
        // why. The mongo topology handler will usually fire db:disconnected
        // shortly, but we don't rely on it.
        this.lastFailureAt = Date.now()
        this.mode = 'buffering'
      }
    }

    // Try memory buffer first.
    if (this.memBuffer.push(item)) {
      this.outageTracker.onMemoryBuffered(1)
      return
    }

    // Memory full — flush to disk.
    this.mode = 'disk-spill'
    const flushed = this.memBuffer.flush()
    const toWrite = [...flushed, item]
    try {
      await this.diskBuffer.append(toWrite)
      this.outageTracker.onDiskBuffered(toWrite.length)
    } catch (err) {
      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'buffer-pipeline',
        message: `Disk buffer write failed — ${toWrite.length} check${toWrite.length === 1 ? '' : 's'} lost: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      // If the DB is still down we remain in buffering; otherwise reconnect
      // handler will clear the flag.
      if (this.mode === 'disk-spill' && this.adapter.isConnected()) {
        this.mode = 'buffering'
      }
    }
  }

  private async handleReconnect(): Promise<void> {
    this.mode = 'replaying'

    try {
      // Drain in-memory buffer first.
      if (!this.memBuffer.isEmpty()) {
        const items = this.memBuffer.flush()
        try {
          await this.adapter.saveManyChecks(items)
        } catch {
          // Couldn't write — spill to disk so replay can pick it up.
          try {
            await this.diskBuffer.append(items)
          } catch {
            eventBus.emit('system:warning', {
              timestamp: new Date(),
              module: 'buffer-pipeline',
              message: 'Memory buffer drain failed and disk fallback also failed — checks lost',
            })
          }
          // Stay in replaying until the next reconnect cycle.
          return
        }
      }

      // Replay any disk entries.
      if (!(await this.diskBuffer.isEmpty())) {
        await replayFromDisk(this.adapter, this.diskBuffer)
      }
    } finally {
      this.mode = 'live'
      this.lastLiveWriteAt = Date.now()
    }
  }
}
