/**
 * System health snapshot assembler.
 *
 * Takes the latest cached ProbeResult for each registered subsystem (plus
 * the 30-minute rolling history kept by the probe registry, and a tiny
 * user-plane "activity" counter) and composes the JSON shape consumed by the
 * System Health page (`GET /api/health`).
 *
 * This module owns NO timers and NO mutable state — the probe registry is the
 * source of truth. Every function here is a pure transform over that state.
 */

import { probeRegistry, isHealthyStatus } from './probeRegistry.js'
import { activity } from './activity.js'
import { heatmapAggregator, type HeatmapCell } from './heatmapAggregator.js'
import {
  CORE_PROBES,
  NON_CORE_PROBES,
  SUBSYSTEM_METADATA,
  TOPOLOGY_EDGES,
  TOPOLOGY_NODES,
} from './subsystems.js'
import type { SubsystemMeta } from './subsystems.js'
import type { ProbeResult, ProbeStatus } from './probeTypes.js'
import { internalIncidents, type InternalIncident } from '../../alerts/internalIncidents.js'

// ---------------------------------------------------------------------------
// Snapshot types — mirrored in src/dashboard/types/systemHealth.ts
// ---------------------------------------------------------------------------

export interface SubsystemView {
  id: string
  title: string
  icon: string
  sub: string
  status: ProbeStatus
  latencyMs: number | null
  metrics: Array<{ lbl: string; val: string | number; unit?: string }>
  sparkline: number[]
  group: 'core' | 'non-core'
  cadenceMs: number
  lastProbedAt: number | null
  error?: string
}

export interface SystemHealthSnapshot {
  overall: {
    state: 'operational' | 'degraded' | 'outage'
    label: string
    sub: string
    subsystemsTotal: number
    subsystemsHealthy: number
    activeIncidents: number
    p1Count: number
    p2Count: number
    p3Count: number
    slowestProbe: { id: string; title: string; latencyMs: number } | null
    processUptimeSeconds: number
  }
  kpis: {
    dbPingMs: number | null
    dbPingSpark: number[]
    schedulerDriftMs: number | null
    schedulerDriftSpark: number[]
    bufferLatencyMs: number | null
    bufferLatencySpark: number[]
    activeIncidents: number
    lastUpdatedSeconds: number
  }
  subsystems: SubsystemView[]
  incidents: InternalIncident[]
  heatmap: {
    rows: Array<{ id: string; title: string; values: HeatmapCell[] }>
    labels: string[]
    bucketMinutes: number
  }
  probeHistory: {
    points: Array<{ ts: number; bySubsystem: Record<string, number | null> }>
  }
  activity: {
    points: Array<{ ts: number; checksPerSec: number }>
  }
  topology: {
    nodes: Array<{
      id: string
      label: string
      x: number
      y: number
      group: string
      status: ProbeStatus
    }>
    edges: Array<{ from: string; to: string; flow: 'active' | 'hot' | 'idle' }>
  }
  meta: {
    uptimeSeconds: number
    generatedAt: string
    timestamp: number
  }
}

const PROCESS_START_MS = Date.now()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sparklineFor(id: string, limit = 60): number[] {
  const history = probeRegistry.historyFor(id)
  const tail = history.slice(-limit)
  return tail.map((e) => e.latencyMs ?? 0)
}

function overallRollup(results: Map<string, ProbeResult>): {
  state: 'operational' | 'degraded' | 'outage'
  label: string
  sub: string
} {
  const coreDown = (CORE_PROBES as readonly string[]).some((id) => results.get(id)?.status === 'down')
  if (coreDown) {
    return {
      state: 'outage',
      label: 'Major outage in progress',
      sub: 'A core subsystem is unavailable — monitoring continuity is at risk.',
    }
  }

  const coreDegraded = (CORE_PROBES as readonly string[]).some(
    (id) => results.get(id)?.status === 'degraded',
  )
  const nonCoreDown = (NON_CORE_PROBES as readonly string[]).filter(
    (id) => results.get(id)?.status === 'down',
  ).length
  const nonCoreDegraded = (NON_CORE_PROBES as readonly string[]).filter(
    (id) => results.get(id)?.status === 'degraded',
  ).length

  if (coreDegraded || nonCoreDown >= 1 || nonCoreDegraded >= 2) {
    return {
      state: 'degraded',
      label: 'Partial degradation',
      sub: 'One or more subsystems are reporting pressure. Monitoring continues.',
    }
  }

  return {
    state: 'operational',
    label: 'All systems operational',
    sub: 'Every subsystem is healthy or in standby.',
  }
}

/**
 * Probe-latency history for the chart: 30 × 1-minute buckets, max latency per
 * subsystem per bucket. A single slow probe inside the minute wins — we want
 * spikes to surface, not be smoothed away.
 */
