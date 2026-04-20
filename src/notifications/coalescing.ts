/**
 * Burst coalescing buffer — the "not a digest" strategy.
 *
 * First alert of a burst is emitted immediately and opens a short window
 * (default 60s). Follow-up `incident_opened` alerts to the same channel
 * during the window are held and flushed together when the window closes.
 *
 * Non-opened kinds (resolves, escalations, tests) always bypass the buffer.
 * Severity at or above `bypassSeverity` also bypasses, so a real critical
 * incident never sits in a follow-up buffer.
 */

import { eventBus } from '../core/eventBus.js'
import type { ResolvedDispatch } from './types.js'

const SEVERITY_ORDER = { info: 0, success: 0, warning: 1, critical: 2 } as const

export interface CoalescingConfig {
  enabled: boolean
  windowMs: number
  minBurstCount: number
  bypassSeverity: 'info' | 'warning' | 'critical'
}

export interface BufferedAlert {
  dispatch: ResolvedDispatch
  receivedAt: number
}

export type AdmitDecision =
  /** Send this dispatch now. */
  | { action: 'immediate'; openedWindow: boolean }
  /** Dispatch was absorbed into an open window; no send yet. */
  | { action: 'buffered' }

interface OpenWindow {
  openedAt: number
  timer: ReturnType<typeof setTimeout>
  buffered: BufferedAlert[]
}

export type FlushMode = 'summary' | 'individual'

export interface FlushPayload {
  channelId: string
  endpointId?: string
  mode: FlushMode
  alerts: BufferedAlert[]
}

export class CoalescingBuffer {
  private readonly windows = new Map<string, OpenWindow>()

  constructor(
    private readonly config: CoalescingConfig,
    /** Called when a window expires and has buffered alerts to send. */
    private readonly onFlush: (payload: FlushPayload) => void,
  ) {}

  /**
   * Decide whether this dispatch should be sent immediately or absorbed into
   * a coalescing window. `admit()` is pure — it never calls the provider; the
   * caller is responsible for actually dispatching when the decision is
   * `immediate`.
   */
  admit(dispatch: ResolvedDispatch): AdmitDecision {
    if (!this.config.enabled) return { action: 'immediate', openedWindow: false }

    const { kind, severity } = dispatch.message
    if (kind !== 'incident_opened') return { action: 'immediate', openedWindow: false }

    const sevOrdinal = SEVERITY_ORDER[severity] ?? 0
    const bypassOrdinal = SEVERITY_ORDER[this.config.bypassSeverity]
    if (sevOrdinal >= bypassOrdinal) return { action: 'immediate', openedWindow: false }

    const open = this.windows.get(dispatch.channelId)
    if (!open) {
      this.openWindow(dispatch)
      return { action: 'immediate', openedWindow: true }
    }

    open.buffered.push({ dispatch, receivedAt: Date.now() })
    return { action: 'buffered' }
  }

  /** Drop all pending windows (shutdown path). */
  stop(): void {
    for (const win of this.windows.values()) clearTimeout(win.timer)
    this.windows.clear()
  }

  size(): number {
    return this.windows.size
  }

  private openWindow(first: ResolvedDispatch): void {
    const channelId = first.channelId
    const timer = setTimeout(() => this.flush(channelId), this.config.windowMs)
    this.windows.set(channelId, { openedAt: Date.now(), timer, buffered: [] })
    eventBus.emit('notification:coalescingOpened', {
      timestamp: new Date(),
      channelId,
      endpointId: first.message.endpoint?.id,
      windowMs: this.config.windowMs,
    })
  }

  private flush(channelId: string): void {
    const win = this.windows.get(channelId)
    if (!win) return
    this.windows.delete(channelId)
    clearTimeout(win.timer)
    if (win.buffered.length === 0) return

    const mode: FlushMode =
      win.buffered.length >= this.config.minBurstCount ? 'summary' : 'individual'
    const endpointId = win.buffered[0]?.dispatch.message.endpoint?.id

    try {
      this.onFlush({ channelId, endpointId, mode, alerts: win.buffered })
    } catch {
      // Swallow — the dispatcher records its own outcomes via the event bus.
    }
  }
}
