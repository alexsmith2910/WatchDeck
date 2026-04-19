// System Health API response types — mirror src/core/systemMetrics.ts

export type SubsystemStatus = 'healthy' | 'degraded' | 'down'
export type OverallStateKey = 'operational' | 'degraded' | 'outage'
export type TimeRangeKey = '1h' | '24h' | '7d'

export interface SubsystemMetric {
  lbl: string
  val: string | number
  unit?: string
}

export interface WorkerCounts {
  up: number
  warn: number
  down: number
  idle: number
}

export interface SubsystemSnapshot {
  id: string
  title: string
  icon: string
  sub: string
  status: SubsystemStatus
  metrics: SubsystemMetric[]
  workers: WorkerCounts
  sparkline: number[]
  group: 'core' | 'edge' | 'workers' | 'deps'
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
  detectorKey: string
}

export interface HeatmapRow {
  id: string
  title: string
  values: number[]
}

export interface TimeSeriesPoint {
  label: string
  ts: number
  throughput: number
  latency: number
  errors: number
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
  errorBudget: number
  uptime30d: number
}

export interface SystemHealthSnapshot {
  overall: OverallState
  kpis: {
    checksPerSec: number
    queueLagMs: number
    activeIncidents: number
    errorRate: number
    checksPerSecDelta: number
    queueLagDelta: number
    lastUpdatedSeconds: number
  }
  subsystems: SubsystemSnapshot[]
  incidents: InternalIncident[]
  heatmap: {
    rows: HeatmapRow[]
    labels: string[]
  }
  timeSeries: {
    range: TimeRangeKey
    points: TimeSeriesPoint[]
  }
  topology: {
    nodes: Array<{ id: string; label: string; x: number; y: number; group: string; status: SubsystemStatus }>
    edges: Array<{ from: string; to: string; flow: 'active' | 'hot' | 'idle' }>
  }
  meta: {
    uptimeSeconds: number
    generatedAt: string
    timestamp: number
  }
}