function buildHistoryPoints(): Array<{
  ts: number
  bySubsystem: Record<string, number | null>
}> {
  const BUCKETS = 30
  const BUCKET_MS = 60_000
  const now = Date.now()
  const start = Math.floor(now / BUCKET_MS) * BUCKET_MS - (BUCKETS - 1) * BUCKET_MS

  const histories = probeRegistry.historyAll()
  const points: Array<{ ts: number; bySubsystem: Record<string, number | null> }> = []

  for (let i = 0; i < BUCKETS; i++) {
    const ts = start + i * BUCKET_MS
    const end = ts + BUCKET_MS
    const bySubsystem: Record<string, number | null> = {}
    for (const meta of SUBSYSTEM_METADATA) {
      const history = histories[meta.id] ?? []
      let maxLatency: number | null = null
      for (const entry of history) {
        if (entry.ts < ts || entry.ts >= end) continue
        if (entry.latencyMs === null) continue
        maxLatency = maxLatency === null ? entry.latencyMs : Math.max(maxLatency, entry.latencyMs)
      }
      bySubsystem[meta.id] = maxLatency
    }
    points.push({ ts, bySubsystem })
  }
  return points
}

function buildSubsystemView(meta: SubsystemMeta, r: ProbeResult | null): SubsystemView {
  const status: ProbeStatus = r?.status ?? 'standby'
  const view: SubsystemView = {
    id: meta.id,
    title: meta.title,
    icon: meta.icon,
    sub: meta.sub,
    status,
    latencyMs: r?.latencyMs ?? null,
    metrics: r ? meta.formatMetrics(r) : [],
    sparkline: sparklineFor(meta.id, 60),
    group: meta.group,
    cadenceMs: meta.cadenceMs,
    lastProbedAt: r?.probedAt ?? null,
  }
  if (r?.error) view.error = r.error
  return view
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildSnapshot(): SystemHealthSnapshot {
  const results = new Map<string, ProbeResult>()
  for (const meta of SUBSYSTEM_METADATA) {
    const r = probeRegistry.latest(meta.id)
    if (r) results.set(meta.id, r)
  }

  const subsystems: SubsystemView[] = SUBSYSTEM_METADATA.map((meta) =>
    buildSubsystemView(meta, results.get(meta.id) ?? null),
  )

  const rollup = overallRollup(results)
  const incidents = internalIncidents.list()
  const active = incidents.filter((i) => i.status === 'active')

  let subsystemsHealthy = 0
  for (const s of subsystems) if (isHealthyStatus(s.status)) subsystemsHealthy += 1

  // Slowest probe — passive probes with null latency are ignored.
  let slowest: { id: string; title: string; latencyMs: number } | null = null
  for (const s of subsystems) {
    if (s.latencyMs === null) continue
    if (!slowest || s.latencyMs > slowest.latencyMs) {
      slowest = { id: s.id, title: s.title, latencyMs: s.latencyMs }
    }
  }

  // How recent is the freshest probe we have?
  let newestProbe = 0
  for (const r of results.values()) newestProbe = Math.max(newestProbe, r.probedAt)
  const lastUpdatedSeconds =
    newestProbe === 0 ? 0 : Math.max(0, Math.round((Date.now() - newestProbe) / 1000))

  const processUptimeSeconds = Math.floor((Date.now() - PROCESS_START_MS) / 1000)

  // Topology — color each node by its probe's current status; paint edges hot
  // when either end is unhealthy, idle when both ends are in standby.
  const topology = {
    nodes: TOPOLOGY_NODES.map((n) => ({
      ...n,
      status: (results.get(n.id)?.status ?? 'standby') as ProbeStatus,
    })),
    edges: TOPOLOGY_EDGES.map((e) => {
      const fromStatus = results.get(e.from)?.status
      const toStatus = results.get(e.to)?.status
      const isHot =
        fromStatus === 'down' ||
        fromStatus === 'degraded' ||
        toStatus === 'down' ||
        toStatus === 'degraded'
      const isIdle = fromStatus === 'standby' && toStatus === 'standby'
      const flow: 'active' | 'hot' | 'idle' = isHot ? 'hot' : isIdle ? 'idle' : 'active'
      return { ...e, flow }
    }),
  }

  const dbLatest = results.get('db')
  const schedulerLatest = results.get('scheduler')
  const bufferLatest = results.get('buffer')

  return {
    overall: {
      ...rollup,
      subsystemsTotal: subsystems.length,
      subsystemsHealthy,
      activeIncidents: active.length,
      p1Count: active.filter((i) => i.severity === 'p1').length,
      p2Count: active.filter((i) => i.severity === 'p2').length,
      p3Count: active.filter((i) => i.severity === 'p3').length,
      slowestProbe: slowest,
      processUptimeSeconds,
    },
    kpis: {
      dbPingMs: dbLatest?.latencyMs ?? null,
      dbPingSpark: sparklineFor('db', 60),
      schedulerDriftMs: schedulerLatest?.latencyMs ?? null,
      schedulerDriftSpark: sparklineFor('scheduler', 60),
      bufferLatencyMs: bufferLatest?.latencyMs ?? null,
      bufferLatencySpark: sparklineFor('buffer', 60),
      activeIncidents: active.length,
      lastUpdatedSeconds,
    },
    subsystems,
    incidents,
    heatmap: heatmapAggregator.snapshot(),
    probeHistory: {
      points: buildHistoryPoints(),
    },
    activity: {
      points: activity.recentPerSecond(60),
    },
    topology,
    meta: {
      uptimeSeconds: processUptimeSeconds,
      generatedAt: new Date().toISOString(),
      timestamp: Date.now(),
    },
  }
}
