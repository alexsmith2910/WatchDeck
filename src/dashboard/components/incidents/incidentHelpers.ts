/**
 * Shared helpers for the Incidents page.
 *
 * The server-side `ApiIncident` carries the raw cause string; the UI derives
 * severity, visual kind, and display label from a single lookup table so every
 * component agrees on the mapping. Historical aggregations (volume by day,
 * cause breakdown, top affected, flapping) are all derived from the incident
 * list — we don't hit a dedicated stats endpoint.
 */
import type { ApiIncident } from '../../types/api'

// ---------------------------------------------------------------------------
// Cause catalog
// ---------------------------------------------------------------------------

export type Severity = 'Critical' | 'Major' | 'Minor'
export type CauseKind = 'down' | 'degraded' | 'ssl' | 'latency' | 'body' | 'port' | 'other'

export interface CauseMeta {
  label: string
  short: string
  severity: Severity
  kind: CauseKind
}

export const CAUSE_META: Record<string, CauseMeta> = {
  endpoint_down:     { label: 'Down',                   short: 'Down',     severity: 'Critical', kind: 'down'     },
  endpoint_degraded: { label: 'Degraded',               short: 'Degraded', severity: 'Major',    kind: 'degraded' },
  ssl_expiring:      { label: 'SSL Expiring',           short: 'SSL',      severity: 'Minor',    kind: 'ssl'      },
  ssl_expired:       { label: 'SSL Expired',            short: 'SSL',      severity: 'Critical', kind: 'ssl'      },
  high_latency:      { label: 'High Latency',           short: 'Latency',  severity: 'Major',    kind: 'latency'  },
  body_mismatch:     { label: 'Body Validation Failed', short: 'Body',     severity: 'Major',    kind: 'body'     },
  port_closed:       { label: 'Port Closed',            short: 'Port',     severity: 'Critical', kind: 'port'     },
}

export function metaFor(cause: string): CauseMeta {
  return (
    CAUSE_META[cause] ?? {
      label: cause.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      short: 'Other',
      severity: 'Major',
      kind: 'other',
    }
  )
}

export function severityOf(inc: ApiIncident): Severity {
  return metaFor(inc.cause).severity
}

export type SevKey = 'crit' | 'maj' | 'min'

export function sevKey(sev: Severity): SevKey {
  return sev === 'Critical' ? 'crit' : sev === 'Major' ? 'maj' : 'min'
}

export function severityDotClass(sev: Severity): string {
  return sev === 'Critical'
    ? 'bg-wd-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-danger)_20%,transparent)]'
    : sev === 'Major'
      ? 'bg-wd-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-warning)_20%,transparent)]'
      : 'bg-wd-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-primary)_20%,transparent)]'
}

export function severityChipClass(sev: Severity): string {
  return sev === 'Critical'
    ? 'bg-wd-danger/15 text-wd-danger'
    : sev === 'Major'
      ? 'bg-wd-warning/15 text-wd-warning'
      : 'bg-wd-primary/15 text-wd-primary'
}

