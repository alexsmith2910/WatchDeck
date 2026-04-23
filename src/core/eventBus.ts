import { EventEmitter } from 'node:events'
import type { EventMap } from './eventTypes.js'
import type { WatchDeckConfig } from '../config/types.js'

// ---------------------------------------------------------------------------
// History buffer
// ---------------------------------------------------------------------------

/**
 * A single record stored in the event history buffer.
 * The discriminated-union type ensures payload is always paired with its event.
 */
export type HistoryRecord = {
  [K in keyof EventMap]: { event: K; payload: EventMap[K]; timestamp: Date }
}[keyof EventMap]

/**
 * Fixed-capacity circular buffer — oldest entry is overwritten when full.
 * `toArray()` always returns entries in chronological (oldest-first) order.
 */
class CircularBuffer {
  private buffer: HistoryRecord[]
  private head = 0
  private _size = 0

  constructor(private capacity: number) {
    this.buffer = new Array<HistoryRecord>(capacity)
  }

  push(record: HistoryRecord): void {
    this.buffer[this.head] = record
    this.head = (this.head + 1) % this.capacity
    if (this._size < this.capacity) this._size++
  }

  toArray(): HistoryRecord[] {
    if (this._size < this.capacity) {
      return this.buffer.slice(0, this._size)
    }
    // head now points at the oldest entry
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)]
  }

  /** Resize — retains the most recent min(size, newCapacity) entries. */
  resize(newCapacity: number): void {
    const existing = this.toArray()
    this.capacity = newCapacity
    this.buffer = new Array<HistoryRecord>(newCapacity)
    this.head = 0
    this._size = 0
    for (const record of existing.slice(-newCapacity)) {
      this.push(record)
    }
  }

  /** Drop every entry; keeps the current capacity. */
  clear(): void {
    this.buffer = new Array<HistoryRecord>(this.capacity)
    this.head = 0
    this._size = 0
  }
}

// ---------------------------------------------------------------------------
// Typed event bus
// ---------------------------------------------------------------------------

export type SubscriberPriority = 'critical' | 'standard' | 'low'

/**
 * Typed wrapper around Node's EventEmitter.
 *
 * Key additions over a plain EventEmitter:
 *  - `subscribe()` — wraps listeners with try/catch; errors are routed
 *    to system events (or console) depending on the priority level.
 *  - Circular history buffer — every emitted event is recorded;
 *    `getHistory()` returns them in chronological order for SSE replay.
 *  - `initEventBus(config)` — call once after config is loaded to set
 *    maxListeners and resize the history buffer from config values.
 */
class TypedEventBus extends EventEmitter {
  private readonly history = new CircularBuffer(100)

  // ── Core emit/on/once/off (used by internal adapters) ──────────────────

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    this.history.push({ event, payload, timestamp: new Date() } as HistoryRecord)
    return super.emit(event as string, payload)
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.on(event as string, listener)
  }

  once<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.once(event as string, listener)
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.off(event as string, listener)
  }

  // ── Priority subscribe ─────────────────────────────────────────────────

  /**
   * Subscribe to an event with an explicit priority level.
   *
   * - `critical`  — errors in the listener emit a `system:critical` event.
   * - `standard`  — errors emit a `system:warning` event.
   * - `low`       — errors are logged to stderr only; never propagate.
   *
   * Returns an unsubscribe function for clean teardown.
   */
  subscribe<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void | Promise<void>,
    priority: SubscriberPriority = 'standard',
  ): () => void {
    const wrapped = (payload: EventMap[K]): void => {
      const handleError = (err: unknown): void => {
        const error = err instanceof Error ? err : new Error(String(err))
        if (priority === 'critical') {
          this.emit('system:critical', {
            timestamp: new Date(),
            module: String(event),
            error,
            suggestedFix: `Check the critical subscriber for event "${String(event)}"`,
          })
        } else if (priority === 'standard') {
          this.emit('system:warning', {
            timestamp: new Date(),
            module: String(event),
            message: error.message,
          })
        } else {
          console.error(
            `[event-bus] low-priority subscriber threw on "${String(event)}":`,
            error,
          )
        }
      }

      let result: void | Promise<void>
      try {
        result = listener(payload)
      } catch (err) {
        handleError(err)
        return
      }

      if (result instanceof Promise) {
        result.catch(handleError)
      }
    }

    this.on(event, wrapped)
    return () => this.off(event, wrapped)
  }

  // ── History ────────────────────────────────────────────────────────────

  /** Returns all buffered events in chronological order (oldest first). */
  getHistory(): HistoryRecord[] {
    return this.history.toArray()
  }

  /** Resize the history buffer (called from initEventBus). */
  resizeHistory(capacity: number): void {
    this.history.resize(capacity)
  }

  /** Empty the history buffer. Used by POST /admin/reset. */
  clearHistory(): void {
    this.history.clear()
  }

  /** Number of records currently held in the in-memory event history buffer. */
  historySize(): number {
    return this.history.toArray().length
  }

  /** Sum of listener counts across every registered event name. */
  totalListeners(): number {
    let total = 0
    for (const name of this.eventNames()) {
      total += this.listenerCount(name as string)
    }
    return total
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Singleton event bus. Import this wherever events need to be emitted or subscribed to. */
export const eventBus = new TypedEventBus()

// Default listener cap — raised to avoid spurious Node warnings during early boot.
// initEventBus() will set the true value from config.
eventBus.setMaxListeners(50)

// ---------------------------------------------------------------------------
// Boot initialisation
// ---------------------------------------------------------------------------

/**
 * Call once after config is loaded (in start.ts) to apply config-driven values:
 *  - Sets maxListeners from config.rateLimits.maxEventListeners
 *  - Resizes the history buffer from config.eventHistorySize
 */
export function initEventBus(config: WatchDeckConfig): void {
  eventBus.setMaxListeners(config.rateLimits.maxEventListeners)
  eventBus.resizeHistory(config.eventHistorySize)
}
