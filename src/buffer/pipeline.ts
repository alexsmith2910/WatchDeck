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
 * Boot sequence (start.ts):
 *   1. Call register() to attach event bus subscribers.
 *   2. Separately check diskBuffer.isEmpty() and call replayFromDisk() for
 *      any data buffered during a previous process run.
 *
 * Runtime:
 *   - In live mode, each check:complete event writes directly to the DB.
 *   - On db:disconnected the pipeline switches to buffer mode.
 *   - On db:reconnected the pipeline drains memory then replays disk.
 */
export class BufferPipeline {
  private mode: 'live' | 'buffering' = 'live'

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly memBuffer: MemoryBuffer<CheckWritePayload>,
    private readonly diskBuffer: DiskBuffer,
    private readonly outageTracker: OutageTracker,
  ) {}

  /** Current write mode — read by the system metrics collector. */
  getMode(): 'live' | 'buffering' {
    return this.mode
  }

  register(): void {
    // Switch to buffering as soon as the topology closes.
    eventBus.subscribe('db:disconnected', () => { this.mode = 'buffering' }, 'critical')

    // Every check result comes through here.
    eventBus.subscribe('check:complete', (payload) => { void this.handleCheck(payload) }, 'critical')

    // When the DB comes back, drain buffers.
    eventBus.subscribe('db:reconnected', () => { void this.handleReconnect() }, 'critical')
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
    }

    // Happy path: live mode and DB is up.
    if (this.mode === 'live' && this.adapter.isConnected()) {
      try {
        await this.adapter.saveCheck(item)
        return
      } catch {
        // Unexpected write failure — switch to buffering.
        this.mode = 'buffering'
      }
    }

    // Try memory buffer first.
    if (this.memBuffer.push(item)) {
      this.outageTracker.onMemoryBuffered(1)
      return
    }

    // Memory full — flush to disk.
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
    }
  }

  private async handleReconnect(): Promise<void> {
    this.mode = 'live'

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
        return
      }
    }

    // Replay any disk entries.
    if (!(await this.diskBuffer.isEmpty())) {
      await replayFromDisk(this.adapter, this.diskBuffer)
    }
  }
}
