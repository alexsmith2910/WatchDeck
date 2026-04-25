/**
 * Incidents page — composes the live hero strip, KPI row, trends extras, and
 * the history table. The page itself is a thin orchestrator: data fetching
 * and SSE wiring live here, while all rendering lives in small components
 * under `components/incidents/`.
 *
 * Two fetches drive everything:
 *   1. `/incidents/active` — always fresh, powers the hero strip.
 *   2. `/incidents?from=<14d>&status=…&endpointId=…` — paginated history that
 *      feeds KPIs, trends, and the table. The table's status/range/endpoint
 *      filters round-trip here; severity/cause/search filter in-memory.
 *
 * SSE keeps both lists live: `incident:opened` prepends, `incident:resolved`
 * moves an incident from active → history with the resolved timestamp and
 * duration applied.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type {
  ApiCheck,
  ApiEndpoint,
  ApiIncident,
  ApiPagination,
  IncidentStats,
} from '../types/api'
import type { ApiChannel } from '../types/notifications'
import { IncidentHero, type HeroEndpointState } from '../components/incidents/IncidentHero'
import { IncidentKpis } from '../components/incidents/IncidentKpis'
import { IncidentExtras } from '../components/incidents/IncidentExtras'
import {
  DEFAULT_FILTERS,
  IncidentsTable,
  type IncidentFilters,
  type TimeRange,
} from '../components/incidents/IncidentsTable'
import type { EndpointLite, EndpointSparkline } from '../components/incidents/incidentHelpers'

interface IncidentOpenedEvent {
  timestamp: string
  incident: ApiIncident
}
interface IncidentResolvedEvent {
  timestamp: string
  incidentId: string
  durationSeconds: number
}

const DAY_MS = 86_400_000
const HISTORY_BASE_WINDOW_MS = 14 * DAY_MS
const PAGE_SIZE = 30

function rangeToMs(range: TimeRange): number | null {
  switch (range) {
    case '24h': return DAY_MS
    case '7d':  return 7 * DAY_MS
    case '30d': return 30 * DAY_MS
    case 'all': return null
  }
}

function historyFromISO(range: TimeRange): string | undefined {
  const ms = rangeToMs(range)
  // Always fetch at least 14 days so KPIs and trend charts have a full window,
  // even when the user narrows the table to 24h.
  const windowMs = ms === null ? null : Math.max(ms, HISTORY_BASE_WINDOW_MS)
  if (windowMs === null) return undefined
  return new Date(Date.now() - windowMs).toISOString()
}

export default function IncidentsPage() {
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [filters, setFilters] = useState<IncidentFilters>(DEFAULT_FILTERS)
  const [activeIncidents, setActiveIncidents] = useState<ApiIncident[]>([])
  const [historyIncidents, setHistoryIncidents] = useState<ApiIncident[]>([])
  const [stats, setStats] = useState<IncidentStats | null>(null)
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [channels, setChannels] = useState<ApiChannel[]>([])
  // Keyed by incident _id so each row/hero card shows response times from the
  // window of its own incident (startedAt → resolvedAt, plus a small buffer on
  // either side for context) rather than the most recent N checks for the
  // endpoint — which made every incident on the same endpoint look identical.
  const [sparklineByIncidentId, setSparklineByIncidentId] = useState<Map<string, EndpointSparkline>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now())

  const endpointById = useMemo<Map<string, EndpointLite>>(() => {
    const m = new Map<string, EndpointLite>()
    for (const ep of endpoints) {
      m.set(ep.id, {
        id: ep.id,
        name: ep.name,
        type: ep.type,
        url: ep.url,
        host: ep.host,
        port: ep.port,
        notificationChannelIds: ep.notificationChannelIds ?? [],
      })
    }
    return m
  }, [endpoints])

  const endpointStateById = useMemo<Map<string, HeroEndpointState>>(() => {
    const m = new Map<string, HeroEndpointState>()
    for (const ep of endpoints) {
      m.set(ep.id, {
        lastStatus: ep.lastStatus,
        lastStatusCode: ep.lastStatusCode,
        lastResponseTime: ep.lastResponseTime,
        lastCheckAt: ep.lastCheckAt,
        notificationChannelIds: ep.notificationChannelIds ?? [],
      })
    }
    return m
  }, [endpoints])

  const channelById = useMemo<Map<string, ApiChannel>>(() => {
    const m = new Map<string, ApiChannel>()
    for (const c of channels) m.set(c.id, c)
    return m
  }, [channels])

  // ---- Fetch endpoints once ----
  useEffect(() => {
    let cancelled = false
    request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=200')
      .then((res) => {
        if (!cancelled) setEndpoints(res.data.data ?? [])
      })
      .catch(() => { /* transient — next mount will retry */ })
    return () => { cancelled = true }
  }, [request])

  // ---- Fetch notification channels once ----
  useEffect(() => {
    let cancelled = false
    request<{ data: ApiChannel[] }>('/notifications/channels')
      .then((res) => {
        if (!cancelled) setChannels(res.data.data ?? [])
      })
      .catch(() => { /* transient — next mount will retry */ })
    return () => { cancelled = true }
  }, [request])

  // ---- Fetch per-incident sparkline data ----
  // Fetches one sparkline per incident, scoped to the incident's own window
  // (startedAt → resolvedAt, plus a buffer on either side) so the graph
  // reflects response times *during that incident* rather than the most
  // recent N checks on the endpoint — which made every incident on the same
  // endpoint show an identical graph.
  //
  // The cache is keyed by incidentId alone; a `Set` of already-fetched
  // "versions" (incident id + status + resolvedAt) drives re-fetching when an
  // active incident transitions to resolved, without ever creating a
  // render-loop even though the effect depends on the incident arrays.
  const SPARK_BUFFER_MS = 15 * 60 * 1000 // 15 min before/after for context
  const SPARK_LIMIT = 60

  const fetchedVersionsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const seen = new Map<string, ApiIncident>()
    for (const i of activeIncidents) seen.set(i.id, i)
    for (const i of historyIncidents) if (!seen.has(i.id)) seen.set(i.id, i)
    if (seen.size === 0) return

    const missing: ApiIncident[] = []
    for (const inc of seen.values()) {
      const version = `${inc.id}:${inc.status}:${inc.resolvedAt ?? ''}`
      if (!fetchedVersionsRef.current.has(version)) {
        fetchedVersionsRef.current.add(version)
        missing.push(inc)
      }
    }
    if (missing.length === 0) return

    let cancelled = false
    Promise.all(
      missing.map(async (inc) => {
        const startMs = new Date(inc.startedAt).getTime() - SPARK_BUFFER_MS
        const endMs = inc.resolvedAt
          ? new Date(inc.resolvedAt).getTime() + SPARK_BUFFER_MS
          : Date.now()
        const params = new URLSearchParams()
        params.set('limit', String(SPARK_LIMIT))
        params.set('from', new Date(startMs).toISOString())
        params.set('to', new Date(endMs).toISOString())
        const res = await request<{ data: ApiCheck[]; pagination: ApiPagination }>(
          `/endpoints/${inc.endpointId}/checks?${params.toString()}`,
        )
        // API returns newest first; reverse so the sparkline reads left→right
        // and timestamps line up with values index-for-index.
        const checks = (res.data.data ?? [])
          .filter((c) => typeof c.responseTime === 'number')
          .reverse()
        const sparkline: EndpointSparkline = {
          values: checks.map((c) => c.responseTime),
          timestamps: checks.map((c) => c.timestamp),
        }
        return [inc.id, sparkline] as const
      }),
    )
      .then((entries) => {
        if (cancelled) return
        setSparklineByIncidentId((prev) => {
          const next = new Map(prev)
          for (const [id, sl] of entries) next.set(id, sl)
          return next
        })
      })
      .catch(() => { /* sparklines are non-critical */ })
    return () => { cancelled = true }
  }, [activeIncidents, historyIncidents, request])

  // ---- Fetch active incidents ----
  const fetchActive = useCallback(async () => {
    const res = await request<{ data: ApiIncident[] }>('/incidents/active')
    setActiveIncidents(res.data.data ?? [])
  }, [request])

  // ---- Fetch history page ----
  const buildHistoryQuery = useCallback(
    (cursor?: string | null) => {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      if (filters.status === 'active') {
        params.set('status', 'active')
      } else if (filters.status === 'resolved') {
        params.set('status', 'resolved')
      }
      if (filters.endpointId !== 'all') params.set('endpointId', filters.endpointId)
      const from = historyFromISO(filters.range)
      if (from) params.set('from', from)
      if (cursor) params.set('cursor', cursor)
      return params.toString()
    },
    [filters.status, filters.endpointId, filters.range],
  )

  const fetchHistory = useCallback(
    async (cursor?: string | null) => {
      const qs = buildHistoryQuery(cursor)
      const res = await request<{ data: ApiIncident[]; pagination: ApiPagination }>(
        `/incidents?${qs}`,
      )
      return {
        items: res.data.data ?? [],
        pagination: res.data.pagination,
      }
    },
    [request, buildHistoryQuery],
  )

  // ---- Fetch pre-aggregated stats ----
  // Window is the wider of the user's range and 14 days so the Volume chart
  // always has its full window regardless of the table filter. `all` falls
  // back to 365 days as a sane upper bound.
  const fetchStats = useCallback(async () => {
    const ms = rangeToMs(filters.range)
    const windowMs = ms === null ? 365 * DAY_MS : Math.max(ms, HISTORY_BASE_WINDOW_MS)
    const params = new URLSearchParams()
    params.set('from', new Date(Date.now() - windowMs).toISOString())
    if (filters.endpointId !== 'all') params.set('endpointId', filters.endpointId)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz) params.set('tz', tz)
    } catch {
      // falls back to UTC
    }
    const res = await request<{ data: IncidentStats }>(
      `/incidents/stats?${params.toString()}`,
    )
    if (res.status < 400) setStats(res.data.data)
  }, [filters.range, filters.endpointId, request])

  // Reload first page whenever round-trip filters change.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([fetchActive(), fetchHistory(), fetchStats()])
      .then(([, page]) => {
        if (cancelled) return
        setHistoryIncidents(page.items)
        setHasMore(page.pagination?.hasMore ?? false)
        setNextCursor(page.pagination?.nextCursor ?? null)
        setLastUpdatedAt(Date.now())
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchActive, fetchHistory, fetchStats])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) return
    setLoadingMore(true)
    try {
      const page = await fetchHistory(nextCursor)
      setHistoryIncidents((prev) => {
        const seen = new Set(prev.map((i) => i.id))
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))]
      })
      setHasMore(page.pagination?.hasMore ?? false)
      setNextCursor(page.pagination?.nextCursor ?? null)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, nextCursor, fetchHistory])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // Drop cached "active" sparkline versions so the per-incident effect
      // refetches them with a fresh window. Resolved incidents are stable and
      // can stay cached.
      for (const v of fetchedVersionsRef.current) {
        if (v.includes(':active:')) fetchedVersionsRef.current.delete(v)
      }
      const [, page] = await Promise.all([fetchActive(), fetchHistory(), fetchStats()])
      setHistoryIncidents(page.items)
      setHasMore(page.pagination?.hasMore ?? false)
      setNextCursor(page.pagination?.nextCursor ?? null)
      setLastUpdatedAt(Date.now())
    } finally {
      setRefreshing(false)
    }
  }, [fetchActive, fetchHistory, fetchStats])

  // ---- SSE subscriptions ----
  useEffect(() => {
    return subscribe('incident:opened', (raw) => {
      const evt = raw as IncidentOpenedEvent
      setActiveIncidents((prev) => [
        evt.incident,
        ...prev.filter((i) => i.id !== evt.incident.id),
      ])
      setHistoryIncidents((prev) => [
        evt.incident,
        ...prev.filter((i) => i.id !== evt.incident.id),
      ])
      setLastUpdatedAt(Date.now())
      void fetchStats()
    })
  }, [subscribe, fetchStats])

  useEffect(() => {
    return subscribe('incident:resolved', (raw) => {
      const evt = raw as IncidentResolvedEvent
      setActiveIncidents((prev) => prev.filter((i) => i.id !== evt.incidentId))
      setHistoryIncidents((prev) =>
        prev.map((i) =>
          i.id === evt.incidentId
            ? {
                ...i,
                status: 'resolved' as const,
                resolvedAt: evt.timestamp,
                durationSeconds: evt.durationSeconds,
              }
            : i,
        ),
      )
      setLastUpdatedAt(Date.now())
      void fetchStats()
    })
  }, [subscribe, fetchStats])

  const onFiltersChange = useCallback((patch: Partial<IncidentFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
  }, [])

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Incidents</h1>
          <div className="text-xs text-wd-muted mt-1">
            Live view of active outages, MTTR, and the full incident history across your endpoints.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onPress={() => void refresh()}
            isDisabled={refreshing || loading}
          >
            <Icon
              icon="solar:refresh-outline"
              width={16}
              className={cn(refreshing && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>

      {loading && historyIncidents.length === 0 ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* Hero strip (or "All clear" banner) */}
          <IncidentHero
            activeIncidents={activeIncidents}
            endpointById={endpointById}
            endpointStateById={endpointStateById}
            channelById={channelById}
            sparklineByIncidentId={sparklineByIncidentId}
            lastUpdatedAt={lastUpdatedAt}
          />

          {/* KPI row */}
          <IncidentKpis
            activeIncidents={activeIncidents}
            stats={stats}
          />

          {/* Trends & causes */}
          <SectionHead title="Trends & causes" hint="Derived from the last 14 days" />
          <IncidentExtras
            stats={stats}
            endpointById={endpointById}
          />

          {/* History table */}
          <SectionHead title="History" hint="Filter, search, and drill into any incident" />
          <IncidentsTable
            incidents={historyIncidents}
            activeIncidents={activeIncidents}
            endpointById={endpointById}
            channelById={channelById}
            sparklineByIncidentId={sparklineByIncidentId}
            filters={filters}
            onFiltersChange={onFiltersChange}
            loading={false}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={() => void loadMore()}
          />
        </>
      )}

      <div className="h-2" />
    </div>
  )
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2">
      <h2 className="text-[13px] font-semibold text-foreground uppercase tracking-wider">{title}</h2>
      {hint && <span className="text-[11px] text-wd-muted">{hint}</span>}
    </div>
  )
}
