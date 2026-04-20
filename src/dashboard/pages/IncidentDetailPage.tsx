import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Button, Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  useXAxisScale,
  usePlotArea,
} from 'recharts'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type { ApiIncident, ApiEndpoint, ApiCheck, IncidentTimelineEvent } from '../types/api'
import { formatDuration, formatDateTime, getIncidentRanges } from '../utils/format'
import type { IncidentRange } from '../utils/format'
import ForegroundReferenceArea from '../components/ForegroundReferenceArea'

// ---------------------------------------------------------------------------
// Live check (SSE-derived, NOT a full ApiCheck)
// ---------------------------------------------------------------------------

/**
 * Subset of fields the SSE `check:complete` event actually sends. This is
 * intentionally NOT ApiCheck — the event has no `_id`, no `duringMaintenance`,
 * no SSL/body-validation fields, because the broker forwards the raw check
 * engine event, not the saved DB document.
 */
interface LiveCheck {
  timestamp: string
  endpointId: string
  status: 'healthy' | 'degraded' | 'down'
  responseTime: number
  statusCode: number | null
  errorMessage: string | null
}

/** Shared shape used by chart + impact + timeline. Both ApiCheck and LiveCheck
 *  satisfy it, so downstream code doesn't care which source it came from. */
interface CheckPoint {
  timestamp: string
  status: 'healthy' | 'degraded' | 'down'
  responseTime: number
  statusCode: number | null
  errorMessage?: string | null
  /** Present for persisted ApiCheck rows, absent for LiveCheck. */
  _id?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a cause code to a human-readable string. */
function humanCause(cause: string): string {
  const map: Record<string, string> = {
    endpoint_down: 'Endpoint Down',
    endpoint_degraded: 'Degraded Performance',
    ssl_expiring: 'SSL Certificate Expiring',
    ssl_expired: 'SSL Certificate Expired',
    high_latency: 'High Latency',
    body_mismatch: 'Body Validation Failed',
    port_closed: 'Port Closed',
  }
  return map[cause] ?? cause.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Cap incident-detail live checks — chart doesn't need more history than this
// and leaving the page open on an active incident would otherwise grow forever.
const MAX_INCIDENT_CHECKS = 1000

/** Format a short time label for chart data points. */
function formatChartTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Compute the live or final duration in seconds. */
function computeDuration(startedAt: string, resolvedAt?: string, durationSeconds?: number): number {
  if (durationSeconds != null) return durationSeconds
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
}

/** Get a status code color class. */
function statusCodeColor(code: number): string {
  if (code >= 500) return 'bg-wd-danger/15 text-wd-danger'
  if (code >= 400) return 'bg-wd-warning/15 text-wd-warning'
  if (code >= 200 && code < 300) return 'bg-wd-success/15 text-wd-success'
  return 'bg-wd-surface-hover text-wd-muted'
}

interface TimelineMeta {
  icon: string
  iconColor: string
  tileBg: string
}

/** Get timeline event visual metadata (icon + colors). */
function timelineMeta(event: string, detail?: string): TimelineMeta {
  switch (event) {
    case 'opened':
      return {
        icon: 'solar:flag-bold',
        iconColor: 'text-wd-primary',
        tileBg: 'bg-wd-primary/10 border-wd-primary/20',
      }
    case 'resolved':
      return {
        icon: 'solar:flag-2-bold',
        iconColor: 'text-wd-success',
        tileBg: 'bg-wd-success/10 border-wd-success/20',
      }
    case 'notification_sent':
      return {
        icon: 'solar:bell-bold',
        iconColor: 'text-wd-warning',
        tileBg: 'bg-wd-warning/10 border-wd-warning/20',
      }
    case 'escalated':
      return {
        icon: 'solar:double-alt-arrow-up-bold',
        iconColor: 'text-wd-warning',
        tileBg: 'bg-wd-warning/10 border-wd-warning/20',
      }
    case 'acknowledged':
      return {
        icon: 'solar:user-check-bold',
        iconColor: 'text-wd-primary',
        tileBg: 'bg-wd-primary/10 border-wd-primary/20',
      }
    case 'check': {
      if (detail?.includes('down')) {
        return {
          icon: 'solar:close-circle-bold',
          iconColor: 'text-wd-danger',
          tileBg: 'bg-wd-danger/10 border-wd-danger/20',
        }
      }
      if (detail?.includes('degraded')) {
        return {
          icon: 'solar:minus-circle-bold',
          iconColor: 'text-wd-warning',
          tileBg: 'bg-wd-warning/10 border-wd-warning/20',
        }
      }
      return {
        icon: 'solar:pulse-linear',
        iconColor: 'text-wd-muted',
        tileBg: 'bg-wd-surface-hover border-wd-border/50',
      }
    }
    default:
      return {
        icon: 'solar:info-circle-linear',
        iconColor: 'text-wd-muted',
        tileBg: 'bg-wd-surface-hover border-wd-border/50',
      }
  }
}

/** Make a timeline event name human-readable. */
function humanEvent(event: string): string {
  const map: Record<string, string> = {
    opened: 'Incident Opened',
    resolved: 'Incident Resolved',
    check: 'Health Check',
    notification_sent: 'Notification Sent',
    escalated: 'Escalated',
    acknowledged: 'Acknowledged',
  }
  return map[event] ?? event.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Parse a check detail string like "down -- 503 -- 142ms" into parts. */
function parseCheckDetail(detail?: string): {
  status?: string
  statusCode?: number
  responseTime?: string
} {
  if (!detail) return {}
  // Format: "down — 503 — 142ms" or "down — Connection refused"
  const parts = detail.split(/\s*[—–-]\s*/).map((s) => s.trim())
  const result: { status?: string; statusCode?: number; responseTime?: string } = {}
  if (parts[0]) result.status = parts[0]
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    const codeMatch = /^(?:HTTP\s+)?(\d{3})$/.exec(p)
    if (codeMatch) {
      result.statusCode = parseInt(codeMatch[1], 10)
    } else if (/\d+\s*ms/i.test(p)) {
      result.responseTime = p
    }
  }
  return result
}

/** Mirror the server format so parseCheckDetail handles live-check rows the
 *  same as server-written ones. Must match incidentManager.ts. */
function buildLiveCheckDetail(c: LiveCheck): string {
  if (c.errorMessage) return `${c.status} — ${c.errorMessage}`
  return `${c.status} — ${c.statusCode ?? 'no status code'} — ${c.responseTime}ms`
}

/** Classify incident severity from its cause for the severity pill. */
function severityFromCause(cause: string): {
  label: 'Critical' | 'Major' | 'Minor'
  tone: 'danger' | 'warning' | 'muted'
} {
  const critical = ['endpoint_down', 'ssl_expired', 'port_closed']
  const major = ['endpoint_degraded', 'high_latency', 'body_mismatch']
  const minor = ['ssl_expiring']
  if (critical.includes(cause)) return { label: 'Critical', tone: 'danger' }
  if (major.includes(cause)) return { label: 'Major', tone: 'warning' }
  if (minor.includes(cause)) return { label: 'Minor', tone: 'muted' }
  return { label: 'Major', tone: 'warning' }
}

/**
 * Format a relative offset from an anchor timestamp, signed.
 * Examples: "+0s", "+2m 14s", "+1h 03m", "-15s" (for pre-incident checks).
 */
function formatRelativeFromAnchor(at: string | Date, anchor: string | Date): string {
  const t = typeof at === 'string' ? new Date(at).getTime() : at.getTime()
  const a = typeof anchor === 'string' ? new Date(anchor).getTime() : anchor.getTime()
  const deltaSec = Math.round((t - a) / 1000)
  const sign = deltaSec < 0 ? '-' : '+'
  const abs = Math.abs(deltaSec)
  if (abs < 60) return `${sign}${abs}s`
  if (abs < 3600) {
    const m = Math.floor(abs / 60)
    const s = abs % 60
    return s > 0 ? `${sign}${m}m ${String(s).padStart(2, '0')}s` : `${sign}${m}m`
  }
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  return m > 0 ? `${sign}${h}h ${String(m).padStart(2, '0')}m` : `${sign}${h}h`
}

/**
 * Binary search for the index in a sorted-by-timestamp array that is nearest
 * to target. Returns -1 if the array is empty.
 */
function nearestIndexByTimestamp(
  sortedTs: number[],
  targetMs: number,
): number {
  if (sortedTs.length === 0) return -1
  let lo = 0
  let hi = sortedTs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sortedTs[mid] < targetMs) lo = mid + 1
    else hi = mid
  }
  // lo is the first index >= target. Check whether lo-1 is closer.
  if (lo > 0 && Math.abs(sortedTs[lo - 1] - targetMs) < Math.abs(sortedTs[lo] - targetMs)) {
    return lo - 1
  }
  return lo
}

