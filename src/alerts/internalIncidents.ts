/**
 * Internal (system-plane) incident tracker.
 *
 * Distinct from the user-endpoint IncidentManager in this same directory:
 *  - User-endpoint incidents are persisted to MongoDB and shown on the
 *    Incidents page (they refer to user-monitored endpoints).
 *  - Internal incidents are in-memory only, driven by probe transitions, and
 *    shown on the System Health page. They represent problems with WatchDeck
 *    itself.
 *
 * Lifecycle:
 *   - `probe:degraded` →  open an incident for that subsystem if one does not
 *                         already exist; otherwise bump `commits`.
 *   - `probe:recovered` → resolve the open incident for that subsystem.
 *
 * Severity mapping (§6.2 of the redesign spec):
 *   - core subsystem + down     → P1
 *   - core subsystem + degraded → P2
 *   - non-core subsystem + down     → P2
 *   - non-core subsystem + degraded → P3
 */

import { eventBus } from '../core/eventBus.js'
import { CORE_PROBES } from '../core/health/subsystems.js'
import type { ProbeResult } from '../core/health/probeTypes.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { InternalIncidentDoc } from '../storage/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InternalIncidentSeverity = 'p1' | 'p2' | 'p3'
export type InternalIncidentStatus = 'active' | 'resolved'

export interface InternalIncidentTimelineEntry {
  at: number
  event: string
  detail?: string
}

export interface InternalIncident {
  id: string
  subsystem: string
  severity: InternalIncidentSeverity
  status: InternalIncidentStatus
  title: string
  cause: string
  startedAt: number
  resolvedAt?: number
  durationSeconds?: number
  /** Number of probe completions that have reinforced this incident. */
  commits: number
  timeline: InternalIncidentTimelineEntry[]
}

// ---------------------------------------------------------------------------
// Retention config
// ---------------------------------------------------------------------------

const MAX_RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_RESOLVED_COUNT = 200

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

function severityFor(subsystem: string, status: 'down' | 'degraded'): InternalIncidentSeverity {
  const isCore = (CORE_PROBES as readonly string[]).includes(subsystem)
  if (status === 'down') return isCore ? 'p1' : 'p2'
  return isCore ? 'p2' : 'p3'
}

function toDoc(inc: InternalIncident): InternalIncidentDoc {
  const doc: InternalIncidentDoc = {
    _id: inc.id,
    subsystem: inc.subsystem,
    severity: inc.severity,
    status: inc.status,
    title: inc.title,
    cause: inc.cause,
    startedAt: new Date(inc.startedAt),
    commits: inc.commits,
    timeline: inc.timeline.map((t) => {
      const e: { at: Date; event: string; detail?: string } = {
        at: new Date(t.at),
        event: t.event,
      }
      if (t.detail !== undefined) e.detail = t.detail
      return e
    }),
  }
  if (inc.resolvedAt !== undefined) {
    doc.resolvedAt = new Date(inc.resolvedAt)
    doc.expiresAt = new Date(inc.resolvedAt + MAX_RESOLVED_RETENTION_MS)
  }
  if (inc.durationSeconds !== undefined) doc.durationSeconds = inc.durationSeconds
  return doc
}

function fromDoc(d: InternalIncidentDoc): InternalIncident {
  const inc: InternalIncident = {
    id: d._id,
    subsystem: d.subsystem,
    severity: d.severity,
    status: d.status,
    title: d.title,
    cause: d.cause,
    startedAt: new Date(d.startedAt).getTime(),
    commits: d.commits,
    timeline: (d.timeline ?? []).map((t) => {
      const e: InternalIncidentTimelineEntry = { at: new Date(t.at).getTime(), event: t.event }
      if (t.detail !== undefined) e.detail = t.detail
      return e
    }),
  }
  if (d.resolvedAt) inc.resolvedAt = new Date(d.resolvedAt).getTime()
  if (d.durationSeconds !== undefined) inc.durationSeconds = d.durationSeconds
  return inc
}

class InternalIncidentTracker {
  private incidents: InternalIncident[] = []
  private activeBySubsystem = new Map<string, string>()
  private seq = 1
  private unsubscribes: Array<() => void> = []
  private started = false
  private adapter: StorageAdapter | null = null

  /** Inject the storage adapter so lifecycle changes are persisted. */
  setAdapter(adapter: StorageAdapter | null): void {
    this.adapter = adapter
  }

