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

export class CheckScheduler {
  private readonly heap = new MinHeap()
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private activeChecks = 0
  /** ms timestamp of the last check dispatched per host (hostname or IP). */
  private readonly lastHostCheckTime = new Map<string, number>()
  /** Per-endpoint consecutive failure count — seeded from DB on boot. */
  private readonly consecutiveFailures = new Map<string, number>()

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

    this.tickInterval = setInterval(() => { void this.tick() }, 1000)
  }

  /** Stop the tick loop. In-flight checks complete normally. */
  stop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
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

  // ---------------------------------------------------------------------------
  // Event bus subscriptions
  // ---------------------------------------------------------------------------

  private subscribeToEndpointEvents(): void {
    eventBus.subscribe(
      'endpoint:created',
      ({ endpoint }) => {
        if (endpoint.status === 'archived' || !endpoint.enabled) return
        const id = endpoint._id.toString()
        this.consecutiveFailures.set(id, endpoint.consecutiveFailures)
        this.insertSafe({ endpointId: id, nextDue: Date.now(), endpoint })
      },
      'critical',
    )

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
    )

    eventBus.subscribe(
      'endpoint:deleted',
      ({ endpointId }) => {
        this.heap.remove(endpointId)
        this.consecutiveFailures.delete(endpointId)
      },
      'critical',
    )
  }

  private subscribeToCheckComplete(): void {
    eventBus.subscribe(
      'check:complete',
      ({ endpointId, status, timestamp, responseTime, statusCode, errorMessage }) => {
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
          endpointId, status, timestamp, failures, responseTime, statusCode, errorMessage,
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
    )
  }

  // ---------------------------------------------------------------------------
  // Tick loop
  // ---------------------------------------------------------------------------

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
      this.lastHostCheckTime.set(host, now)

      void runCheck(endpoint, { captureSsl: this.config.modules.sslChecks }).finally(() => {
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
