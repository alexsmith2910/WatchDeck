/**
 * Probe registry.
 *
 * Central owner of every health probe:
 *   - Registers probe functions by id + cadence (ms).
 *   - Schedules active probes (`cadenceMs > 0`) on their individual intervals.
 *   - Passive probes (`cadenceMs === 0`) still get an initial run on `start()`
 *     plus a slow background refresh (`PASSIVE_REFRESH_MS`) so the snapshot
 *     never serves a stale `standby` placeholder for an otherwise-fine
 *     subsystem. They can additionally be re-run on demand via `runOnce()`.
 *   - Caches the latest ProbeResult per subsystem so the /api/health snapshot
 *     endpoint can return quickly without triggering probes.
 *   - Keeps a 30-minute rolling history per subsystem (1 sample/probe-run) for
 *     the probe latency chart and probe-failure heatmap.
 *   - Emits `probe:completed` on every completion and `probe:degraded` /
 *     `probe:recovered` when a subsystem transitions between healthy-ish
 *     (healthy/standby/disabled) and unhealthy (degraded/down). The incident
 *     manager listens to those transitions to open/resolve internal incidents.
 *
 * All probe executions are wrapped in try/catch — a throwing probe is treated
 * as `down` with the error message surfaced. Probes are never allowed to
 * crash the registry.
 */

import { eventBus } from '../eventBus.js'
import type {
  ProbeFn,
  ProbeHistoryEntry,
  ProbeResult,
  ProbeStatus,
} from './probeTypes.js'

/** Maximum history entries kept per subsystem — 30 minutes at 1s cadence. */
const HISTORY_CAPACITY = 1800

/**
 * Background refresh cadence for passive probes (cadenceMs === 0). Slow enough
 * that we don't waste cycles re-reading static state; fast enough that the
 * snapshot reflects reality after at most one full cycle.
 */
const PASSIVE_REFRESH_MS = 30_000

/** Anything in this set counts as "healthy" for rollup purposes. */
const HEALTHY_STATES: ReadonlySet<ProbeStatus> = new Set(['healthy', 'standby', 'disabled'])

export function isHealthyStatus(status: ProbeStatus): boolean {
  return HEALTHY_STATES.has(status)
}

interface ProbeEntry {
  id: string
  fn: ProbeFn
  cadenceMs: number
  timer: ReturnType<typeof setInterval> | null
  lastResult: ProbeResult | null
  inFlight: boolean
  history: ProbeHistoryEntry[]
}

export class ProbeRegistry {
  private readonly probes = new Map<string, ProbeEntry>()
  private started = false

  /**
   * Register a probe under `id`. `cadenceMs === 0` marks it as passive —
   * only runs when `runOnce()` is called. Subsequent registrations with the
   * same id replace the previous entry (history is reset).
   */
  register(id: string, fn: ProbeFn, cadenceMs: number): void {
    const existing = this.probes.get(id)
    if (existing?.timer) clearInterval(existing.timer)
    this.probes.set(id, {
      id,
      fn,
      cadenceMs,
      timer: null,
      lastResult: null,
      inFlight: false,
      history: [],
    })
    // If the registry is already running, start this probe immediately.
    if (this.started) this.scheduleProbe(id)
  }

  /** Unregister a probe by id. Clears its timer and cached state. */
  unregister(id: string): void {
    const entry = this.probes.get(id)
    if (!entry) return
    if (entry.timer) clearInterval(entry.timer)
    this.probes.delete(id)
  }

  /** List all registered probe ids in insertion order. */
  ids(): string[] {
    return Array.from(this.probes.keys())
  }

  /** Begin all active probes' interval timers. Safe to call multiple times. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const id of this.probes.keys()) this.scheduleProbe(id)
  }

  /** Stop all timers. Does NOT clear cached results. */
  stop(): void {
    this.started = false
    for (const entry of this.probes.values()) {
      if (entry.timer) {
        clearInterval(entry.timer)
        entry.timer = null
      }
    }
  }

  /**
   * Run a single named probe now and return the fresh result.
   * Used by `GET /api/health/:subsystem`. Also updates the cache and history.
   */
  async runOnce(id: string): Promise<ProbeResult> {
    const entry = this.probes.get(id)
    if (!entry) {
      return {
        subsystemId: id,
        status: 'down',
        latencyMs: null,
        details: {},
        probedAt: Date.now(),
        error: `unknown probe: ${id}`,
      }
    }
    return this.executeProbe(entry)
  }

