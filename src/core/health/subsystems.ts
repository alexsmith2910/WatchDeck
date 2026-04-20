/**
 * Subsystem metadata registry.
 *
 * Central catalog of every probed subsystem: which tier it belongs to (core
 * or non-core), how its ProbeResult.details map onto the display metrics on
 * the System Health page, its card title/icon, and its active-probe cadence.
 *
 * This file has no sibling-module imports beyond probe types so it is safe to
 * import from probe modules, the snapshot assembler, the incident tracker,
 * and the routes layer without introducing cycles.
 */

import type { ProbeResult } from './probeTypes.js'

/** IDs whose status can single-handedly flip the overall banner to degraded/outage. */
export const CORE_PROBES = ['db', 'scheduler', 'checkers', 'buffer'] as const
export type CoreProbeId = (typeof CORE_PROBES)[number]

/** IDs whose non-healthy status only contributes to a rollup threshold (§4.5). */
export const NON_CORE_PROBES = [
  'sse',
  'eventbus',
  'aggregator',
  'incidents',
  'auth',
  'notifications',
] as const
export type NonCoreProbeId = (typeof NON_CORE_PROBES)[number]

export type SubsystemId = CoreProbeId | NonCoreProbeId

export interface SubsystemMeta {
  id: SubsystemId
  title: string
  icon: string
  sub: string
  group: 'core' | 'non-core'
  cadenceMs: number
  /** Convert a ProbeResult into the compact metrics shown on the card. */
  formatMetrics: (result: ProbeResult) => Array<{ lbl: string; val: string | number; unit?: string }>
}

function round(n: number, places = 0): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

function formatMs(v: unknown): string | number {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  return round(v)
}

export const SUBSYSTEM_METADATA: readonly SubsystemMeta[] = [
  {
    id: 'db',
    title: 'Database',
    icon: 'solar:database-bold',
    sub: 'mongo · ping 15s',
    group: 'core',
    cadenceMs: 15_000,
    formatMetrics: (r) => {
      const d = r.details
      return [
        { lbl: 'Connected', val: d.connected === true ? 'true' : 'false' },
        { lbl: 'Ping', val: formatMs(r.latencyMs ?? 0), unit: 'ms' },
        { lbl: 'Outage', val: round(Number(d.currentOutageSeconds) || 0), unit: 's' },
      ]
    },
  },
  {
    id: 'scheduler',
    title: 'Scheduler',
    icon: 'solar:clock-circle-bold',
    sub: 'tick · passive',
    group: 'core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      return [
        { lbl: 'Max drift', val: formatMs(r.latencyMs ?? 0), unit: 'ms' },
        { lbl: 'Queue', val: Number(d.queueSize) || 0 },
        { lbl: 'In-flight peak / 1s', val: Number(d.runningChecksPeakLastSecond) || 0 },
      ]
    },
  },
  {
    id: 'checkers',
    title: 'Checkers',
    icon: 'solar:pulse-bold',
    sub: 'loopback · 30s',
    group: 'core',
    cadenceMs: 30_000,
    formatMetrics: (r) => {
      const d = r.details
      const rate = Number(d.checksPerSecAvg) || 0
      return [
        { lbl: 'Loop RTT', val: formatMs(r.latencyMs ?? 0), unit: 'ms' },
        { lbl: 'Rate', val: rate.toFixed(2), unit: '/s' },
        { lbl: 'HTTP', val: Number(d.httpStatus) || '—' },
      ]
    },
  },
  {
    id: 'buffer',
    title: 'Buffer',
    icon: 'solar:layers-bold',
    sub: 'synthetic · 10s',
    group: 'core',
    cadenceMs: 10_000,
    formatMetrics: (r) => {
      const d = r.details
      const mem = Number(d.memorySize) || 0
      const cap = Number(d.memoryCapacity) || 0
      return [
        { lbl: 'Mode', val: String(d.mode ?? '—') },
        { lbl: 'Memory', val: cap > 0 ? `${mem}/${cap}` : String(mem) },
        { lbl: 'Disk lines', val: Number(d.diskLines) || 0 },
      ]
    },
  },
  {
    id: 'sse',
    title: 'SSE Stream',
    icon: 'solar:wi-fi-router-bold',
    sub: 'heartbeat · passive',
    group: 'non-core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      const ageSec = Math.round((Number(d.lastHeartbeatAgeMs) || 0) / 1000)
      return [
        { lbl: 'Clients', val: Number(d.clients) || 0 },
        { lbl: 'Last beat', val: ageSec, unit: 's' },
        { lbl: 'Interval', val: Math.round((Number(d.heartbeatIntervalMs) || 0) / 1000), unit: 's' },
      ]
    },
  },
  {
    id: 'eventbus',
    title: 'Event Bus',
    icon: 'solar:transmission-square-bold',
    sub: 'RTT · 5s',
    group: 'non-core',
    cadenceMs: 5_000,
    formatMetrics: (r) => {
      const d = r.details
      return [
        { lbl: 'RTT', val: formatMs(r.latencyMs ?? 0), unit: 'ms' },
        { lbl: 'History', val: Number(d.historySize) || 0 },
        { lbl: 'Listeners', val: Number(d.subscriberCount) || 0 },
      ]
    },
  },
  {
    id: 'aggregator',
    title: 'Aggregator',
    icon: 'solar:chart-square-bold',
    sub: 'cron · passive',
    group: 'non-core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      const lastH = Number(d.lastHourlyRunAt) || 0
      const nextH = Number(d.nextHourlyRunAt) || 0
      const agoH = lastH ? Math.round((Date.now() - lastH) / 60_000) : null
      const dueH = nextH ? Math.round((nextH - Date.now()) / 60_000) : null
      return [
        { lbl: 'Last hourly', val: agoH === null ? 'never' : `${agoH}m ago` },
        { lbl: 'Next hourly', val: dueH === null ? '—' : `${dueH}m` },
        { lbl: 'Last dur.', val: formatMs(Number(d.lastHourlyDurationMs) || 0), unit: 'ms' },
      ]
    },
  },
  {
    id: 'incidents',
    title: 'Incidents',
    icon: 'solar:shield-warning-bold',
    sub: 'subsystem tracker · passive',
    group: 'non-core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      return [
        { lbl: 'Active', val: Number(d.active) || 0 },
        {
          lbl: 'Longest',
          val: Math.round((Number(d.longestActiveDurationMs) || 0) / 1000),
          unit: 's',
        },
      ]
    },
  },
  {
    id: 'auth',
    title: 'Auth',
    icon: 'solar:shield-user-bold',
    sub: 'middleware · passive',
    group: 'non-core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      if (d.enabled !== true) {
        return [
          { lbl: 'Attempts', val: '—' },
          { lbl: 'Failures', val: '—' },
          { lbl: 'Rate 5m', val: '—' },
        ]
      }
      const rate = Number(d.failureRate) || 0
      return [
        { lbl: 'Attempts', val: Number(d.totalAttempts) || 0 },
        { lbl: 'Failures', val: Number(d.totalFailures) || 0 },
        { lbl: 'Rate 5m', val: round(rate * 100, 1), unit: '%' },
      ]
    },
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'solar:bell-bold',
    sub: 'channels · passive',
    group: 'non-core',
    cadenceMs: 0,
    formatMetrics: (r) => {
      const d = r.details
      const count = Number(d.channelCount) || 0
      if (count === 0) {
        return [
          { lbl: 'Channels', val: '—' },
          { lbl: 'Sent', val: '—' },
          { lbl: 'Failed', val: '—' },
        ]
      }
      return [
        { lbl: 'Channels', val: count },
        { lbl: 'Sent', val: Number(d.totalSent) || 0 },
        { lbl: 'Failed', val: Number(d.totalFailed) || 0 },
      ]
    },
  },
]

