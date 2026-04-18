import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Spinner,
  ToggleButtonGroup,
  ToggleButton,
  SearchField,
  Dropdown,
  ScrollShadow,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type { ApiIncident, ApiEndpoint, ApiPagination } from '../types/api'
import { timeAgo, formatDuration, formatRuntime } from '../utils/format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'active' | 'resolved'
type TimeRange = '24h' | '7d' | '30d' | 'all'

interface IncidentSSEEvent {
  timestamp: string
  incident: ApiIncident
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function causeSeverity(cause: string): 'down' | 'degraded' {
  return cause === 'endpoint_degraded' ? 'degraded' : 'down'
}

function causeLabel(cause: string): string {
  switch (cause) {
    case 'endpoint_down':
      return 'Down'
    case 'endpoint_degraded':
      return 'Degraded'
    default:
      return cause.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

function rangeToISO(range: TimeRange): string | undefined {
  if (range === 'all') return undefined
  const now = Date.now()
  const ms: Record<string, number> = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }
  return new Date(now - ms[range]).toISOString()
}

function liveDurationSeconds(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const GRID_COLS = 'grid-cols-[20px_84px_minmax(100px,180px)_1fr_100px_90px_60px]'

export default function IncidentsPage() {
  const navigate = useNavigate()
  const { request } = useApi()
  const { subscribe } = useSSE()

  // ---- State ----
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [endpointFilter, setEndpointFilter] = useState('all')
  const [search, setSearch] = useState('')

  const [incidents, setIncidents] = useState<ApiIncident[]>([])
  const [activeIncidents, setActiveIncidents] = useState<ApiIncident[]>([])
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [runtimeTick, setRuntimeTick] = useState(0)

  const sentinelRef = useRef<HTMLDivElement>(null)

  // ---- Endpoint map ----
  const endpointMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const ep of endpoints) m.set(ep._id, ep.name)
    return m
  }, [endpoints])

