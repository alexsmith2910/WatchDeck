/**
 * 24-hour activity heatmap aggregator.
 *
 * The probe registry's in-memory ring buffer only holds 30 minutes of probe
 * results — far too short for the GitHub-commits-style 24h activity row
 * shown on the System Health page. This aggregator keeps a much smaller
 * data structure (24 hourly buckets × 10 subsystems × 3 counters = 720
 * numbers) populated by listening to real activity events on the event bus.
 *
 * Each bucket records:
 *   - `count`     — real activity events that touched the subsystem (user /
 *                   system work, NOT probe completions — probes are self-checks
 *                   and would make every row look identical)
 *   - `degraded`  — count of `degraded` probe results in that hour (status overlay)
 *   - `down`      — count of `down` probe results in that hour (status overlay)
 *
 * The frontend then colors each cell by worst-status precedence:
 *   `down > 0`     → red
 *   `degraded > 0` → yellow
 *   `count > 0`    → green at intensity proportional to row's max count
 *   else           → idle (faint background)
 *
 * Buckets are aligned to UTC hour boundaries. On every read or write the
 * aggregator advances its window so older buckets fall off the left edge.
 */

import { eventBus } from '../eventBus.js'
import type { EventMap } from '../eventTypes.js'
import { SUBSYSTEM_METADATA, type SubsystemId } from './subsystems.js'
import type { ProbeStatus } from './probeTypes.js'

const BUCKETS = 24
const BUCKET_MS = 3_600_000

export interface HeatmapCell {
  count: number
  degraded: number
  down: number
}

interface RowData {
  /** Epoch ms of the leftmost bucket (UTC hour-aligned). */
  startMs: number
  buckets: HeatmapCell[]
}

function emptyBuckets(): HeatmapCell[] {
  return Array.from({ length: BUCKETS }, () => ({ count: 0, degraded: 0, down: 0 }))
}

function alignedStart(now: number): number {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS - (BUCKETS - 1) * BUCKET_MS
}

class HeatmapAggregator {
  private readonly rows = new Map<string, RowData>()

  private ensureRow(id: string): RowData {
    const start = alignedStart(Date.now())
    let row = this.rows.get(id)
    if (!row) {
      row = { startMs: start, buckets: emptyBuckets() }
      this.rows.set(id, row)
      return row
    }
    this.advance(row, start)
    return row
  }

  private advance(row: RowData, newStart: number): void {
    if (newStart === row.startMs) return
    const shift = Math.round((newStart - row.startMs) / BUCKET_MS)
    if (shift <= 0) return
    if (shift >= BUCKETS) {
      row.buckets = emptyBuckets()
    } else {
      row.buckets.splice(0, shift)
      for (let i = 0; i < shift; i++) row.buckets.push({ count: 0, degraded: 0, down: 0 })
    }
    row.startMs = newStart
  }

  /**
   * Bump the activity counter for a subsystem. Called once per real work
   * event that touches this subsystem (see EVENT_TO_SUBSYSTEMS below).
   */
  recordActivity(subsystemId: string, ts: number = Date.now()): void {
    const cell = this.cellAt(subsystemId, ts)
    if (cell) cell.count += 1
  }

  /**
   * Record a probe status observation. Only degraded/down observations are
   * counted — healthy probes don't need an overlay, and counting them would
   * flood the activity column with synthetic self-checks.
   */
  recordStatus(subsystemId: string, status: ProbeStatus, ts: number = Date.now()): void {
    if (status !== 'degraded' && status !== 'down') return
    const cell = this.cellAt(subsystemId, ts)
    if (!cell) return
    if (status === 'degraded') cell.degraded += 1
    else cell.down += 1
  }

  private cellAt(subsystemId: string, ts: number): HeatmapCell | null {
    const row = this.ensureRow(subsystemId)
    const idx = Math.floor((ts - row.startMs) / BUCKET_MS)
    if (idx < 0 || idx >= BUCKETS) return null
    return row.buckets[idx]!
  }

  snapshot(): {
    rows: Array<{ id: string; title: string; values: HeatmapCell[] }>
    labels: string[]
    bucketMinutes: number
  } {
    const start = alignedStart(Date.now())
    const labels: string[] = []
    for (let i = 0; i < BUCKETS; i++) labels.push(new Date(start + i * BUCKET_MS).toISOString())
    const rows: Array<{ id: string; title: string; values: HeatmapCell[] }> = []
    for (const meta of SUBSYSTEM_METADATA) {
      const row = this.ensureRow(meta.id)
      rows.push({
        id: meta.id,
        title: meta.title,
        values: row.buckets.map((c) => ({ ...c })),
      })
    }
    return { rows, labels, bucketMinutes: 60 }
  }