  /** Replace in-memory state with previously-persisted incidents. */
  hydrate(docs: InternalIncidentDoc[]): void {
    this.incidents = docs.map(fromDoc)
    this.activeBySubsystem.clear()
    let maxSeq = 0
    for (const inc of this.incidents) {
      if (inc.status === 'active') this.activeBySubsystem.set(inc.subsystem, inc.id)
      const m = /^ii-(\d+)$/.exec(inc.id)
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]))
    }
    this.seq = maxSeq + 1
  }

  private persist(inc: InternalIncident): void {
    const adapter = this.adapter
    if (!adapter) return
    void adapter.upsertInternalIncident(toDoc(inc)).catch(() => {
      // Best-effort — if the DB is down, the in-memory state is still correct
      // and the next save cycle will catch up.
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribes.push(
      eventBus.subscribe('probe:degraded', (p) => this.onDegraded(p.result), 'standard'),
      eventBus.subscribe('probe:recovered', (p) => this.onRecovered(p.result), 'standard'),
    )
  }

  stop(): void {
    for (const u of this.unsubscribes) u()
    this.unsubscribes = []
    this.started = false
  }

  /** Ordered: active first (newest first), then resolved (newest first). */
  list(): InternalIncident[] {
    this.pruneResolved()
    const active = this.incidents
      .filter((i) => i.status === 'active')
      .sort((a, b) => b.startedAt - a.startedAt)
    const resolved = this.incidents
      .filter((i) => i.status === 'resolved')
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    return [...active, ...resolved]
  }

  /** Return the number of currently-active incidents. */
  activeCount(): number {
    let n = 0
    for (const i of this.incidents) if (i.status === 'active') n += 1
    return n
  }

  /** Duration of the oldest active incident in ms. 0 if none. */
  longestActiveDurationMs(): number {
    let oldest = 0
    const now = Date.now()
    for (const i of this.incidents) {
      if (i.status !== 'active') continue
      oldest = Math.max(oldest, now - i.startedAt)
    }
    return oldest
  }

  /** Epoch ms of the most recent state transition (open or resolve). 0 if none. */
  lastTransitionAt(): number {
    let latest = 0
    for (const i of this.incidents) {
      latest = Math.max(latest, i.startedAt)
      if (i.resolvedAt) latest = Math.max(latest, i.resolvedAt)
    }
    return latest
  }

  /** Test-only: wipe all state. */
  reset(): void {
    this.incidents = []
    this.activeBySubsystem.clear()
    this.seq = 1
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private onDegraded(result: ProbeResult): void {
    if (result.status !== 'degraded' && result.status !== 'down') return

    const severity = severityFor(result.subsystemId, result.status)
    const activeId = this.activeBySubsystem.get(result.subsystemId)
    const existing = activeId ? this.incidents.find((i) => i.id === activeId) : undefined

    if (existing && existing.status === 'active') {
      // If severity escalated (e.g. degraded → down), mutate in place and log it.
      if (severityRank(severity) > severityRank(existing.severity)) {
        existing.timeline.push({
          at: Date.now(),
          event: 'escalated',
          detail: `${existing.severity} → ${severity}`,
        })
        existing.severity = severity
        existing.title = titleFor(result.subsystemId, result.status)
      }
      existing.commits += 1
      existing.timeline.push({
        at: result.probedAt,
        event: 'probe',
        detail: result.error ?? `${result.status} (${result.latencyMs ?? 0}ms)`,
      })
      this.persist(existing)
      return
    }

    const id = `ii-${this.seq++}`
    const incident: InternalIncident = {
      id,
      subsystem: result.subsystemId,
      severity,
      status: 'active',
      title: titleFor(result.subsystemId, result.status),
      cause: result.error ?? `${result.subsystemId} is ${result.status}`,
      startedAt: result.probedAt,
      commits: 1,
      timeline: [
        { at: result.probedAt, event: 'opened', detail: result.error ?? `${result.status}` },
      ],
    }
    this.incidents.push(incident)
    this.activeBySubsystem.set(result.subsystemId, id)
    this.persist(incident)
  }

  private onRecovered(result: ProbeResult): void {
    const activeId = this.activeBySubsystem.get(result.subsystemId)
    if (!activeId) return
    const inc = this.incidents.find((i) => i.id === activeId)
    if (!inc || inc.status !== 'active') {
      this.activeBySubsystem.delete(result.subsystemId)
      return
    }
    inc.status = 'resolved'
    inc.resolvedAt = result.probedAt
    inc.durationSeconds = Math.max(0, Math.round((inc.resolvedAt - inc.startedAt) / 1000))
    inc.timeline.push({
      at: result.probedAt,
      event: 'resolved',
      detail: `Recovered after ${inc.durationSeconds}s`,
    })
    this.activeBySubsystem.delete(result.subsystemId)
    this.persist(inc)
  }

  private pruneResolved(): void {
    const cutoff = Date.now() - MAX_RESOLVED_RETENTION_MS
    this.incidents = this.incidents.filter((i) => {
      if (i.status === 'active') return true
      if ((i.resolvedAt ?? 0) < cutoff) return false
      return true
    })
    const resolvedCount = this.incidents.filter((i) => i.status === 'resolved').length
    if (resolvedCount > MAX_RESOLVED_COUNT) {
      // Drop oldest resolved entries to stay within bounds.
      const sorted = [...this.incidents].sort((a, b) => {
        const aR = a.status === 'resolved' ? (a.resolvedAt ?? 0) : Infinity
        const bR = b.status === 'resolved' ? (b.resolvedAt ?? 0) : Infinity
        return aR - bR
      })
      const toDrop = resolvedCount - MAX_RESOLVED_COUNT
      const dropSet = new Set<string>()
      for (const inc of sorted) {
        if (dropSet.size >= toDrop) break
        if (inc.status === 'resolved') dropSet.add(inc.id)
      }
      this.incidents = this.incidents.filter((i) => !dropSet.has(i.id))
    }
  }
}

function severityRank(sev: InternalIncidentSeverity): number {
  return sev === 'p1' ? 3 : sev === 'p2' ? 2 : 1
}

function titleFor(subsystemId: string, status: 'down' | 'degraded'): string {
  const pretty = subsystemId.charAt(0).toUpperCase() + subsystemId.slice(1)
  return status === 'down' ? `${pretty} is down` : `${pretty} is degraded`
}

export const internalIncidents = new InternalIncidentTracker()
