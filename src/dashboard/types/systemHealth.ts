/**
 * Frontend mirror of the SystemHealthSnapshot returned by GET /api/health.
 * Keep aligned with src/core/health/snapshot.ts — these types intentionally
 * have no runtime dependency on the backend module.
 */

export type ProbeStatus = 'healthy' | 'degraded' | 'down' | 'standby' | 'disabled'
export type OverallStateKey = 'operational' | 'degraded' | 'outage'
export type SubsystemGroup = 'core' | 'non-core'

export interface SubsystemMetric {
  lbl: string
  val: string | number
  unit?: string
}

export interface SubsystemSnapshot {
  id: string
  title: string
  icon: string
  sub: string
  status: ProbeStatus
  latencyMs: number | null
  metrics: SubsystemMetric[]
  sparkline: number[]
  group: SubsystemGroup
  cadenceMs: number
  lastProbedAt: number | null
  error?: string
}

export interface InternalIncident {
  id: string
  severity: 'p1' | 'p2' | 'p3'
  status: 'active' | 'resolved'
  title: string
  subsystem: string
  cause: string
  startedAt: number
  resolvedAt?: number
  durationSeconds?: number
  ack: string | null
  commits: number
  timeline: Array<{ at: number; event: string; detail?: string }>
}

export interface HeatmapCell {
  count: number
  degraded: number
  down: number
}

export interface HeatmapRow {
  id: string
  title: string
  values: HeatmapCell[]
}

export interface OverallState {
  state: OverallStateKey
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

export interface SystemHealthSnapshot {
  overall: OverallState
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
  subsystems: SubsystemSnapshot[]
  incidents: InternalIncident[]
  heatmap: {
    rows: HeatmapRow[]
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
    nodes: Array<{ id: string; label: string; x: number; y: number; group: string; status: ProbeStatus }>
    edges: Array<{ from: string; to: string; flow: 'active' | 'hot' | 'idle' }>
  }
  meta: {
    uptimeSeconds: number
    generatedAt: string
    timestamp: number
  }
}