/** A fingerprint used to group consecutive identical check rows. */
function checkFingerprint(c: CheckPoint | undefined, detail: string | undefined): string {
  const status = c?.status ?? parseCheckDetail(detail).status ?? '?'
  const code = c?.statusCode ?? parseCheckDetail(detail).statusCode ?? 'none'
  const err = c?.errorMessage ?? 'none'
  return `${status}|${code}|${err}`
}

// ---------------------------------------------------------------------------
// Timeline row model
// ---------------------------------------------------------------------------

interface TimelineRow {
  key: string
  at: string | Date
  /** Either a real event name from the server timeline, or 'check-group' for
   *  a client-side collapsed run of consecutive identical checks. */
  event: string
  detail?: string
  check?: CheckPoint
  badge?: 'trigger' | 'recovery'
  /** Present only when event === 'check-group'. */
  groupMembers?: TimelineRow[]
  groupStats?: { min: number; max: number; avg: number }
  groupFingerprint?: string
}

// ---------------------------------------------------------------------------
// Chart tooltip
// ---------------------------------------------------------------------------

function ChartTooltipContent({
  active,
  payload,
  label,
  incidentRanges,
}: {
  active?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[]
  label?: string
  incidentRanges?: IncidentRange[]
}) {
  if (!active || !payload?.length) return null

  const entry = payload[0]
  const matchedRange = incidentRanges?.find(
    (r) => label != null && label >= r.x1 && label <= r.x2,
  )

  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg max-w-[240px]">
      <div className="text-[11px] text-wd-muted mb-1">{label}</div>
      <div className="flex items-center gap-2 text-xs">
        <span className="h-2 w-2 rounded-full shrink-0 bg-[var(--wd-primary)]" />
        <span className="text-wd-muted">Response:</span>
        <span className="font-semibold text-foreground">{entry.value}ms</span>
      </div>
      {matchedRange && (
        <div
          className={cn(
            'flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-wd-border/50 text-[11px] font-medium',
            matchedRange.type === 'down' ? 'text-wd-danger' : 'text-wd-warning',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              matchedRange.type === 'down' ? 'bg-wd-danger' : 'bg-wd-warning',
            )}
          />
          {matchedRange.type === 'down' ? 'Outage detected' : 'Degraded performance'}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { request } = useApi()
  const { subscribe } = useSSE()

  // State
  const [incident, setIncident] = useState<ApiIncident | null>(null)
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null)
  const [checks, setChecks] = useState<ApiCheck[]>([])
  // SSE-derived checks are NOT full ApiCheck documents — the stream only
  // forwards the raw check engine event. Keeping them in a separate bucket
  // prevents mistakenly rendering fields that aren't actually present.
  const [liveChecks, setLiveChecks] = useState<LiveCheck[]>([])
  const [relatedIncidents, setRelatedIncidents] = useState<ApiIncident[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [runtimeTick, setRuntimeTick] = useState(0)
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Fetch incident
  // ---------------------------------------------------------------------------

  const fetchIncident = useCallback(async () => {
    if (!id) return
    const res = await request<{ data: ApiIncident }>(`/incidents/${id}`)
    if (res.status === 404 || !res.data?.data) {
      setNotFound(true)
      setLoading(false)
      return
    }
    setIncident(res.data.data)
    return res.data.data
  }, [id, request])

  // ---------------------------------------------------------------------------
  // Fetch endpoint + checks after incident is loaded
  // ---------------------------------------------------------------------------

  const fetchDetails = useCallback(
    async (inc: ApiIncident) => {
      const startDate = new Date(inc.startedAt)
      const from = new Date(startDate.getTime() - 30 * 60 * 1000).toISOString()
      const to = inc.resolvedAt
        ? new Date(new Date(inc.resolvedAt).getTime() + 30 * 60 * 1000).toISOString()
        : new Date().toISOString()

      // Related incidents: same endpoint, last 7 days, excluding this one.
      const relatedFrom = new Date(startDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [epRes, chkRes, relRes] = await Promise.all([
        request<{ data: ApiEndpoint }>(`/endpoints/${inc.endpointId}`),
        request<{ data: ApiCheck[] }>(
          `/endpoints/${inc.endpointId}/checks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`,
        ),
        request<{ data: ApiIncident[] }>(
          `/incidents?endpointId=${inc.endpointId}&from=${encodeURIComponent(relatedFrom)}&limit=20`,
        ),
      ])

      if (epRes.data?.data) setEndpoint(epRes.data.data)
      if (chkRes.data?.data) setChecks(chkRes.data.data)
      if (relRes.data?.data) {
        setRelatedIncidents(relRes.data.data.filter((r) => r._id !== inc._id))
      } else {
        setRelatedIncidents([])
      }
    },
    [request],
  )

  // ---------------------------------------------------------------------------
  // Initial load
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const inc = await fetchIncident()
      if (cancelled || !inc) return
      await fetchDetails(inc)
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [fetchIncident, fetchDetails])

  // ---------------------------------------------------------------------------
  // Live ticking for active incidents
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!incident || incident.status === 'resolved') return
    const interval = setInterval(() => {
      setRuntimeTick((t) => t + 1)
    }, 1000)
    return () => {
      clearInterval(interval)
    }
  }, [incident])

  // ---------------------------------------------------------------------------
  // SSE: incident:resolved
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return subscribe('incident:resolved', (raw) => {
      const data = raw as { incidentId?: string; incident?: ApiIncident }
      if (data.incidentId === id || data.incident?._id === id) {
        if (data.incident) {
          setIncident(data.incident)
        } else {
          // Refetch to get the full updated incident
          fetchIncident()
        }
      }
    })
  }, [subscribe, id, fetchIncident])

  // ---------------------------------------------------------------------------
  // SSE: check:complete — track live checks separately from persisted ones.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!incident || incident.status === 'resolved') return
    return subscribe('check:complete', (raw) => {
      // The SSE payload is NOT an ApiCheck — it's the raw check engine event
      // (no _id, no duringMaintenance, etc.). See checkRunner.ts.
      const data = raw as {
        timestamp: string | Date
        endpointId: string
        status: 'healthy' | 'degraded' | 'down'
        responseTime: number
        statusCode: number | null
        errorMessage: string | null
      }
      if (data.endpointId !== incident.endpointId) return
      const normalized: LiveCheck = {
        timestamp: typeof data.timestamp === 'string'
          ? data.timestamp
          : new Date(data.timestamp).toISOString(),
        endpointId: data.endpointId,
        status: data.status,
        responseTime: data.responseTime,
        statusCode: data.statusCode,
        errorMessage: data.errorMessage,
      }
      setLiveChecks((prev) => {
        const next = [...prev, normalized]
        return next.length > MAX_INCIDENT_CHECKS
          ? next.slice(next.length - MAX_INCIDENT_CHECKS)
          : next
      })
      // Keep the endpoint's runtime fields fresh — the next-check countdown
      // reads lastCheckAt. No refetch needed for this.
      setEndpoint((ep) =>
        ep
          ? {
              ...ep,
              lastCheckAt: normalized.timestamp,
              lastStatus: normalized.status,
              lastResponseTime: normalized.responseTime,
              lastStatusCode: normalized.statusCode,
              lastErrorMessage: normalized.errorMessage,
            }
          : ep,
      )
    })
  }, [subscribe, incident])

  // ---------------------------------------------------------------------------
  // Merged checks — ApiCheck from the API + LiveCheck from SSE.
  // Both satisfy CheckPoint, so downstream code treats them uniformly.
  // liveChecks are only included if their timestamp is strictly newer than
  // the latest fetched ApiCheck (prevents dedup issues if a refetch races SSE).
  // ---------------------------------------------------------------------------

  const allChecks = useMemo<CheckPoint[]>(() => {
    const merged: CheckPoint[] = checks.map((c) => ({
      _id: c._id,
      timestamp: c.timestamp,
      status: c.status,
      responseTime: c.responseTime,
      statusCode: c.statusCode ?? null,
      errorMessage: c.errorMessage ?? null,
    }))
    const latestApiTs = merged.reduce((acc, c) => {
      const t = new Date(c.timestamp).getTime()
      return t > acc ? t : acc
    }, 0)
    for (const lc of liveChecks) {
      if (new Date(lc.timestamp).getTime() > latestApiTs) {
        merged.push({
          timestamp: lc.timestamp,
          status: lc.status,
          responseTime: lc.responseTime,
          statusCode: lc.statusCode,
          errorMessage: lc.errorMessage,
        })
      }
    }
    return merged.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
  }, [checks, liveChecks])

  /** Pre-extracted timestamp array for binary search. */
  const allChecksTs = useMemo(
    () => allChecks.map((c) => new Date(c.timestamp).getTime()),
    [allChecks],
  )

  // ---------------------------------------------------------------------------
  // Chart data — from merged list so new checks appear live.
  // ---------------------------------------------------------------------------

  const chartData = useMemo(() => {
    return allChecks.map((c) => ({
      label: formatChartTime(c.timestamp),
      avg: c.responseTime,
      fails: c.status === 'down' ? 1 : 0,
      degraded: c.status === 'degraded' ? 1 : 0,
      status: c.status,
      at: c.timestamp,
    }))
  }, [allChecks])

  const incidentRanges = useMemo(() => getIncidentRanges(chartData), [chartData])

  // ---------------------------------------------------------------------------
  // Computed values
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _tick = runtimeTick // reference to trigger re-render
  const duration = incident ? computeDuration(incident.startedAt, incident.resolvedAt, incident.durationSeconds) : 0

  // Checks that fall strictly within the incident window. `allChecks` includes
  // a ±30m buffer for chart context — stats must exclude that buffer so they
  // describe the incident itself, not the surrounding period. Does NOT depend
  // on runtimeTick — live checks arrive with timestamps <= Date.now() at
  // arrival, so the right bound only matters when SSE fires, which already
  // updates liveChecks and re-triggers this memo.
  const incidentChecks = useMemo(() => {
    if (!incident) return []
    const startMs = new Date(incident.startedAt).getTime()
    const endMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime()
      : Number.POSITIVE_INFINITY
    return allChecks.filter((c) => {
      const t = new Date(c.timestamp).getTime()
      return t >= startMs && t <= endMs
    })
  }, [allChecks, incident])

  const checksFailedCount = useMemo(() => {
    return incidentChecks.filter((c) => c.status !== 'healthy').length
  }, [incidentChecks])

  const totalChecksCount = incidentChecks.length

  // Build the display timeline by augmenting the server-recorded timeline
  // with the triggering/recovering checks pulled from `allChecks`, plus
  // synthetic rows for live checks received via SSE after the last timeline
  // entry (so new checks appear without a refresh).
  //
  // Consecutive `check` rows with identical (status, statusCode, errorMessage)
  // are collapsed into a single `group` row when the run length >= 5.
  // Trigger/recovery rows are never collapsed — they mark state transitions.
  const displayRows = useMemo<TimelineRow[]>(() => {
    if (!incident?.timeline) return []

    /** Binary-search nearest CheckPoint, optionally filtered by status class. */
    const findNearestCheck = (
      ts: string,
      filter?: 'failing' | 'healthy',
    ): CheckPoint | undefined => {
      const target = new Date(ts).getTime()
      if (!filter) {
        const idx = nearestIndexByTimestamp(allChecksTs, target)
        if (idx < 0) return undefined
        const c = allChecks[idx]
        return Math.abs(allChecksTs[idx] - target) < 120_000 ? c : undefined
      }
      // Filtered search: binary-seed then walk outward until we find a match
      // within tolerance. Still sub-linear on typical data.
      const seed = nearestIndexByTimestamp(allChecksTs, target)
      if (seed < 0) return undefined
      let best: CheckPoint | undefined
      let bestDelta = Infinity
      const matches = (c: CheckPoint) =>
        filter === 'healthy' ? c.status === 'healthy' : c.status !== 'healthy'
      for (let step = 0; step < allChecks.length; step++) {
        const iL = seed - step
        const iR = seed + step
        for (const i of step === 0 ? [seed] : [iL, iR]) {
          if (i < 0 || i >= allChecks.length) continue
          const delta = Math.abs(allChecksTs[i] - target)
          if (delta >= 120_000) continue
          if (!matches(allChecks[i])) continue
          if (delta < bestDelta) {
            bestDelta = delta
            best = allChecks[i]
          }
        }
        // Early exit: once our radius exceeds tolerance, no closer match
        // is possible on either side.
        const iLdist = iL >= 0 ? Math.abs(allChecksTs[iL] - target) : Infinity
        const iRdist = iR < allChecks.length ? Math.abs(allChecksTs[iR] - target) : Infinity
        if (iLdist >= 120_000 && iRdist >= 120_000) break
      }
      return best
    }

    const rows: TimelineRow[] = []
    const timeline = incident.timeline

    // Stable key for a CheckPoint even when _id is missing (live checks).
    const checkKey = (c: CheckPoint, prefix: string): string =>
      c._id ? `${prefix}:${c._id}` : `${prefix}:${c.timestamp}`

    for (let i = 0; i < timeline.length; i++) {
      const evt = timeline[i]

      if (evt.event === 'opened') {
        const trigger = findNearestCheck(evt.at, 'failing')
        if (trigger) {
          rows.push({
            key: checkKey(trigger, 'trigger'),
            at: trigger.timestamp,
            event: 'check',
            check: trigger,
            badge: 'trigger',
          })
        }
        rows.push({ key: `tl:${i}`, at: evt.at, event: evt.event, detail: evt.detail })
      } else if (evt.event === 'resolved') {
        const recovery = findNearestCheck(evt.at, 'healthy')
        if (recovery) {
          rows.push({
            key: checkKey(recovery, 'recovery'),
            at: recovery.timestamp,
            event: 'check',
            check: recovery,
            badge: 'recovery',
          })
        }
        rows.push({ key: `tl:${i}`, at: evt.at, event: evt.event, detail: evt.detail })
      } else if (evt.event === 'check') {
        const matched = findNearestCheck(evt.at)
        rows.push({
          key: `tl:${i}`,
          at: evt.at,
          event: evt.event,
          detail: evt.detail,
          check: matched,
        })
      } else {
        rows.push({ key: `tl:${i}`, at: evt.at, event: evt.event, detail: evt.detail })
      }
    }

    // ── Append live checks that arrived after the last server timeline entry.
    // These rows appear immediately without waiting for a refetch.
    const lastTlTs = timeline.length > 0
      ? new Date(timeline[timeline.length - 1].at).getTime()
      : 0
    const resolvedMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime()
      : Number.POSITIVE_INFINITY
    const startMs = new Date(incident.startedAt).getTime()
    for (const lc of liveChecks) {
      const t = new Date(lc.timestamp).getTime()
      if (t <= lastTlTs) continue // already covered by the server timeline
      if (t < startMs || t > resolvedMs) continue // outside the incident window
      const cp: CheckPoint = {
        timestamp: lc.timestamp,
        status: lc.status,
        responseTime: lc.responseTime,
        statusCode: lc.statusCode,
        errorMessage: lc.errorMessage,
      }
      rows.push({
        key: `live:${lc.timestamp}`,
        at: lc.timestamp,
        event: 'check',
        detail: buildLiveCheckDetail(lc),
        check: cp,
      })
    }

    // ── Group consecutive identical checks (≥ 5 in a row).
    // Never group trigger/recovery (they mark state transitions).
    const GROUP_MIN = 5
    const grouped: TimelineRow[] = []
    let runStart = -1 // index in `rows` of the first eligible check of a run
    let runFingerprint: string | null = null

    const flushRun = (endExclusive: number) => {
      if (runStart < 0 || runFingerprint == null) return
      const runLen = endExclusive - runStart
      if (runLen < GROUP_MIN) {
        for (let j = runStart; j < endExclusive; j++) grouped.push(rows[j])
      } else {
        const members = rows.slice(runStart, endExclusive)
        const times = members
          .map((r) => r.check?.responseTime ?? 0)
          .filter((t) => t > 0)
        const stats = times.length > 0
          ? {
              min: Math.min(...times),
              max: Math.max(...times),
              avg: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
            }
          : { min: 0, max: 0, avg: 0 }
        grouped.push({
          key: `group:${members[0].key}:${members[members.length - 1].key}`,
          at: members[0].at,
          event: 'check-group',
          groupMembers: members,
          groupStats: stats,
          groupFingerprint: runFingerprint,
        })
      }
      runStart = -1
      runFingerprint = null
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const isEligibleCheck = r.event === 'check' && !r.badge
      if (!isEligibleCheck) {
        flushRun(i)
        grouped.push(r)
        continue
      }
      const fp = checkFingerprint(r.check, r.detail)
      if (runFingerprint == null) {
        runStart = i
        runFingerprint = fp
      } else if (fp !== runFingerprint) {
        flushRun(i)
        runStart = i
        runFingerprint = fp
      }
    }
    flushRun(rows.length)

    return grouped
  }, [incident, allChecks, allChecksTs, liveChecks])

  // Impact analysis: latency stats + status distribution, restricted to the
  // incident window only.
  const impact = useMemo(() => {
    if (incidentChecks.length === 0) return null
    const times = incidentChecks
      .map((c) => c.responseTime)
      .filter((t) => t > 0)
      .sort((a, b) => a - b)
    const counts = { healthy: 0, degraded: 0, down: 0 }
    for (const c of incidentChecks) {
      counts[c.status]++
    }
    if (times.length === 0) return { min: 0, avg: 0, p95: 0, max: 0, counts }
    const min = times[0]
    const max = times[times.length - 1]
    const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length)
    const p95 = times[Math.min(Math.floor(times.length * 0.95), times.length - 1)]
    return { min, avg, p95, max, counts }
  }, [incidentChecks])

  // ---------------------------------------------------------------------------
  // Loading / 404 states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-32">
        <Spinner size="lg" />
      </div>
    )
  }

  if (notFound || !incident) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-32 gap-4">
        <Icon icon="solar:danger-triangle-linear" className="text-wd-muted text-5xl" />
        <p className="text-wd-muted text-lg">Incident not found</p>
        <Button variant="flat" onPress={() => navigate('/incidents')}>
          Back to Incidents
        </Button>
      </div>
    )
  }

  const isActive = incident.status === 'active'

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const severityColor = isActive ? 'danger' : 'success'
  const shortId = incident._id.slice(-8)
  const severity = severityFromCause(incident.cause)

  // Format the endpoint's check interval for the Cadence KPI.
  const cadenceLabel = endpoint
    ? endpoint.checkInterval < 60
      ? `${endpoint.checkInterval}s`
      : endpoint.checkInterval % 60 === 0
        ? `${endpoint.checkInterval / 60}m`
        : `${endpoint.checkInterval}s`
    : '—'

  // Next-check countdown for active incidents. Driven by runtimeTick.
  let nextCheckInLabel: string | null = null
  if (isActive && endpoint?.lastCheckAt && endpoint.checkInterval > 0) {
    const nextAtMs = new Date(endpoint.lastCheckAt).getTime() + endpoint.checkInterval * 1000
    const remainMs = nextAtMs - Date.now()
    if (remainMs <= 0) {
      nextCheckInLabel = 'any moment…'
    } else if (remainMs < 60_000) {
      nextCheckInLabel = `in ${Math.ceil(remainMs / 1000)}s`
    } else {
      nextCheckInLabel = `in ${Math.ceil(remainMs / 60_000)}m`
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-wd-muted">
        <Link to="/incidents" className="hover:text-foreground transition-colors">
          Incidents
        </Link>
        <Icon icon="solar:alt-arrow-right-linear" width={16} />
        <span className="text-foreground truncate">
          {endpoint?.name ?? 'Incident'}
        </span>
        <span className="text-wd-muted/50">·</span>
        <span className="font-mono text-wd-muted/70">#{shortId}</span>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Hero */}
      {/* ------------------------------------------------------------------- */}
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border bg-wd-surface',
          isActive ? 'border-wd-danger/30' : 'border-wd-border/50',
        )}
      >
        {/* Status tint */}
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            isActive
              ? 'bg-gradient-to-br from-wd-danger/[0.06] via-transparent to-transparent'
              : 'bg-gradient-to-br from-wd-success/[0.05] via-transparent to-transparent',
          )}
        />

        <div className="relative p-6">
          <div className="flex flex-wrap items-start justify-between gap-6">
            {/* Left side: status + title + actions */}
            <div className="flex-1 min-w-0 space-y-3">
              {/* Status + severity pills */}
              <div className="flex flex-wrap items-center gap-2">
                {isActive ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-wd-danger/15 px-2.5 py-1 text-xs font-semibold text-wd-danger">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-wd-danger" />
                    </span>
                    Active Incident
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-wd-success/15 px-2.5 py-1 text-xs font-semibold text-wd-success">
                    <Icon icon="solar:check-circle-bold" width={16} />
                    Resolved
                  </span>
                )}
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                    severity.tone === 'danger'
                      ? 'bg-wd-danger/10 text-wd-danger'
                      : severity.tone === 'warning'
                        ? 'bg-wd-warning/10 text-wd-warning'
                        : 'bg-wd-surface-hover text-wd-muted',
                  )}
                >
                  <Icon icon="solar:shield-warning-linear" width={16} />
                  Severity: {severity.label}
                </span>
                {isActive && nextCheckInLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-wd-surface-hover px-2.5 py-1 text-[11px] font-medium text-wd-muted">
                    <Icon icon="solar:refresh-linear" width={16} />
                    Next check {nextCheckInLabel}
                  </span>
                )}
              </div>

              {/* Title + cause */}
              <div>
                <h1 className="text-2xl font-semibold text-foreground leading-tight">
                  <Link
                    to={`/endpoints/${incident.endpointId}`}
                    className="hover:text-wd-primary transition-colors"
                  >
                    {endpoint?.name ?? 'Unknown Endpoint'}
                  </Link>
                </h1>
                <p className="mt-1 text-sm">
                  <span
                    className={cn(
                      'font-medium',
                      isActive ? 'text-wd-danger' : 'text-foreground/80',
                    )}
                  >
                    {humanCause(incident.cause)}
                  </span>
                  {incident.causeDetail && (
                    <span className="text-wd-muted"> — {incident.causeDetail}</span>
                  )}
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  variant="bordered"
                  className="!text-xs"
                  onPress={() => navigate(`/endpoints/${incident.endpointId}`)}
                >
                  <Icon icon="solar:square-arrow-right-up-linear" width={16} />
                  View Endpoint
                </Button>
                <Button
                  size="sm"
                  variant="bordered"
                  className="!text-xs"
                  onPress={() => navigate('/incidents')}
                >
                  <Icon icon="solar:list-linear" width={16} />
                  All Incidents
                </Button>
              </div>
            </div>

            {/* Right side: duration display */}
            <div className="flex flex-col items-end gap-1 shrink-0 min-w-[160px]">
              <span className="text-[10px] font-medium uppercase tracking-wider text-wd-muted">
                {isActive ? 'Ongoing for' : 'Total Duration'}
              </span>
              <span
                className={cn(
                  'font-mono text-3xl font-semibold tracking-tight leading-none',
                  isActive ? 'text-wd-danger' : 'text-foreground',
                )}
              >
                {formatDuration(duration)}
              </span>
              <div className="mt-1.5 text-right text-[11px] text-wd-muted leading-snug">
                <div>
                  <span className="text-wd-muted/70">Started </span>
                  <span className="font-mono">{formatDateTime(incident.startedAt)}</span>
                </div>
                {incident.resolvedAt && (
                  <div>
                    <span className="text-wd-muted/70">Resolved </span>
                    <span className="font-mono">{formatDateTime(incident.resolvedAt)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* KPI strip */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex items-center flex-wrap gap-x-6 gap-y-3 rounded-xl border border-wd-border/50 bg-wd-surface px-5 py-4">
        <KpiCell
          icon="solar:clock-circle-linear"
          tone={severityColor}
          label={isActive ? 'Running' : 'Duration'}
          value={formatDuration(duration)}
        />
        <KpiDivider />
        <KpiCell
          icon="solar:close-circle-linear"
          tone={checksFailedCount > 0 ? 'danger' : 'muted'}
          label="Checks Failed"
          value={totalChecksCount > 0 ? `${checksFailedCount}` : '—'}
        />
        <KpiDivider />
        <KpiCell
          icon="solar:pulse-linear"
          tone="muted"
          label="Check Cadence"
          value={`every ${cadenceLabel}`}
        />
        <KpiDivider />
        <KpiCell
          icon="solar:bell-linear"
          tone={incident.notificationsSent > 0 ? 'warning' : 'muted'}
          label="Notifications"
          value={`${incident.notificationsSent} sent`}
        />
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Response Time Chart + Impact Analysis */}
      {/* ------------------------------------------------------------------- */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart — 2/3 */}
          <div className="lg:col-span-2 rounded-xl border border-wd-border/50 bg-wd-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Response Time</h2>
                <p className="text-[11px] text-wd-muted mt-0.5">
                  Latency during the incident, with 30m of context before and after
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-wd-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-sm bg-[var(--wd-primary)]" />
                  Response
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-sm bg-wd-danger/70" />
                  Down
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-sm bg-wd-warning/70" />
                  Degraded
                </span>
              </div>
            </div>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="incidentChartGrad" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--wd-primary)" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="var(--wd-primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--wd-border)"
                    strokeOpacity={0.5}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--wd-muted)' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--wd-muted)' }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent incidentRanges={incidentRanges} />}
                    cursor={{ stroke: 'var(--wd-border)', strokeWidth: 1 }}
                  />
                  <Area
                    dataKey="avg"
                    stroke="var(--wd-primary)"
                    strokeWidth={2}
                    fill="url(#incidentChartGrad)"
                    fillOpacity={1}
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                  <ForegroundReferenceArea ranges={incidentRanges} />
                  <ChartEventMarkers
                    timeline={incident.timeline ?? []}
                    chartPoints={chartData}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {/* Status strip — one coloured cell per check so outages stay
                visible even when the latency line is flat at 0. */}
            <ChartStatusStrip points={chartData} />
          </div>

          {/* Impact Analysis — 1/3 */}
          <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex flex-col">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-foreground">Impact Analysis</h2>
              <p className="text-[11px] text-wd-muted mt-0.5">
                Stats from checks during the incident only
              </p>
            </div>

            {impact ? (
              <div className="flex-1 flex flex-col gap-5">
                {/* Latency stats */}
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-wd-muted mb-2.5">
                    Response Time
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <LatencyStat label="Min" value={impact.min} tone="success" />
                    <LatencyStat label="Avg" value={impact.avg} tone="primary" />
                    <LatencyStat label="P95" value={impact.p95} tone="warning" />
                    <LatencyStat label="Max" value={impact.max} tone="danger" />
                  </div>
                </div>

                {/* Status distribution */}
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-wd-muted mb-2.5">
                    Status Distribution
                  </div>
                  <StatusBar
                    healthy={impact.counts.healthy}
                    degraded={impact.counts.degraded}
                    down={impact.counts.down}
                  />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center text-[11px] text-wd-muted px-4">
                No checks recorded during the incident yet
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* Timeline */}
      {/* ------------------------------------------------------------------- */}
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Event Timeline</h2>
            <p className="text-[11px] text-wd-muted mt-0.5">
              {displayRows.length === 0
                ? 'Events will appear as they happen'
                : `${displayRows.length} event${displayRows.length === 1 ? '' : 's'} · click to expand`}
            </p>
          </div>
        </div>

        {displayRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-wd-muted">
            <Icon icon="solar:history-linear" width={28} />
            <p className="text-sm">No timeline events recorded.</p>
          </div>
        ) : (
          <div className="relative">
            {/* Vertical connector line */}
            <div className="absolute left-[18px] top-3 bottom-3 w-px bg-wd-border/50" />

            <div className="space-y-0">
              {displayRows.map((row, i) => (
                <TimelineRowView
                  key={row.key}
                  row={row}
                  isLast={i === displayRows.length - 1}
                  expandedRowKey={expandedRowKey}
                  setExpandedRowKey={setExpandedRowKey}
                  incident={incident}
                  duration={duration}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Related Incidents — same endpoint, last 7 days */}
      {/* ------------------------------------------------------------------- */}
      {relatedIncidents && relatedIncidents.length > 0 && (
        <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-foreground">Related Incidents</h2>
            <p className="text-[11px] text-wd-muted mt-0.5">
              Other incidents on this endpoint in the last 7 days · recurring patterns matter
            </p>
          </div>
          <div className="space-y-1.5">
            {relatedIncidents.slice(0, 5).map((r) => (
              <RelatedIncidentRow key={r._id} incident={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI strip helpers
// ---------------------------------------------------------------------------

type KpiTone = 'primary' | 'success' | 'warning' | 'danger' | 'muted'

const TONE_CLASSES: Record<KpiTone, { bg: string; text: string }> = {
  primary: { bg: 'bg-wd-primary/10', text: 'text-wd-primary' },
  success: { bg: 'bg-wd-success/10', text: 'text-wd-success' },
  warning: { bg: 'bg-wd-warning/10', text: 'text-wd-warning' },
  danger: { bg: 'bg-wd-danger/10', text: 'text-wd-danger' },
  muted: { bg: 'bg-wd-surface-hover', text: 'text-wd-muted' },
}

function KpiCell({
  icon,
  tone,
  label,
  value,
}: {
  icon: string
  tone: KpiTone
  label: string
  value: string
}) {
  const t = TONE_CLASSES[tone]
  return (
    <div className="flex items-center gap-2">
      <div className={cn('rounded-lg p-1.5', t.bg)}>
        <Icon icon={icon} width={16} className={t.text} />
      </div>
      <div>
        <div className="text-[10px] text-wd-muted">{label}</div>
        <div className="text-sm font-semibold text-foreground font-mono">{value}</div>
      </div>
    </div>
  )
}

function KpiDivider() {
  return <div className="w-px h-8 bg-wd-border/50" />
}

// ---------------------------------------------------------------------------
// Impact Analysis helpers
// ---------------------------------------------------------------------------

function LatencyStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: KpiTone
}) {
  const t = TONE_CLASSES[tone]
  return (
    <div className="rounded-lg border border-wd-border/40 bg-wd-surface-hover/30 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', t.bg.replace('/10', ''))} />
        <span className="text-[10px] font-medium uppercase tracking-wider text-wd-muted">
          {label}
        </span>
      </div>
      <div className="mt-1 text-base font-semibold text-foreground font-mono">
        {value}
        <span className="text-[11px] font-normal text-wd-muted ml-0.5">ms</span>
      </div>
    </div>
  )
}

function StatusBar({
  healthy,
  degraded,
  down,
}: {
  healthy: number
  degraded: number
  down: number
}) {
  const total = healthy + degraded + down
  const healthyPct = total > 0 ? (healthy / total) * 100 : 0
  const degradedPct = total > 0 ? (degraded / total) * 100 : 0
  const downPct = total > 0 ? (down / total) * 100 : 0

  return (
    <>
      {/* Stacked bar */}
      <div className="flex h-2 overflow-hidden rounded-full bg-wd-surface-hover">
        {healthyPct > 0 && (
          <div className="bg-wd-success" style={{ width: `${healthyPct}%` }} />
        )}
        {degradedPct > 0 && (
          <div className="bg-wd-warning" style={{ width: `${degradedPct}%` }} />
        )}
        {downPct > 0 && (
          <div className="bg-wd-danger" style={{ width: `${downPct}%` }} />
        )}
      </div>
      {/* Legend */}
      <div className="mt-3 space-y-1.5">
        <StatusLegendRow dotClass="bg-wd-success" label="Healthy" count={healthy} total={total} />
        <StatusLegendRow dotClass="bg-wd-warning" label="Degraded" count={degraded} total={total} />
        <StatusLegendRow dotClass="bg-wd-danger" label="Down" count={down} total={total} />
      </div>
    </>
  )
}

function StatusLegendRow({
  dotClass,
  label,
  count,
  total,
}: {
  dotClass: string
  label: string
  count: number
  total: number
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="flex items-center justify-between text-[11px]">
      <div className="flex items-center gap-1.5 text-wd-muted">
        <span className={cn('h-2 w-2 rounded-full', dotClass)} />
        {label}
      </div>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-foreground font-medium">{count}</span>
        <span className="text-wd-muted/70 w-[32px] text-right">{pct}%</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline expansion helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize',
        status === 'down'
          ? 'bg-wd-danger/15 text-wd-danger'
          : status === 'degraded'
            ? 'bg-wd-warning/15 text-wd-warning'
            : 'bg-wd-success/15 text-wd-success',
      )}
    >
      {status}
    </span>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 items-baseline">
      <span className="text-[10px] font-medium uppercase tracking-wider text-wd-muted">
        {label}
      </span>
      <span
        className={cn(
          'text-xs text-foreground break-all',
          mono && 'font-mono',
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** Renders a detail grid for either an ApiCheck (persisted, has _id) or a
 *  live CheckPoint (SSE-derived, no _id, only core fields). */
function CheckDetailGrid({ check }: { check: CheckPoint | ApiCheck }) {
  const asApi = 'duringMaintenance' in check ? check : undefined
  return (
    <div className="space-y-2">
      {check._id ? (
        <DetailRow label="Check ID" value={check._id} mono />
      ) : (
        <DetailRow label="Source" value="Live (SSE)" />
      )}
      <DetailRow label="Timestamp" value={new Date(check.timestamp).toLocaleString()} mono />
      <DetailRow label="Status" value={check.status} />
      <DetailRow label="Response Time" value={`${check.responseTime}ms`} mono />
      {check.statusCode != null && (
        <DetailRow label="Status Code" value={String(check.statusCode)} mono />
      )}
      {asApi?.portOpen != null && (
        <DetailRow label="Port Open" value={asApi.portOpen ? 'Yes' : 'No'} />
      )}
      {asApi?.statusReason && <DetailRow label="Reason" value={asApi.statusReason} />}
      {asApi?.sslDaysRemaining != null && (
        <DetailRow label="SSL Days" value={String(asApi.sslDaysRemaining)} mono />
      )}
      {asApi?.duringMaintenance && (
        <DetailRow label="Maintenance" value="During maintenance window" />
      )}
      {check.errorMessage && (
        <div className="mt-2 rounded-md bg-wd-danger/5 border border-wd-danger/10 px-2.5 py-1.5">
          <span className="text-[10px] font-medium text-wd-danger uppercase tracking-wider">
            Error
          </span>
          <p className="text-xs text-wd-danger/80 mt-0.5 break-all">{check.errorMessage}</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline row view (pulled out so the main render body stays readable)
// ---------------------------------------------------------------------------

function TimelineRowView({
  row,
  isLast,
  expandedRowKey,
  setExpandedRowKey,
  incident,
  duration,
}: {
  row: TimelineRow
  isLast: boolean
  expandedRowKey: string | null
  setExpandedRowKey: (k: string | null) => void
  incident: ApiIncident
  duration: number
}) {
  const isExpanded = expandedRowKey === row.key
  const isPhaseMarker = row.event === 'opened' || row.event === 'resolved'
  const isGroup = row.event === 'check-group'

  const canExpand =
    row.event === 'check' ||
    row.event === 'opened' ||
    row.event === 'resolved' ||
    isGroup ||
    !!row.detail

  // For standalone check rows that don't have a full CheckPoint attached,
  // fall back to parsing the detail string for display.
  const parsed =
    row.event === 'check' && !row.check ? parseCheckDetail(row.detail) : null

  // For group rows, pull status/code/error off the first member — they're
  // all identical by construction.
  const groupRep = isGroup ? row.groupMembers?.[0]?.check : undefined
  const groupParsed = isGroup && !groupRep
    ? parseCheckDetail(row.groupMembers?.[0]?.detail)
    : null
  const groupStatus = groupRep?.status ?? groupParsed?.status ?? 'down'

  const meta = isGroup
    ? timelineMeta('check', groupStatus)
    : timelineMeta(row.event, row.detail ?? row.check?.status)
  const badgeLabel =
    row.badge === 'trigger'
      ? 'Trigger'
      : row.badge === 'recovery'
        ? 'Recovery'
        : null

  const relative = formatRelativeFromAnchor(row.at, incident.startedAt)

  return (
    <div className={cn('relative flex gap-3.5', !isLast && 'pb-4')}>
      {/* Icon column — 36px wide so connector line stays centered */}
      <div className="relative z-10 flex w-[36px] shrink-0 justify-center pt-0.5">
        <div
          className={cn(
            'flex items-center justify-center rounded-lg border transition-all',
            isPhaseMarker
              ? 'h-[36px] w-[36px] ring-2 ring-wd-primary/20'
              : 'h-[28px] w-[28px]',
            meta.tileBg,
          )}
        >
          <Icon
            icon={isGroup ? 'solar:layers-minimalistic-linear' : meta.icon}
            width={isPhaseMarker ? 16 : 14}
            className={meta.iconColor}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          disabled={!canExpand}
          onClick={() => {
            if (canExpand) setExpandedRowKey(isExpanded ? null : row.key)
          }}
          className={cn(
            'w-full text-left rounded-md -ml-1 px-1 py-0.5',
            canExpand && 'hover:bg-wd-surface-hover/50 cursor-pointer transition-colors',
            !canExpand && 'cursor-default',
          )}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'text-sm text-foreground',
                isPhaseMarker ? 'font-semibold' : 'font-medium',
              )}
            >
              {isGroup
                ? `${row.groupMembers?.length ?? 0} checks (same result)`
                : humanEvent(row.event)}
            </span>
            {badgeLabel && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                  row.badge === 'trigger'
                    ? 'bg-wd-danger/10 text-wd-danger'
                    : 'bg-wd-success/10 text-wd-success',
                )}
              >
                {badgeLabel}
              </span>
            )}
            <span className="text-[11px] text-wd-muted font-mono">
              {formatDateTime(row.at)}
            </span>
            {!isPhaseMarker && (
              <span className="text-[10px] font-mono text-wd-muted/70">
                {relative}
              </span>
            )}
            {canExpand && (
              <Icon
                icon="solar:alt-arrow-down-linear"
                width={16}
                className={cn(
                  'ml-auto text-wd-muted/60 transition-transform duration-150',
                  isExpanded && 'rotate-180',
                )}
              />
            )}
          </div>

          {/* Collapsed summary line */}
          {!isExpanded && (
            <>
              {/* Group summary */}
              {isGroup && row.groupMembers && row.groupStats && (() => {
                const groupCode = groupRep?.statusCode ?? groupParsed?.statusCode
                return (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <StatusBadge status={groupStatus} />
                  {groupCode != null && (
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium font-mono',
                        statusCodeColor(groupCode),
                      )}
                    >
                      {groupCode}
                    </span>
                  )}
                  <span className="text-[11px] text-wd-muted font-mono">
                    {row.groupStats.min === row.groupStats.max
                      ? `${row.groupStats.avg}ms`
                      : `${row.groupStats.min}–${row.groupStats.max}ms · avg ${row.groupStats.avg}ms`}
                  </span>
                  <span className="text-[11px] text-wd-muted/80">
                    ·{' '}
                    {new Date(row.groupMembers[0].at).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' – '}
                    {new Date(
                      row.groupMembers[row.groupMembers.length - 1].at,
                    ).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                )
              })()}

              {/* Standalone check with a full CheckPoint */}
              {row.event === 'check' && row.check && (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <StatusBadge status={row.check.status} />
                  {row.check.statusCode != null && (
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium font-mono',
                        statusCodeColor(row.check.statusCode),
                      )}
                    >
                      {row.check.statusCode}
                    </span>
                  )}
                  <span className="text-[11px] text-wd-muted font-mono">
                    {row.check.responseTime}ms
                  </span>
                </div>
              )}

              {/* Standalone check without CheckPoint — parse detail string */}
              {row.event === 'check' && !row.check && row.detail && (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {parsed?.status && <StatusBadge status={parsed.status} />}
                  {parsed?.statusCode && (
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium font-mono',
                        statusCodeColor(parsed.statusCode),
                      )}
                    >
                      {parsed.statusCode}
                    </span>
                  )}
                  {parsed?.responseTime && (
                    <span className="text-[11px] text-wd-muted font-mono">
                      {parsed.responseTime}
                    </span>
                  )}
                  {!parsed?.status && !parsed?.statusCode && !parsed?.responseTime && (
                    <span className="text-xs text-wd-muted">{row.detail}</span>
                  )}
                </div>
              )}

              {/* Non-check event detail */}
              {row.event !== 'check' && !isGroup && row.detail && (
                <p className="text-xs text-wd-muted mt-1">{row.detail}</p>
              )}
            </>
          )}
        </button>

        {/* Expanded panel */}
        {isExpanded && (
          <div className="mt-2 rounded-lg border border-wd-border/40 bg-wd-surface-hover/30 px-3 py-2.5">
            {isGroup && row.groupMembers ? (
              <div className="space-y-1.5">
                <p className="text-[11px] text-wd-muted mb-2">
                  {row.groupMembers.length} consecutive checks with identical results.
                </p>
                {row.groupMembers.map((m) => (
                  <div
                    key={m.key}
                    className="flex items-center gap-2 text-[11px] rounded px-2 py-1 bg-wd-surface/50"
                  >
                    <span className="text-wd-muted font-mono w-[90px] shrink-0">
                      {new Date(m.at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                    <span className="text-wd-muted/70 font-mono text-[10px] w-[64px] shrink-0">
                      {formatRelativeFromAnchor(m.at, incident.startedAt)}
                    </span>
                    {m.check?.statusCode != null && (
                      <span
                        className={cn(
                          'inline-flex items-center rounded px-1.5 py-0.5 font-medium font-mono',
                          statusCodeColor(m.check.statusCode),
                        )}
                      >
                        {m.check.statusCode}
                      </span>
                    )}
                    <span className="text-wd-muted font-mono">
                      {m.check?.responseTime ?? '—'}ms
                    </span>
                    {m.check?.errorMessage && (
                      <span className="text-wd-danger/80 truncate">
                        {m.check.errorMessage}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : row.event === 'check' && row.check ? (
              <CheckDetailGrid check={row.check} />
            ) : row.event === 'check' && !row.check ? (
              <div className="text-[11px] text-wd-muted">
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {parsed?.status && <StatusBadge status={parsed.status} />}
                  {parsed?.statusCode && (
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium font-mono',
                        statusCodeColor(parsed.statusCode),
                      )}
                    >
                      {parsed.statusCode}
                    </span>
                  )}
                  {parsed?.responseTime && (
                    <span className="text-[11px] text-foreground font-mono">
                      {parsed.responseTime}
                    </span>
                  )}
                </div>
                <p>{row.detail}</p>
                <p className="mt-2 text-[10px] text-wd-muted/70">
                  Full check data is outside the loaded window.
                </p>
              </div>
            ) : row.event === 'opened' ? (
              <div className="space-y-2">
                <DetailRow label="Cause" value={humanCause(incident.cause)} />
                {incident.causeDetail && (
                  <DetailRow label="Detail" value={incident.causeDetail} />
                )}
                <DetailRow label="Started" value={formatDateTime(incident.startedAt)} mono />
              </div>
            ) : row.event === 'resolved' ? (
              <div className="space-y-2">
                <DetailRow
                  label="Resolved"
                  value={incident.resolvedAt ? formatDateTime(incident.resolvedAt) : '—'}
                  mono
                />
                <DetailRow
                  label="Total Duration"
                  value={
                    incident.durationSeconds != null
                      ? formatDuration(incident.durationSeconds)
                      : formatDuration(duration)
                  }
                  mono
                />
                {row.detail && <DetailRow label="Note" value={row.detail} />}
              </div>
            ) : (
              <p className="text-xs text-wd-muted">{row.detail}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart overlay: vertical markers for notification_sent / escalated events
// ---------------------------------------------------------------------------

interface ChartPoint {
  label: string
  avg: number
  fails: number
  degraded: number
  status: 'healthy' | 'degraded' | 'down'
  at: string
}

function ChartEventMarkers({
  timeline,
  chartPoints,
}: {
  timeline: IncidentTimelineEvent[]
  chartPoints: ChartPoint[]
}) {
  const xScale = useXAxisScale()
  const plotArea = usePlotArea()

  if (!xScale || !plotArea || chartPoints.length === 0 || timeline.length === 0) return null

  // Build sorted timestamps from chartPoints for nearest-match lookups.
  const chartTs = chartPoints.map((p) => new Date(p.at).getTime())

  const markers: { label: string; event: string; at: string }[] = []
  for (const evt of timeline) {
    if (evt.event !== 'notification_sent' && evt.event !== 'escalated' && evt.event !== 'acknowledged') {
      continue
    }
    const target = new Date(evt.at).getTime()
    const idx = nearestIndexByTimestamp(chartTs, target)
    if (idx < 0) continue
    const atStr = typeof evt.at === 'string' ? evt.at : new Date(evt.at).toISOString()
    markers.push({ label: chartPoints[idx].label, event: evt.event, at: atStr })
  }

  if (markers.length === 0) return null

  const iconForEvent = (ev: string) => {
    if (ev === 'notification_sent') return 'solar:bell-bold'
    if (ev === 'escalated') return 'solar:double-alt-arrow-up-bold'
    return 'solar:user-check-bold'
  }
  const colorForEvent = (ev: string) =>
    ev === 'escalated' ? 'var(--wd-danger)' : 'var(--wd-warning)'

  return (
    <g className="chart-event-markers">
      {markers.map((m, i) => {
        const x = xScale(m.label)
        if (x == null || isNaN(x)) return null
        const xN = x
        const top = plotArea.y
        const height = plotArea.height
        const color = colorForEvent(m.event)
        return (
          <g key={`evt-${i}`}>
            <line
              x1={xN}
              y1={top}
              x2={xN}
              y2={top + height}
              stroke={color}
              strokeWidth={1.2}
              strokeDasharray="2 3"
              strokeOpacity={0.7}
            />
            {/* Icon above the line */}
            <foreignObject x={xN - 10} y={top - 3} width={20} height={20}>
              <div
                style={{
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--wd-surface)',
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                }}
              >
                <Icon icon={iconForEvent(m.event)} width={16} style={{ color }} />
              </div>
            </foreignObject>
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Chart status strip — one coloured cell per chart point
// ---------------------------------------------------------------------------

function ChartStatusStrip({ points }: { points: ChartPoint[] }) {
  if (points.length === 0) return null
  // Padding matches the AreaChart: 40px left (YAxis width) + 12px right (margin).
  return (
    <div
      className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-wd-surface-hover"
      style={{ marginLeft: 40, marginRight: 12 }}
      aria-label="Status per check"
    >
      {points.map((p, i) => (
        <div
          key={i}
          className={cn(
            'h-full',
            p.status === 'down'
              ? 'bg-wd-danger'
              : p.status === 'degraded'
                ? 'bg-wd-warning'
                : 'bg-wd-success',
          )}
          style={{ flex: 1 }}
          title={`${p.label} · ${p.status}`}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Related incident row
// ---------------------------------------------------------------------------

function RelatedIncidentRow({ incident }: { incident: ApiIncident }) {
  const active = incident.status === 'active'
  const durationSeconds =
    incident.durationSeconds ??
    Math.floor((Date.now() - new Date(incident.startedAt).getTime()) / 1000)
  const severity = severityFromCause(incident.cause)
  return (
    <Link
      to={`/incidents/${incident._id}`}
      className="flex items-center gap-3 rounded-lg border border-wd-border/30 bg-wd-surface-hover/20 hover:bg-wd-surface-hover/50 px-3 py-2.5 transition-colors"
    >
      {active ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-wd-danger/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-wd-danger shrink-0">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
          </span>
          Active
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-wd-success/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-wd-success shrink-0">
          <Icon icon="solar:check-circle-bold" width={16} />
          Resolved
        </span>
      )}
      <span className="text-sm font-medium text-foreground truncate">
        {humanCause(incident.cause)}
      </span>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
          severity.tone === 'danger'
            ? 'bg-wd-danger/10 text-wd-danger'
            : severity.tone === 'warning'
              ? 'bg-wd-warning/10 text-wd-warning'
              : 'bg-wd-surface-hover text-wd-muted',
        )}
      >
        {severity.label}
      </span>
      <span className="ml-auto text-[11px] text-wd-muted font-mono">
        {formatDuration(durationSeconds)}
      </span>
      <span className="text-[11px] text-wd-muted min-w-[140px] text-right font-mono">
        {formatDateTime(incident.startedAt)}
      </span>
    </Link>
  )
}
