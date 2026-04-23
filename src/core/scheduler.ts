/**
 * Check engine scheduler.
 *
 * Manages a min-heap priority queue of endpoints sorted by their next-due
 * timestamp. A 1-second tick loop extracts due entries, enforces concurrency
 * and per-host spacing limits, dispatches checks, and reinserts each entry
 * with its next due time.
 *
 * Complexity: O(log n) insert, extract, and update.
 *
 * Lifecycle events from the event bus keep the heap in sync with API changes:
 *   - endpoint:created → insert into heap immediately
 *   - endpoint:updated → update heap entry in-place
 *   - endpoint:deleted / archived → remove from heap
 */

import { eventBus } from './eventBus.js'
import { runCheck } from '../checks/checkRunner.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { EndpointDoc } from '../storage/types.js'
import type { WatchDeckConfig } from '../config/types.js'

// ---------------------------------------------------------------------------
// Min-heap
// ---------------------------------------------------------------------------

interface HeapEntry {
  endpointId: string
  /** Unix ms — the time at which this endpoint is next due for a check. */
  nextDue: number
  endpoint: EndpointDoc
}

class MinHeap {
  private items: HeapEntry[] = []

  get size(): number {
    return this.items.length
  }

  peek(): HeapEntry | undefined {
    return this.items[0]
  }

  insert(entry: HeapEntry): void {
    this.items.push(entry)
    this.bubbleUp(this.items.length - 1)
  }

  extractMin(): HeapEntry | undefined {
    if (this.items.length === 0) return undefined
    const min = this.items[0]!
    const last = this.items.pop()!
    if (this.items.length > 0) {
      this.items[0] = last
      this.sinkDown(0)
    }
    return min
  }

  /**
   * Find an entry by endpointId, apply the updater, and re-heapify.
   * Returns true if the entry was found.
   */
  update(endpointId: string, updater: (entry: HeapEntry) => HeapEntry): boolean {
    const idx = this.items.findIndex((e) => e.endpointId === endpointId)
    if (idx === -1) return false
    this.items[idx] = updater(this.items[idx]!)
    const settled = this.bubbleUp(idx)
    this.sinkDown(settled)
    return true
  }

  /**
   * Remove the entry for the given endpointId.
   * Returns true if the entry was found and removed.
   */
  remove(endpointId: string): boolean {
    const idx = this.items.findIndex((e) => e.endpointId === endpointId)
    if (idx === -1) return false
    const last = this.items.pop()!
    if (idx < this.items.length) {
      this.items[idx] = last
      const settled = this.bubbleUp(idx)
      this.sinkDown(settled)
    }
    return true
  }

  /** Drop every entry without re-heapifying. */
  clear(): void {
    this.items = []
  }

  // ── Private heap operations ─────────────────────────────────────────────