export function causeKindChipClass(kind: CauseKind): string {
  switch (kind) {
    case 'down':     return 'bg-wd-danger/15 text-wd-danger'
    case 'degraded': return 'bg-wd-warning/15 text-wd-warning'
    case 'ssl':      return 'bg-[color-mix(in_srgb,#b19cd9_18%,transparent)] text-[#b19cd9]'
    case 'latency':  return 'bg-wd-primary/15 text-wd-primary'
    case 'body':     return 'bg-[color-mix(in_srgb,#6aa6ff_18%,transparent)] text-[#6aa6ff]'
    case 'port':     return 'bg-wd-muted/15 text-wd-muted'
    default:         return 'bg-wd-muted/15 text-wd-muted'
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function fmtDuration(totalSec: number | null | undefined): string {
  if (totalSec == null) return '—'
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

export function fmtLiveDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function fmtAbsTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function liveElapsedSec(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
}

// ---------------------------------------------------------------------------
// Aggregations derived from the incident list
// ---------------------------------------------------------------------------

/** Per-endpoint sparkline payload — paired arrays so tooltip labels can map
 *  each rendered point back to its check timestamp. Newest timestamp last so
 *  the chart reads left-to-right. */
export interface EndpointSparkline {
  values: number[]
  timestamps: string[]
}

export interface VolumeDay {
  date: string
  label: string
  critical: number
  major: number
  minor: number
  total: number
  isToday: boolean
}

// Local-calendar-day key (yyyy-mm-dd). Using toISOString here would silently
// shift buckets by a day for anyone east of UTC, which drops "today" incidents
// off the end of a 14-day window and mis-labels every row in the tooltip.
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function volumeByDay(incidents: ApiIncident[], days = 14): VolumeDay[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayStarts: VolumeDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(startOfToday.getTime() - i * 86_400_000)
    dayStarts.push({
      date: localDayKey(d),
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      critical: 0,
      major: 0,
      minor: 0,
      total: 0,
      isToday: i === 0,
    })
  }
  const buckets = new Map<string, VolumeDay>()
  for (const d of dayStarts) buckets.set(d.date, d)

  for (const inc of incidents) {
    const dayKey = localDayKey(new Date(inc.startedAt))
    const b = buckets.get(dayKey)
    if (!b) continue
    const sev = severityOf(inc)
    if (sev === 'Critical') b.critical++
    else if (sev === 'Major') b.major++
    else b.minor++
    b.total++
  }
  return dayStarts
}

export interface CauseSlice {
  kind: CauseKind
  label: string
  count: number
  color: string
}

const CAUSE_KIND_COLOR: Record<CauseKind, string> = {
  down:     'var(--wd-danger)',
  degraded: 'var(--wd-warning)',
  latency:  'var(--wd-primary)',
  ssl:      '#b19cd9',
  body:     '#6aa6ff',
  port:     'var(--wd-muted)',
  other:    'var(--wd-muted)',
}

const CAUSE_KIND_LABEL: Record<CauseKind, string> = {
  down:     'Down',
  degraded: 'Degraded',
  latency:  'Latency',
  ssl:      'SSL',
  body:     'Body',
  port:     'Port',
  other:    'Other',
}

export function causeBreakdown(incidents: ApiIncident[], windowMs: number): CauseSlice[] {
  const cutoff = Date.now() - windowMs
  const counts = new Map<CauseKind, number>()
  for (const inc of incidents) {
    if (new Date(inc.startedAt).getTime() < cutoff) continue
    const kind = metaFor(inc.cause).kind
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const order: CauseKind[] = ['down', 'degraded', 'latency', 'ssl', 'body', 'port', 'other']
  return order
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .map((k) => ({
      kind: k,
      label: CAUSE_KIND_LABEL[k],
      count: counts.get(k)!,
      color: CAUSE_KIND_COLOR[k],
    }))
}

export interface TopAffectedRow {
  endpointId: string
  incidents: number
  totalDowntimeSec: number
  lastStartedAt: string
  trend: 'up' | 'down' | 'flat'
}

export function topAffected(
  incidents: ApiIncident[],
  windowMs: number,
  limit = 5,
): TopAffectedRow[] {
  const now = Date.now()
  const cutoff = now - windowMs
  const prevCutoff = cutoff - windowMs
  const curByEp = new Map<string, ApiIncident[]>()
  const prevByEp = new Map<string, number>()

  for (const inc of incidents) {
    const t = new Date(inc.startedAt).getTime()
    if (t >= cutoff) {
      const arr = curByEp.get(inc.endpointId) ?? []
      arr.push(inc)
      curByEp.set(inc.endpointId, arr)
    } else if (t >= prevCutoff) {
      prevByEp.set(inc.endpointId, (prevByEp.get(inc.endpointId) ?? 0) + 1)
    }
  }

  const rows: TopAffectedRow[] = []
  for (const [endpointId, incs] of curByEp) {
    const totalDowntimeSec = incs.reduce((s, i) => {
      if (i.durationSeconds != null) return s + i.durationSeconds
      if (i.status === 'active') return s + Math.floor((now - new Date(i.startedAt).getTime()) / 1000)
      return s
    }, 0)
    const lastStartedAt = incs.reduce(
      (a, b) => (new Date(b.startedAt).getTime() > new Date(a).getTime() ? b.startedAt : a),
      incs[0].startedAt,
    )
    const prev = prevByEp.get(endpointId) ?? 0
    const cur = incs.length
    const trend: 'up' | 'down' | 'flat' = cur > prev ? 'up' : cur < prev ? 'down' : 'flat'
    rows.push({ endpointId, incidents: cur, totalDowntimeSec, lastStartedAt, trend })
  }
  return rows.sort((a, b) => b.incidents - a.incidents).slice(0, limit)
}

export interface FlappingEndpoint {
  endpointId: string
  toggles: number
}

export function flappingEndpoints(
  incidents: ApiIncident[],
  windowMs: number,
  threshold = 3,
): FlappingEndpoint[] {
  const cutoff = Date.now() - windowMs
  const counts = new Map<string, number>()
  for (const inc of incidents) {
    if (new Date(inc.startedAt).getTime() < cutoff) continue
    counts.set(inc.endpointId, (counts.get(inc.endpointId) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= threshold)
    .map(([endpointId, toggles]) => ({ endpointId, toggles }))
    .sort((a, b) => b.toggles - a.toggles)
}

// ---------------------------------------------------------------------------
// Endpoint name lookup
// ---------------------------------------------------------------------------

export interface EndpointLite {
  _id: string
  name: string
  type?: 'http' | 'port'
  url?: string
  host?: string
  port?: number
  /** IDs of notification channels wired up to this endpoint. Used by table
   *  rows to render channel chips even when no alert has fired yet. */
  notificationChannelIds?: string[]
}

export function endpointDisplay(ep: EndpointLite | undefined): { name: string; url: string; kind: string } {
  if (!ep) return { name: 'Unknown endpoint', url: '', kind: '' }
  const url = ep.url ?? (ep.host && ep.port ? `${ep.host}:${ep.port}` : '')
  return { name: ep.name, url, kind: ep.type ?? '' }
}