  /** Most recent cached result for a single probe. Null before the first run. */
  latest(id: string): ProbeResult | null {
    return this.probes.get(id)?.lastResult ?? null
  }

  /** Most recent result per probe. Missing probes are not included. */
  latestAll(): Record<string, ProbeResult | null> {
    const out: Record<string, ProbeResult | null> = {}
    for (const [id, entry] of this.probes) out[id] = entry.lastResult
    return out
  }

  /** The full in-memory history ring for one probe (oldest first). */
  historyFor(id: string): readonly ProbeHistoryEntry[] {
    return this.probes.get(id)?.history ?? []
  }

  /** Full history across all probes. */
  historyAll(): Record<string, readonly ProbeHistoryEntry[]> {
    const out: Record<string, readonly ProbeHistoryEntry[]> = {}
    for (const [id, entry] of this.probes) out[id] = entry.history
    return out
  }

  /**
   * Hydrate the in-memory history rings from a persisted snapshot. Only
   * entries within the last 30 minutes (HISTORY_CAPACITY at 1 sample/sec)
   * are kept. Probes that aren't registered yet are silently skipped — the
   * caller can register first then hydrate, or vice-versa (hydration is a
   * no-op for unknown ids).
   */
  hydrateHistory(byId: Record<string, ProbeHistoryEntry[] | undefined>): void {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [id, entries] of Object.entries(byId)) {
      if (!entries) continue
      const entry = this.probes.get(id)
      if (!entry) continue
      const fresh = entries.filter((e) => e && typeof e.ts === 'number' && e.ts >= cutoff)
      entry.history = fresh.slice(-HISTORY_CAPACITY)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleProbe(id: string): void {
    const entry = this.probes.get(id)
    if (!entry) return
    if (entry.timer) clearInterval(entry.timer)

    // Passive probes (cadenceMs === 0) still get a first run + slow refresh so
    // the snapshot never serves a placeholder `standby` for an otherwise-fine
    // subsystem. Active probes use their declared cadence.
    const refreshMs = entry.cadenceMs > 0 ? entry.cadenceMs : PASSIVE_REFRESH_MS

    // Kick off the first run soon but not at exactly t=0 to avoid a stampede
    // across all subsystems immediately at boot.
    const initialDelay = Math.min(refreshMs, 250)
    setTimeout(() => {
      if (!this.started) return
      void this.executeProbe(entry)
      entry.timer = setInterval(() => { void this.executeProbe(entry) }, refreshMs)
    }, initialDelay)
  }

  private async executeProbe(entry: ProbeEntry): Promise<ProbeResult> {
    // Skip if a previous run is still in flight — we must not stack calls,
    // especially for probes that exercise real work (e.g. the checker loop).
    if (entry.inFlight && entry.lastResult) return entry.lastResult

    entry.inFlight = true
    const previous = entry.lastResult
    let result: ProbeResult
    try {
      result = await entry.fn()
    } catch (err) {
      result = {
        subsystemId: entry.id,
        status: 'down',
        latencyMs: null,
        details: {},
        probedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      entry.inFlight = false
    }

    entry.lastResult = result
    this.pushHistory(entry, result)
    this.emitTransition(previous, result)

    return result
  }

  private pushHistory(entry: ProbeEntry, result: ProbeResult): void {
    entry.history.push({
      ts: result.probedAt,
      status: result.status,
      latencyMs: result.latencyMs,
    })
    if (entry.history.length > HISTORY_CAPACITY) {
      entry.history.splice(0, entry.history.length - HISTORY_CAPACITY)
    }
  }

  private emitTransition(previous: ProbeResult | null, current: ProbeResult): void {
    const now = new Date()
    // Always emit completion so the UI can refresh.
    eventBus.emit('probe:completed', { timestamp: now, result: current })

    const prevHealthy = previous ? isHealthyStatus(previous.status) : true
    const currHealthy = isHealthyStatus(current.status)

    if (prevHealthy && !currHealthy) {
      eventBus.emit('probe:degraded', { timestamp: now, result: current })
    } else if (!prevHealthy && currHealthy) {
      eventBus.emit('probe:recovered', { timestamp: now, result: current })
    }
  }
}

/** Module-level singleton — imported wherever probes are registered or read. */
export const probeRegistry = new ProbeRegistry()