  /**
   * Serialize the current 24h × 1h state to a plain JSON shape suitable for
   * persistence. Mirror of `hydrate()`.
   */
  serialize(): Record<string, { startMs: number; buckets: HeatmapCell[] }> {
    const out: Record<string, { startMs: number; buckets: HeatmapCell[] }> = {}
    for (const meta of SUBSYSTEM_METADATA) {
      const row = this.ensureRow(meta.id)
      out[meta.id] = { startMs: row.startMs, buckets: row.buckets.map((c) => ({ ...c })) }
    }
    return out
  }

  /**
   * Restore previously-serialized buckets. Misaligned/old data is automatically
   * shifted forward by `advance()`; rows missing from the snapshot just stay
   * empty until the next probe completion populates them.
   */
  hydrate(byId: Record<string, { startMs: number; buckets: HeatmapCell[] } | undefined>): void {
    const currentStart = alignedStart(Date.now())
    for (const [id, row] of Object.entries(byId)) {
      if (!row || !Array.isArray(row.buckets) || row.buckets.length !== BUCKETS) continue
      const restored: RowData = {
        startMs: row.startMs,
        buckets: row.buckets.map((c) => ({
          count: Math.max(0, Number(c?.count) || 0),
          degraded: Math.max(0, Number(c?.degraded) || 0),
          down: Math.max(0, Number(c?.down) || 0),
        })),
      }
      this.advance(restored, currentStart)
      this.rows.set(id, restored)
    }
  }

  /** Test hook: clear all accumulated state. */
  reset(): void {
    this.rows.clear()
  }
}

export const heatmapAggregator = new HeatmapAggregator()

// ---------------------------------------------------------------------------
// Activity wiring
//
// Each event bumps the activity counter for every subsystem it actually
// touches. The goal is a heatmap row that reflects real work flowing through
// the subsystem — a busy database row when checks are pouring in, a quiet
// aggregator row between its hourly/daily runs, etc.
//
// `eventbus` and `sse` see every event (the bus routes them all, and the SSE
// broker broadcasts them all in V1) so they appear in every entry below.
// ---------------------------------------------------------------------------

const EVENT_TO_SUBSYSTEMS: { [K in keyof EventMap]?: readonly SubsystemId[] } = {
  // Write path — a completed check flows through the entire core pipeline.
  'check:complete':      ['scheduler', 'checkers', 'buffer', 'db', 'eventbus', 'sse'],

  // Endpoint CRUD — user writes to the DB and the change fans out.
  'endpoint:created':    ['db', 'eventbus', 'sse'],
  'endpoint:updated':    ['db', 'eventbus', 'sse'],
  'endpoint:deleted':    ['db', 'eventbus', 'sse'],

  // Incident lifecycle — incident tracker writes to DB; opens page
  // notifications.
  'incident:opened':     ['incidents', 'db', 'eventbus', 'sse', 'notifications'],
  'incident:resolved':   ['incidents', 'db', 'eventbus', 'sse'],

  // Aggregation — aggregator reads/writes DB in bulk.
  'aggregation:run':     ['aggregator', 'db', 'eventbus', 'sse'],

  // Maintenance windows — persisted to DB, propagated to UI.
  'maintenance:started': ['db', 'eventbus', 'sse'],
  'maintenance:ended':   ['db', 'eventbus', 'sse'],

  // Replay — buffer draining back to DB after an outage.
  'replay:progress':     ['buffer', 'db', 'eventbus', 'sse'],

  // DB lifecycle — the DB row sees these; SSE broadcasts to clients.
  'db:connected':        ['db', 'eventbus', 'sse'],
  'db:disconnected':     ['db', 'eventbus', 'sse'],
  'db:reconnected':      ['db', 'eventbus', 'sse'],

  // Notifications — dispatcher writes a log row, SSE fans out to the UI.
  'notification:dispatched': ['notifications', 'eventbus', 'sse'],
  'notification:failed':     ['notifications', 'eventbus', 'sse'],
}

for (const [event, subsystems] of Object.entries(EVENT_TO_SUBSYSTEMS) as Array<
  [keyof EventMap, readonly SubsystemId[]]
>) {
  eventBus.subscribe(
    event,
    (payload) => {
      // Every event has a `timestamp: Date` except the probe events which
      // we don't subscribe to here. Fall back to Date.now() defensively.
      const ts =
        'timestamp' in payload && payload.timestamp instanceof Date
          ? payload.timestamp.getTime()
          : Date.now()
      for (const id of subsystems) heatmapAggregator.recordActivity(id, ts)
    },
    'low',
  )
}

// Probes still feed the degraded/down overlay so the heatmap visualises *when*
// a subsystem went bad, not just how busy it was.
eventBus.subscribe(
  'probe:completed',
  ({ result }) => {
    heatmapAggregator.recordStatus(result.subsystemId, result.status, result.probedAt)
  },
  'low',
)
