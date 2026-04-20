/**
 * Health-state persistence orchestrator.
 *
 * Saves the in-memory parts of the System Health page (probe history ring +
 * 24h heatmap + internal incidents) to MongoDB so a process restart no longer
 * resets the page to zeros. Three pieces of state are persisted:
 *
 *   1. Probe history (last 30 min, ring buffer per subsystem) — single doc
 *      `mx_health_state` (_id: "snapshot").
 *   2. 24-hour activity heatmap buckets (per subsystem) — same doc.
 *   3. Internal incidents (one doc per incident in `mx_internal_incidents`,
 *      with TTL on resolved entries).
 *
 * Lifecycle:
 *   - `loadAndHydrate(adapter)` — call once at boot, AFTER probes are
 *     registered but BEFORE `probeRegistry.start()` so hydrated history is in
 *     place when the chart first renders.
 *   - `start()` — kicks off a periodic flush every FLUSH_INTERVAL_MS. Idempotent.
 *   - `flush()` — manual save (also called by start's interval and by shutdown).
 *   - `stop()` — clears the interval. Call before final `flush()` on shutdown.
 *
 * All adapter writes are wrapped in try/catch — persistence is best-effort.
 * If MongoDB is down, the in-memory state is still authoritative and the next
 * successful flush will overwrite the stale snapshot.
 */

import { internalIncidents } from '../../alerts/internalIncidents.js'
import { heatmapAggregator } from './heatmapAggregator.js'
import { probeRegistry } from './probeRegistry.js'
import type { StorageAdapter } from '../../storage/adapter.js'
import type { HealthHistoryEntryDoc } from '../../storage/types.js'

const FLUSH_INTERVAL_MS = 30_000

class HealthPersistence {
  private timer: ReturnType<typeof setInterval> | null = null
  private adapter: StorageAdapter | null = null
  private flushing = false

  /**
   * Load the persisted snapshot and replay it into the in-memory state holders.
   * Safe to call before any probe has run.
   */
  async loadAndHydrate(adapter: StorageAdapter): Promise<void> {
    this.adapter = adapter
    internalIncidents.setAdapter(adapter)

    try {
      const state = await adapter.loadHealthState()
      if (state) {
        if (state.probeHistory) probeRegistry.hydrateHistory(state.probeHistory)
        if (state.heatmap) heatmapAggregator.hydrate(state.heatmap)
      }
    } catch (err) {
      console.warn(
        '[health-persistence] failed to load snapshot:',
        err instanceof Error ? err.message : err,
      )
    }

    try {
      const docs = await adapter.listInternalIncidents()
      if (docs.length > 0) internalIncidents.hydrate(docs)
    } catch (err) {
      console.warn(
        '[health-persistence] failed to load incidents:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** Begin periodic flushing. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stop periodic flushing. Does NOT call flush() — caller controls that. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Save the current state to the adapter. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushing || !this.adapter) return
    this.flushing = true
    try {
      const probeHistory: Record<string, HealthHistoryEntryDoc[]> = {}
      for (const [id, history] of Object.entries(probeRegistry.historyAll())) {
        probeHistory[id] = history.map((e) => ({
          ts: e.ts,
          status: e.status,
          latencyMs: e.latencyMs,
        }))
      }

      await this.adapter.saveHealthState({
        savedAt: new Date(),
        probeHistory,
        heatmap: heatmapAggregator.serialize(),
      })
    } catch (err) {
      console.warn(
        '[health-persistence] flush failed:',
        err instanceof Error ? err.message : err,
      )
    } finally {
      this.flushing = false
    }
  }
}

export const healthPersistence = new HealthPersistence()