export function metaFor(id: string): SubsystemMeta | undefined {
  return SUBSYSTEM_METADATA.find((m) => m.id === id)
}

// ---------------------------------------------------------------------------
// Static topology — node positions are layout hints consumed by the frontend.
//
// Layout (top-to-bottom, canvas is 100×100 in logical units, the frontend
// maps it onto its own aspect-ratioed viewBox):
//   Row 1 (y=22, "Write path")  — scheduler → checkers → buffer → db → aggregator
//   Row 2 (y=54, "Hub")         — eventbus (centered under buffer/db)
//   Row 3 (y=86, "Consumers")   — sse → (via bus) → incidents → notifications
//   Auth sits on the right at row-2 height — it's request-path middleware,
//   not part of the check/result data flow, so it has no edges and is
//   intentionally visually isolated.
// ---------------------------------------------------------------------------

export const TOPOLOGY_NODES: ReadonlyArray<{
  id: SubsystemId
  label: string
  x: number
  y: number
  group: string
}> = [
  // Row 1 — write path
  { id: 'scheduler',     label: 'Scheduler',  x: 12, y: 22, group: 'core' },
  { id: 'checkers',      label: 'Checkers',   x: 31, y: 22, group: 'core' },
  { id: 'buffer',        label: 'Buffer',     x: 50, y: 22, group: 'core' },
  { id: 'db',            label: 'Database',   x: 69, y: 22, group: 'core' },
  { id: 'aggregator',    label: 'Aggregator', x: 88, y: 22, group: 'workers' },

  // Row 2 — hub (+ isolated middleware on the right)
  { id: 'eventbus',      label: 'Event Bus',  x: 50, y: 54, group: 'core' },
  { id: 'auth',          label: 'Auth',       x: 88, y: 54, group: 'edge' },

  // Row 3 — consumers
  { id: 'sse',           label: 'SSE',        x: 31, y: 86, group: 'edge' },
  { id: 'incidents',     label: 'Incidents',  x: 50, y: 86, group: 'workers' },
  { id: 'notifications', label: 'Notify',     x: 69, y: 86, group: 'workers' },
]

/**
 * Edges describe real producer→consumer wiring (what actually emits/listens),
 * not request-path arrows. Used both for layout AND for resolving which edges
 * to pulse when a given event type fires on the bus.
 */
export const TOPOLOGY_EDGES: ReadonlyArray<{ from: SubsystemId; to: SubsystemId }> = [
  // Write path
  { from: 'scheduler', to: 'checkers' },
  { from: 'checkers', to: 'buffer' },
  { from: 'buffer', to: 'db' },
  { from: 'db', to: 'aggregator' },
  // Pub/sub fan-out
  { from: 'checkers', to: 'eventbus' },
  { from: 'eventbus', to: 'sse' },
  { from: 'eventbus', to: 'incidents' },
  // Alerting cascade
  { from: 'incidents', to: 'notifications' },
]
