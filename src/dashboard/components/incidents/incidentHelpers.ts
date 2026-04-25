/**
 * Shared helpers for the Incidents page.
 *
 * The server-side `ApiIncident` carries the raw cause string; the UI derives
 * severity, visual kind, and display label from a single lookup table so every
 * component agrees on the mapping. Historical aggregations (volume by day,
 * cause breakdown, top affected, flapping) are served pre-computed from the
 * `/incidents/stats` endpoint and consumed directly by the trend components.
 */
import type { ApiIncident } from '../../types/api'
import { DEFAULT_PREFERENCES, type Preferences } from '../../context/PreferencesContext'
import { formatDateShort, formatHour } from '../../utils/time'

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

export function fmtAbsTime(
  iso: string,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return formatHour(d, prefs)
  return `${formatDateShort(d, prefs)} ${formatHour(d, prefs)}`
}

export function liveElapsedSec(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
}

// ---------------------------------------------------------------------------
// Per-endpoint sparkline payload — paired arrays so tooltip labels can map
// each rendered point back to its check timestamp. Newest timestamp last so
// the chart reads left-to-right.
// ---------------------------------------------------------------------------

export interface EndpointSparkline {
  values: number[]
  timestamps: string[]
}

// ---------------------------------------------------------------------------
// Endpoint name lookup
// ---------------------------------------------------------------------------

export interface EndpointLite {
  id: string
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
