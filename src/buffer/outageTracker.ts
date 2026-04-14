import type { StorageAdapter } from '../storage/adapter.js'
import type { SystemEventTimelineEntry } from '../storage/types.js'
import { eventBus } from '../core/eventBus.js'

interface ActiveOutage {
  startedAt: Date
  timeline: SystemEventTimelineEntry[]
  reconnectAttempts: number
  memBuffered: number
  diskBuffered: number
}

/**
 * Tracks DB outage metadata and persists a SystemEventDoc to mx_system_events
 * when the connection is restored (or permanently lost).
 *
 * Call register() once during boot to attach the event bus subscribers.
 * Call onMemoryBuffered() / onDiskBuffered() from the pipeline whenever
 * a check result is buffered so the final record has accurate counts.
 */
export class OutageTracker {
  private active: ActiveOutage | null = null

  constructor(private readonly adapter: StorageAdapter) {}

  register(): void {
    eventBus.subscribe(
      'db:disconnected',
      () => {
        this.active = {
          startedAt: new Date(),
          timeline: [{ at: new Date(), event: 'disconnected' }],
          reconnectAttempts: 0,
          memBuffered: 0,
          diskBuffered: 0,
        }
      },
      'standard',
    )

    eventBus.subscribe(
      'db:reconnecting',
      ({ attempt, maxAttempts, nextRetryInSeconds }) => {
        if (!this.active) return
        this.active.reconnectAttempts = attempt
        const max = maxAttempts === 0 ? '∞' : String(maxAttempts)
        this.active.timeline.push({
          at: new Date(),
          event: 'reconnecting',
          detail: `attempt ${attempt}/${max} · next in ${nextRetryInSeconds}s`,
        })
      },
      'standard',
    )

    eventBus.subscribe(
      'db:reconnected',
      async ({ outageDurationSeconds }) => {
        if (!this.active) return
        const outage = this.active
        this.active = null
        outage.timeline.push({ at: new Date(), event: 'reconnected' })

        try {
          await this.adapter.saveSystemEvent({
            type: 'db_outage',
            startedAt: outage.startedAt,
            resolvedAt: new Date(),
            durationSeconds: outageDurationSeconds,
            reconnectAttempts: outage.reconnectAttempts,
            severity: this.calcSeverity(outageDurationSeconds),
            cause: 'topology_closed',
            bufferedToMemory: outage.memBuffered,
            bufferedToDisk: outage.diskBuffered,
            replayStatus: 'pending',
            replayedCount: 0,
            replayErrors: 0,
            timeline: outage.timeline,
          })
        } catch (err) {
          eventBus.emit('system:warning', {
            timestamp: new Date(),
            module: 'outage-tracker',
            message: `Failed to save outage record: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      },
      'standard',
    )

    eventBus.subscribe(
      'db:fatal',
      ({ totalAttempts, totalOutageDuration }) => {
        if (!this.active) return
        const outage = this.active
        this.active = null
        outage.timeline.push({ at: new Date(), event: 'fatal' })

        // DB is gone — can't persist the record; emit a warning so it's visible.
        const lost = outage.memBuffered + outage.diskBuffered
        eventBus.emit('system:warning', {
          timestamp: new Date(),
          module: 'outage-tracker',
          message:
            `DB outage unresolved after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} ` +
            `(${totalOutageDuration}s). ${lost} buffered check${lost === 1 ? '' : 's'} lost.`,
        })
      },
      'standard',
    )
  }

  /** Called by BufferPipeline when a check is buffered to memory. */
  onMemoryBuffered(count: number): void {
    if (this.active) this.active.memBuffered += count
  }

  /** Called by BufferPipeline when checks are spilled to disk. */
  onDiskBuffered(count: number): void {
    if (this.active) this.active.diskBuffered += count
  }

  private calcSeverity(durationSeconds: number): 'low' | 'medium' | 'high' | 'critical' {
    if (durationSeconds < 60) return 'low'
    if (durationSeconds < 300) return 'medium'
    if (durationSeconds < 900) return 'high'
    return 'critical'
  }
}