  // ---- Fetch endpoints ----
  useEffect(() => {
    request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=100').then(
      (res) => setEndpoints(res.data.data ?? []),
    )
  }, [request])

  // ---- Fetch active incidents ----
  const fetchActive = useCallback(async () => {
    const res = await request<{ data: ApiIncident[] }>('/incidents/active')
    setActiveIncidents(res.data.data ?? [])
  }, [request])

  useEffect(() => {
    fetchActive()
  }, [fetchActive])

  // ---- Fetch incident list (paginated) ----
  const fetchIncidents = useCallback(
    async (cursor?: string | null) => {
      const params = new URLSearchParams()
      params.set('limit', '20')
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (endpointFilter !== 'all') params.set('endpointId', endpointFilter)
      if (statusFilter !== 'active') {
        const from = rangeToISO(timeRange)
        if (from) params.set('from', from)
      }
      if (cursor) params.set('cursor', cursor)

      const res = await request<{ data: ApiIncident[]; pagination: ApiPagination }>(
        `/incidents?${params.toString()}`,
      )
      const page = res.data
      return {
        items: page.data ?? [],
        pagination: page.pagination,
      }
    },
    [request, statusFilter, endpointFilter, timeRange],
  )

  // Reset and load first page when filters change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchIncidents().then((result) => {
      if (cancelled) return
      setIncidents(result.items)
      setHasMore(result.pagination?.hasMore ?? false)
      setNextCursor(result.pagination?.nextCursor ?? null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [fetchIncidents])

  // Load more (infinite scroll)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) return
    setLoadingMore(true)
    const result = await fetchIncidents(nextCursor)
    setIncidents((prev) => [...prev, ...result.items])
    setHasMore(result.pagination?.hasMore ?? false)
    setNextCursor(result.pagination?.nextCursor ?? null)
    setLoadingMore(false)
  }, [loadingMore, hasMore, nextCursor, fetchIncidents])

  // ---- IntersectionObserver for sentinel ----
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { threshold: 0.1 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore])

  // ---- Live tick for active durations ----
  useEffect(() => {
    if (activeIncidents.length === 0) return
    const interval = setInterval(() => setRuntimeTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [activeIncidents.length])

  // ---- SSE subscriptions ----
  useEffect(() => {
    return subscribe('incident:opened', (raw) => {
      const evt = raw as IncidentSSEEvent
      setActiveIncidents((prev) => [evt.incident, ...prev.filter((i) => i._id !== evt.incident._id)])
      setIncidents((prev) => [evt.incident, ...prev.filter((i) => i._id !== evt.incident._id)])
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', (raw) => {
      const evt = raw as { timestamp: string; incidentId: string; durationSeconds: number }
      setActiveIncidents((prev) => prev.filter((i) => i._id !== evt.incidentId))
      setIncidents((prev) =>
        prev.map((i) =>
          i._id === evt.incidentId
            ? { ...i, status: 'resolved' as const, resolvedAt: evt.timestamp, durationSeconds: evt.durationSeconds }
            : i,
        ),
      )
    })
  }, [subscribe])

  // ---- Computed stats ----
  const stats = useMemo(() => {
    const activeCount = activeIncidents.length
    const resolvedInPeriod = incidents.filter((i) => i.status === 'resolved')
    const resolvedCount = resolvedInPeriod.length

    // Avg duration
    const durations = resolvedInPeriod
      .filter((i) => i.durationSeconds != null)
      .map((i) => i.durationSeconds!)
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0

    // Most affected
    const countMap = new Map<string, number>()
    for (const inc of incidents) {
      countMap.set(inc.endpointId, (countMap.get(inc.endpointId) ?? 0) + 1)
    }
    let mostAffectedId = ''
    let mostAffectedCount = 0
    for (const [id, count] of countMap) {
      if (count > mostAffectedCount) {
        mostAffectedId = id
        mostAffectedCount = count
      }
    }
    const mostAffectedName = endpointMap.get(mostAffectedId) ?? ''

    return { activeCount, resolvedCount, avgDuration, mostAffectedName, mostAffectedCount }
  }, [activeIncidents, incidents, endpointMap])

  // ---- Filtered incidents for table ----
  const filteredIncidents = useMemo(() => {
    let list = incidents
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((i) => {
        const name = endpointMap.get(i.endpointId)?.toLowerCase() ?? ''
        const detail = i.causeDetail?.toLowerCase() ?? ''
        return name.includes(q) || detail.includes(q)
      })
    }
    return list
  }, [incidents, search, endpointMap])

  // ---- Endpoint dropdown label ----
  const endpointDropdownLabel = useMemo(() => {
    if (endpointFilter === 'all') return 'All Endpoints'
    return endpointMap.get(endpointFilter) ?? 'Endpoint'
  }, [endpointFilter, endpointMap])

  // ---- Active card helpers ----
  function getLastCheckInfo(inc: ApiIncident) {
    if (!inc.timeline?.length) return null
    const last = inc.timeline[inc.timeline.length - 1]
    // Try to parse detail for status code and response time
    const detail = last.detail ?? ''
    const codeMatch = detail.match(/(\d{3})/)
    const timeMatch = detail.match(/(\d+)\s*ms/)
    return {
      statusCode: codeMatch ? codeMatch[1] : null,
      responseTime: timeMatch ? timeMatch[1] : null,
      timeAgoStr: timeAgo(last.at),
    }
  }

  // ---- Empty state ----
  if (!loading && incidents.length === 0 && activeIncidents.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-xl font-semibold text-foreground">Incidents</h1>

        {/* Stat pills */}
        <div className="flex flex-wrap gap-3">
          <StatPill label="Active Now" value="0" />
          <StatPill label="Resolved" value="0" />
          <StatPill label="Avg Duration" value="--" />
          <StatPill label="Most Affected" value="--" />
        </div>

        {/* Filter toolbar */}
        {renderFilterToolbar()}

        {/* Empty state */}
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex items-center justify-center w-14 h-14 rounded-full bg-wd-success/10 mb-4">
            <Icon icon="solar:shield-check-bold" width={28} className="text-wd-success" />
          </div>
          <p className="text-base font-medium text-foreground">No incidents recorded</p>
          <p className="text-sm text-wd-muted mt-1">Your endpoints have been running clean.</p>
        </div>
      </div>
    )
  }

  // ---- Filter toolbar (reused) ----
  function renderFilterToolbar() {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {/* Status toggle */}
        <ToggleButtonGroup
          selectionMode="single"
          selectedKeys={new Set([statusFilter])}
          onSelectionChange={(keys) => {
            const sel = [...keys][0] as StatusFilter | undefined
            if (sel) setStatusFilter(sel)
          }}
          size="sm"
        >
          <ToggleButton
            key="all"
            id="all"
            className={cn(
              '!text-xs !px-3',
              'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              'dark:data-[selected=true]:!bg-wd-primary/50',
            )}
          >
            All
          </ToggleButton>
          <ToggleButton
            key="active"
            id="active"
            className={cn(
              '!text-xs !px-3',
              'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              'dark:data-[selected=true]:!bg-wd-primary/50',
            )}
          >
            Active
          </ToggleButton>
          <ToggleButton
            key="resolved"
            id="resolved"
            className={cn(
              '!text-xs !px-3',
              'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              'dark:data-[selected=true]:!bg-wd-primary/50',
            )}
          >
            Resolved
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Endpoint dropdown */}
        <Dropdown>
          <Dropdown.Trigger>
            <div className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs cursor-pointer hover:bg-wd-surface-hover transition-colors border border-wd-border/50">
              <Icon icon="solar:filter-outline" width={14} className="text-wd-muted" />
              <span className="text-foreground">{endpointDropdownLabel}</span>
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start" className="!min-w-[180px]">
            <Dropdown.Menu
              selectionMode="single"
              selectedKeys={new Set([endpointFilter])}
              onSelectionChange={(keys: Selection) => {
                const sel = [...keys][0] as string | undefined
                if (sel) setEndpointFilter(sel)
              }}
            >
              <Dropdown.Item id="all" className="!text-xs">
                All Endpoints
              </Dropdown.Item>
              {endpoints.map((ep) => (
                <Dropdown.Item key={ep._id} id={ep._id} className="!text-xs">
                  {ep.name}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        {/* Time range toggle */}
        <ToggleButtonGroup
          selectionMode="single"
          selectedKeys={new Set([timeRange])}
          onSelectionChange={(keys) => {
            const sel = [...keys][0] as TimeRange | undefined
            if (sel) setTimeRange(sel)
          }}
          size="sm"
        >
          {(['24h', '7d', '30d', 'all'] as const).map((r) => (
            <ToggleButton
              key={r}
              id={r}
              className={cn(
                '!text-xs !px-3',
                'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
                'dark:data-[selected=true]:!bg-wd-primary/50',
              )}
            >
              {r === 'all' ? 'All' : r.toUpperCase()}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {/* Search */}
        <SearchField aria-label="Search" value={search} onChange={setSearch} className="!w-64">
          <SearchField.Group className="!bg-wd-surface !border !border-wd-border/50 !rounded-lg !h-8">
            <SearchField.SearchIcon>
              <Icon icon="solar:magnifer-outline" width={15} className="text-wd-muted" />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search incidents..." className="!text-xs" />
            <SearchField.ClearButton>
              <Icon icon="solar:close-circle-outline" width={14} className="text-wd-muted" />
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>
      </div>
    )
  }

  // ---- Main render ----
  return (
    <div className="p-6 flex flex-col gap-6 h-full">
      <h1 className="text-xl font-semibold text-foreground shrink-0">Incidents</h1>

      {/* Stat pills */}
      <div className="flex flex-wrap gap-3 shrink-0">
        <StatPill
          label="Active Now"
          value={String(stats.activeCount)}
          pulse={stats.activeCount > 0}
        />
        <StatPill label="Resolved" value={String(stats.resolvedCount)} />
        <StatPill
          label="Avg Duration"
          value={stats.avgDuration > 0 ? formatDuration(stats.avgDuration) : '--'}
        />
        <StatPill
          label="Most Affected"
          value={
            stats.mostAffectedName
              ? `${stats.mostAffectedName} (${stats.mostAffectedCount})`
              : '--'
          }
        />
      </div>

      {/* Active incidents section */}
      {activeIncidents.length > 0 && (
        <div className="space-y-3 shrink-0">
          <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wd-danger" />
            </span>
            Active Incidents ({activeIncidents.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-1 lg:grid-cols-2">
            {activeIncidents.map((inc) => {
              const epName = endpointMap.get(inc.endpointId) ?? 'Unknown endpoint'
              const elapsed = liveDurationSeconds(inc.startedAt)
              const lastCheck = getLastCheckInfo(inc)
              // Force re-read on tick
              void runtimeTick

              return (
                <div
                  key={inc._id}
                  className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 cursor-pointer hover:bg-wd-surface-hover/50 transition-colors"
                  onClick={() => navigate(`/incidents/${inc._id}`)}
                >
                  {/* Top row: name + duration */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="relative flex h-2.5 w-2.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wd-danger" />
                      </span>
                      <span className="text-sm font-medium text-foreground truncate">{epName}</span>
                    </div>
                    <span className="text-sm font-mono text-wd-danger whitespace-nowrap ml-3">
                      {formatRuntime(elapsed)}
                    </span>
                  </div>

                  {/* Cause */}
                  <div className="mt-2 text-xs text-wd-muted">
                    <span className="font-medium text-foreground">{causeLabel(inc.cause)}</span>
                    {inc.causeDetail && (
                      <span className="ml-1.5">{inc.causeDetail}</span>
                    )}
                  </div>

                  {/* Bottom row */}
                  <div className="mt-3 flex items-center justify-between text-[11px] text-wd-muted">
                    <span>
                      {lastCheck
                        ? `Last check: ${lastCheck.statusCode ?? '--'} · ${lastCheck.responseTime ?? '--'}ms · ${lastCheck.timeAgoStr}`
                        : `Started ${timeAgo(inc.startedAt)}`}
                    </span>
                    <span>{inc.notificationsSent} alerts sent</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Filter toolbar */}
      <div className="shrink-0">{renderFilterToolbar()}</div>

      {/* Loading state */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : filteredIncidents.length === 0 ? (
        /* Empty filtered state */
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex items-center justify-center w-14 h-14 rounded-full bg-wd-success/10 mb-4">
            <Icon icon="solar:shield-check-bold" width={28} className="text-wd-success" />
          </div>
          <p className="text-base font-medium text-foreground">No incidents recorded</p>
          <p className="text-sm text-wd-muted mt-1">Your endpoints have been running clean.</p>
        </div>
      ) : (
        /* Incident history table */
        <div className="wd-incidents-table-container flex flex-col flex-1 min-h-0 rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
          {/* Header */}
          <div
            className={cn(
              'grid items-center gap-x-3 px-4 py-2.5 border-b border-wd-border/50 bg-wd-surface-hover/30 shrink-0',
              GRID_COLS,
            )}
          >
            <span />
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
              Status
            </span>
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
              Endpoint
            </span>
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
              Cause
            </span>
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
              Started
            </span>
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
              Duration
            </span>
            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider text-right">
              Alerts
            </span>
          </div>

          {/* Rows (scrollable) */}
          <ScrollShadow
            orientation="vertical"
            size={10}
            className="wd-incidents-table-wrap flex-1 min-h-0"
          >
          {filteredIncidents.map((inc) => {
            const severity = causeSeverity(inc.cause)
            const epName = endpointMap.get(inc.endpointId) ?? 'Unknown'
            const isActive = inc.status === 'active'
            const duration = isActive
              ? liveDurationSeconds(inc.startedAt)
              : inc.durationSeconds ?? 0
            // Force re-read on tick for active
            if (isActive) void runtimeTick

            return (
              <div
                key={inc._id}
                role="row"
                className={cn(
                  'grid items-center gap-x-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-wd-surface-hover/50 border-b border-wd-border/10',
                  GRID_COLS,
                )}
                onClick={() => navigate(`/incidents/${inc._id}`)}
              >
                {/* Severity dot */}
                <div className="flex justify-center">
                  <span
                    className={cn(
                      'inline-block w-2.5 h-2.5 rounded-full',
                      severity === 'down' ? 'bg-wd-danger' : 'bg-wd-warning',
                    )}
                  />
                </div>

                {/* Status pill */}
                <div>
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-wd-danger/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-wd-danger">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
                      </span>
                      Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-wd-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-wd-success">
                      <Icon icon="solar:check-circle-bold" width={10} />
                      Resolved
                    </span>
                  )}
                </div>

                {/* Endpoint name */}
                <span className="text-xs font-medium text-foreground truncate">{epName}</span>

                {/* Cause + detail */}
                <div className="text-xs text-wd-muted truncate">
                  <span className="font-medium text-foreground">{causeLabel(inc.cause)}</span>
                  {inc.causeDetail && (
                    <span className="ml-1.5 truncate">{inc.causeDetail}</span>
                  )}
                </div>

                {/* Started */}
                <span className="text-xs text-wd-muted">{timeAgo(inc.startedAt)}</span>

                {/* Duration */}
                <span
                  className={cn(
                    'text-xs font-mono',
                    isActive ? 'text-wd-danger' : 'text-wd-muted',
                  )}
                >
                  {formatDuration(duration)}
                </span>

                {/* Alerts */}
                <span className="text-xs text-wd-muted text-right">{inc.notificationsSent}</span>
              </div>
            )
          })}

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-3">
              <Spinner size="sm" />
            </div>
          )}
          </ScrollShadow>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatPill
// ---------------------------------------------------------------------------

function StatPill({
  label,
  value,
  pulse = false,
}: {
  label: string
  value: string
  pulse?: boolean
}) {
  return (
    <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-wd-border/50 bg-wd-surface">
      {pulse && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-wd-danger" />
        </span>
      )}
      <span className="text-[11px] text-wd-muted uppercase tracking-wider">{label}</span>
      <span className="text-sm font-semibold text-foreground">{value}</span>
    </div>
  )
}
