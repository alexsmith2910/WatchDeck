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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type { ApiCheck, ApiEndpoint, ApiIncident, ApiPagination } from '../types/api'
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
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [channels, setChannels] = useState<ApiChannel[]>([])
  const [sparklineByEndpointId, setSparklineByEndpointId] = useState<Map<string, EndpointSparkline>>(
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
      m.set(ep._id, {
        _id: ep._id,
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
      m.set(ep._id, {
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
    for (const c of channels) m.set(c._id, c)
    return m
  }, [channels])

  // ---- Fetch endpoints once ----
  useEffect(() => {
    let cancelled = false
    request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=200').then(
      (res) => {
        if (!cancelled) setEndpoints(res.data.data ?? [])
      },
    )
    return () => { cancelled = true }
  }, [request])

  // ---- Fetch notification channels once ----
  useEffect(() => {
    let cancelled = false
    request<{ data: ApiChannel[] }>('/notifications/channels').then((res) => {
      if (!cancelled) setChannels(res.data.data ?? [])
    })
    return () => { cancelled = true }
  }, [request])

  // ---- Fetch sparkline data for every endpoint visible on the page ----
  // Keyed by endpointId (not incidentId) so two incidents on the same endpoint
  // share one fetch. Covers active incidents (hero strip) AND history rows
  // (table column). We only fetch for endpoints we don't already have a
  // sparkline for, so paginating through history doesn't refetch the world.
  const visibleEndpointKey = useMemo(
    () =>
      [
        ...new Set([
          ...activeIncidents.map((i) => i.endpointId),
          ...historyIncidents.map((i) => i.endpointId),
        ]),
      ]
        .sort()
        .join(','),
    [activeIncidents, historyIncidents],
  )
  useEffect(() => {
    if (!visibleEndpointKey) return
    const epIds = visibleEndpointKey.split(',').filter(Boolean)
    const missing = epIds.filter((id) => !sparklineByEndpointId.has(id))
    if (missing.length === 0) return
    let cancelled = false
    Promise.all(
      missing.map(async (id) => {
        const res = await request<{ data: ApiCheck[]; pagination: ApiPagination }>(
          `/endpoints/${id}/checks?limit=30`,
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
        return [id, sparkline] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      setSparklineByEndpointId((prev) => {
        const next = new Map(prev)
        for (const [id, sl] of entries) next.set(id, sl)
        return next
      })
    })
    return () => { cancelled = true }
  }, [visibleEndpointKey, sparklineByEndpointId, request])

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
      if (filters.status === 'active' || filters.status === 'acked') {
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

  // Reload first page whenever round-trip filters change.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([fetchActive(), fetchHistory()]).then(([, page]) => {
      if (cancelled) return
      setHistoryIncidents(page.items)
      setHasMore(page.pagination?.hasMore ?? false)
      setNextCursor(page.pagination?.nextCursor ?? null)
      setLastUpdatedAt(Date.now())
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [fetchActive, fetchHistory])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) return
    setLoadingMore(true)
    try {
      const page = await fetchHistory(nextCursor)
      setHistoryIncidents((prev) => {
        const seen = new Set(prev.map((i) => i._id))
        return [...prev, ...page.items.filter((i) => !seen.has(i._id))]
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
      const [, page] = await Promise.all([fetchActive(), fetchHistory()])
      setHistoryIncidents(page.items)
      setHasMore(page.pagination?.hasMore ?? false)
      setNextCursor(page.pagination?.nextCursor ?? null)
      setLastUpdatedAt(Date.now())
    } finally {
      setRefreshing(false)
    }
  }, [fetchActive, fetchHistory])

  // ---- SSE subscriptions ----
  useEffect(() => {
    return subscribe('incident:opened', (raw) => {
      const evt = raw as IncidentOpenedEvent
      setActiveIncidents((prev) => [
        evt.incident,
        ...prev.filter((i) => i._id !== evt.incident._id),
      ])
      setHistoryIncidents((prev) => [
        evt.incident,
        ...prev.filter((i) => i._id !== evt.incident._id),
      ])
      setLastUpdatedAt(Date.now())
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', (raw) => {
      const evt = raw as IncidentResolvedEvent
      setActiveIncidents((prev) => prev.filter((i) => i._id !== evt.incidentId))
      setHistoryIncidents((prev) =>
        prev.map((i) =>
          i._id === evt.incidentId
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
    })
  }, [subscribe])

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
            sparklineByEndpointId={sparklineByEndpointId}
            lastUpdatedAt={lastUpdatedAt}
          />

          {/* KPI row */}
          <IncidentKpis
            activeIncidents={activeIncidents}
            historyIncidents={historyIncidents}
          />

          {/* Trends & causes */}
          <SectionHead title="Trends & causes" hint="Derived from the last 14 days" />
          <IncidentExtras
            historyIncidents={historyIncidents}
            endpointById={endpointById}
          />

          {/* History table */}
          <SectionHead title="History" hint="Filter, search, and drill into any incident" />
          <IncidentsTable
            incidents={historyIncidents}
            activeIncidents={activeIncidents}
            endpointById={endpointById}
            channelById={channelById}
            sparklineByEndpointId={sparklineByEndpointId}
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