  /** Returns the final index of the element after it has risen. */
  private bubbleUp(idx: number): number {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2)
      if (this.items[parent]!.nextDue <= this.items[idx]!.nextDue) break
      const tmp = this.items[parent]!
      this.items[parent] = this.items[idx]!
      this.items[idx] = tmp
      idx = parent
    }
    return idx
  }

  private sinkDown(idx: number): void {
    const n = this.items.length
    while (true) {
      let smallest = idx
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      if (left < n && this.items[left]!.nextDue < this.items[smallest]!.nextDue) smallest = left
      if (right < n && this.items[right]!.nextDue < this.items[smallest]!.nextDue) smallest = right
      if (smallest === idx) break
      const tmp = this.items[smallest]!
      this.items[smallest] = this.items[idx]!
      this.items[idx] = tmp
      idx = smallest
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Maximum drift samples kept for the scheduler health probe (~1 minute). */
const DRIFT_SAMPLE_CAPACITY = 60

export interface TickDriftSample {
  ts: number
  driftMs: number
}

export class CheckScheduler {
  private readonly heap = new MinHeap()
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private activeChecks = 0
  /** ms timestamp of the last check dispatched per host (hostname or IP). */
  private readonly lastHostCheckTime = new Map<string, number>()
  /** Per-endpoint consecutive failure count — seeded from DB on boot. */
  private readonly consecutiveFailures = new Map<string, number>()

  /** Expected ms timestamp of the next tick — used to measure drift. */
  private expectedNextTick: number | null = null
  /** Rolling ring of recent tick drifts (ms). Oldest dropped first. */
  private driftRing: TickDriftSample[] = []
  /**
   * Peak `activeChecks` seen since the start of the current second, plus the
   * fully-settled peak from the PREVIOUS second. Used to surface sub-second
   * concurrency activity that a straight instantaneous sample would miss.
   */
  private runningPeakCurrent = 0
  private runningPeakFrozen = 0
  private peakWindowSec = Math.floor(Date.now() / 1000)

  /**
   * Handles returned by `eventBus.subscribe()` — tracked so that `reset()`
   * can detach before a fresh `init()` re-subscribes, avoiding duplicate
   * listener fan-out on hard reset.
   */
  private unsubscribes: Array<() => void> = []

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly config: WatchDeckConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load all active/paused endpoints from the DB, seed the heap with a random
   * jitter to avoid thundering-herd on startup, and begin the tick loop.
   */
  async init(): Promise<void> {
    const endpoints = await this.adapter.listEnabledEndpoints()
    const now = Date.now()

    for (const ep of endpoints) {
      if (ep.status === 'archived') continue
      // Seed consecutive failure counts from persisted DB state.
      this.consecutiveFailures.set(ep._id.toString(), ep.consecutiveFailures)
      // Random jitter spreads initial checks across the first interval window.
      const jitter = Math.floor(Math.random() * ep.checkInterval * 1000)
      this.insertSafe({ endpointId: ep._id.toString(), nextDue: now + jitter, endpoint: ep })
    }

    this.subscribeToEndpointEvents()
    this.subscribeToCheckComplete()

    this.expectedNextTick = Date.now() + 1000
    this.tickInterval = setInterval(() => { void this.tickWithDrift() }, 1000)
  }

  /** Stop the tick loop. In-flight checks complete normally. */
  stop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
  }

  /**
   * Hard-reset hook — called by POST /admin/reset after the DB is wiped.
   * Stops the tick loop, detaches every event subscription, clears all
   * in-memory state (heap, consecutive-failure map, drift ring), then runs
   * `init()` again so subscriptions are re-established and the (now empty)
   * endpoint list is reloaded.
   */
  async reset(): Promise<void> {
    this.stop()
    this.heap.clear()
    this.consecutiveFailures.clear()
    this.lastHostCheckTime.clear()
    this.driftRing = []
    this.expectedNextTick = null
    this.activeChecks = 0
    this.runningPeakCurrent = 0
    this.runningPeakFrozen = 0
    this.peakWindowSec = Math.floor(Date.now() / 1000)
    await this.init()
  }

  /**
   * Push an endpoint to the front of the queue (nextDue = now).
   * Used by the POST /endpoints/:id/recheck API route.
   * Returns false if the endpoint is not currently in the scheduler.
   */
  scheduleImmediate(endpointId: string): boolean {
    return this.heap.update(endpointId, (entry) => ({ ...entry, nextDue: Date.now() }))
  }

  get queueSize(): number {
    return this.heap.size
  }

  get runningChecks(): number {
    return this.activeChecks
  }

  /** Ring of the most recent tick-drift samples, oldest first. */
  driftSamples(): readonly TickDriftSample[] {
    return this.driftRing
  }

  /**
   * Peak concurrent in-flight checks seen during the previous full second.
   * This is the value the health page should display — a single instantaneous
   * sample of `runningChecks` almost always reads 0 because checks typically
   * complete in <100ms, faster than the sample rate.
   */
  runningChecksPeakLastSecond(): number {
    // If the frozen peak is stale (no peak was ever frozen this window),
    // fall back to the current window's running peak.
    return Math.max(this.runningPeakFrozen, this.runningPeakCurrent)
  }

  /** Milliseconds until the nearest heap entry is due, or null when the queue is empty. */
  nextDueInMs(): number | null {
    const top = this.heap.peek()
    if (!top) return null
    return Math.max(0, top.nextDue - Date.now())
  }

  // ---------------------------------------------------------------------------
  // Event bus subscriptions
  // ---------------------------------------------------------------------------

  private subscribeToEndpointEvents(): void {
    this.unsubscribes.push(
      eventBus.subscribe(
        'endpoint:created',
        ({ endpoint }) => {
          if (endpoint.status === 'archived' || !endpoint.enabled) return
          const id = endpoint._id.toString()
          this.consecutiveFailures.set(id, endpoint.consecutiveFailures)
          this.insertSafe({ endpointId: id, nextDue: Date.now(), endpoint })
        },
        'critical',
      ),
    )

    this.unsubscribes.push(
      eventBus.subscribe(
        'endpoint:updated',
        ({ endpointId, changes }) => {
          if (changes.status === 'archived') {
            this.heap.remove(endpointId)
            return
          }
          this.heap.update(endpointId, (entry) => ({
            ...entry,
            endpoint: { ...entry.endpoint, ...changes } as EndpointDoc,
          }))
        },
        'critical',
      ),
    )

    this.unsubscribes.push(
      eventBus.subscribe(
        'endpoint:deleted',
        ({ endpointId }) => {
          this.heap.remove(endpointId)
          this.consecutiveFailures.delete(endpointId)
        },
        'critical',
      ),
    )
  }

  private subscribeToCheckComplete(): void {
    this.unsubscribes.push(
      eventBus.subscribe(
      'check:complete',
      ({ endpointId, status, timestamp, responseTime, statusCode, errorMessage, sslIssuer, bodyBytes, bodyBytesTruncated }) => {
        // Update in-memory consecutive failures.
        const prev = this.consecutiveFailures.get(endpointId) ?? 0
        const failures = status === 'healthy' ? 0 : prev + 1
        this.consecutiveFailures.set(endpointId, failures)

        // Reflect latest state in the heap entry.
        this.heap.update(endpointId, (entry) => ({
          ...entry,
          endpoint: {
            ...entry.endpoint,
            lastStatus: status,
            lastCheckAt: timestamp,
            lastResponseTime: responseTime,
            lastStatusCode: statusCode,
            lastErrorMessage: errorMessage,
            consecutiveFailures: failures,
          },
        }))

        // Persist state to DB (fire-and-forget — failures here are non-critical).
        this.adapter.updateEndpointAfterCheck(
          endpointId, status, timestamp, failures, responseTime, statusCode, errorMessage, sslIssuer,
        ).catch(
          (err: unknown) => {
            eventBus.emit('system:warning', {
              timestamp: new Date(),
              module: 'scheduler',
              message: `updateEndpointAfterCheck failed for ${endpointId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
          },
        )
      },
      'standard',
      ),
    )
  }

  // ---------------------------------------------------------------------------
  // Tick loop
  // ---------------------------------------------------------------------------

  /**
   * Outer tick wrapper: records the setInterval drift (difference between
   * when the tick *should* have fired and when it actually did) into the
   * rolling sample ring, and rolls the runningChecks high-water mark at the
   * top of each wall-clock second. Then delegates to `tick()` for the actual
   * scheduler work.
   */
  private async tickWithDrift(): Promise<void> {
    const now = Date.now()
    if (this.expectedNextTick !== null) {
      const drift = now - this.expectedNextTick
      this.driftRing.push({ ts: now, driftMs: drift })
      if (this.driftRing.length > DRIFT_SAMPLE_CAPACITY) {
        this.driftRing.splice(0, this.driftRing.length - DRIFT_SAMPLE_CAPACITY)
      }
    }
    this.expectedNextTick = now + 1000

    // Roll the concurrency peak at second boundaries.
    this.rollRunningPeak(now)

    await this.tick()
  }

  /** If a second has passed since the last roll, freeze and reset the peak. */
  private rollRunningPeak(now: number): void {
    const sec = Math.floor(now / 1000)
    if (sec !== this.peakWindowSec) {
      this.runningPeakFrozen = this.runningPeakCurrent
      this.runningPeakCurrent = this.activeChecks
      this.peakWindowSec = sec
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    const maxConcurrent = this.config.rateLimits.maxConcurrentChecks
    const perHostGapMs = this.config.rateLimits.perHostMinGap * 1000

    while (true) {
      // Concurrency gate — stop processing this tick if we're at capacity.
      if (this.activeChecks >= maxConcurrent) break

      const top = this.heap.peek()
      if (top === undefined || top.nextDue > now) break

      this.heap.extractMin()
      const { endpoint, endpointId } = top

      // Archived endpoints are never re-inserted.
      if (endpoint.status === 'archived') continue

      // Disabled endpoints are silently skipped and re-inserted.
      if (!endpoint.enabled) {
        this.heap.insert({ endpointId, nextDue: now + endpoint.checkInterval * 1000, endpoint })
        continue
      }

      // Paused endpoints: advance the clock but don't run the check.
      if (endpoint.status === 'paused') {
        this.heap.insert({ endpointId, nextDue: now + endpoint.checkInterval * 1000, endpoint })
        continue
      }

      // Per-host spacing: defer if we checked this host too recently.
      const host = getHost(endpoint)
      const lastTime = this.lastHostCheckTime.get(host) ?? 0
      const nextAllowed = lastTime + perHostGapMs
      if (now < nextAllowed) {
        this.heap.insert({ endpointId, nextDue: nextAllowed, endpoint })
        continue
      }

      // Dispatch the check.
      this.activeChecks++
      if (this.activeChecks > this.runningPeakCurrent) this.runningPeakCurrent = this.activeChecks
      this.lastHostCheckTime.set(host, now)

      void runCheck(endpoint, {
        captureSsl: this.config.modules.sslChecks,
        captureBodySize: this.config.captureBodySize,
        maxBodyBytesToRead: this.config.maxBodyBytesToRead,
      }).finally(() => {
        this.activeChecks--
      })

      // Reinsert with next scheduled time.
      this.heap.insert({ endpointId, nextDue: now + endpoint.checkInterval * 1000, endpoint })
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Insert only if the check type is enabled by config.
   * Port checks require modules.portChecks = true.
   */
  private insertSafe(entry: HeapEntry): void {
    if (entry.endpoint.type === 'port' && !this.config.modules.portChecks) return
    this.heap.insert(entry)
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function getHost(endpoint: EndpointDoc): string {
  if (endpoint.type === 'http' && endpoint.url) {
    try {
      return new URL(endpoint.url).hostname
    } catch {
      return endpoint.url
    }
  }
  return endpoint.host ?? 'unknown'
}
