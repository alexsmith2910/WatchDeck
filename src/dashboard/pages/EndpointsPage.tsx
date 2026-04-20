import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  SearchField,
  ToggleButtonGroup,
  ToggleButton,
  Dropdown,
  ScrollShadow,
  Checkbox,
  Spinner,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type { ApiEndpoint, ApiPagination, DailySummary, UptimeStats, EndpointStatus } from '../types/api'
import { timeAgo, formatTime, latencyColor, uptimeColor } from '../utils/format'
import UptimeBar, { buildHistory, avg30dResponse, avg30dUptime, type DailyBucket } from '../components/UptimeBar'

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

interface CheckCompleteEvent {
  timestamp: string
  endpointId: string
  status: 'healthy' | 'degraded' | 'down'
  responseTime: number
  statusCode: number | null
  errorMessage: string | null
}

interface EndpointCreatedEvent {
  timestamp: string
  endpoint: ApiEndpoint
}

interface EndpointDeletedEvent {
  timestamp: string
  endpointId: string
}

interface EndpointUpdatedEvent {
  timestamp: string
  endpointId: string
  changes: Partial<ApiEndpoint>
}

// ---------------------------------------------------------------------------
// Display types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | EndpointStatus
type TypeFilter = 'all' | 'http' | 'port'

interface Endpoint {
  id: string
  name: string
  type: 'http' | 'port'
  url: string
  status: EndpointStatus | null
  endpointStatus: 'active' | 'paused' | 'archived'
  checkInterval: number
  consecutiveFailures: number
  lastCheckAt: Date | null
  method?: string
  expectedStatusCodes?: number[]
  responseTime: number | null
  statusCode: number | null
  errorMessage: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapEndpoint(doc: ApiEndpoint): Endpoint {
  const url =
    doc.type === 'http'
      ? (doc.url ?? '')
      : doc.host && doc.port
        ? `${doc.host}:${doc.port}`
        : doc.host ?? ''
  return {
    id: doc._id,
    name: doc.name,
    type: doc.type,
    url,
    status: doc.lastStatus ?? null,
    endpointStatus: doc.status,
    checkInterval: doc.checkInterval,
    consecutiveFailures: doc.consecutiveFailures,
    lastCheckAt: doc.lastCheckAt ? new Date(doc.lastCheckAt) : null,
    method: doc.method,
    expectedStatusCodes: doc.expectedStatusCodes,
    responseTime: doc.lastResponseTime ?? null,
    statusCode: doc.lastStatusCode ?? null,
    errorMessage: doc.lastErrorMessage ?? null,
  }
}

// ---------------------------------------------------------------------------
// Status / type helpers
// ---------------------------------------------------------------------------

const statusConfig: Record<EndpointStatus, { label: string; dot: string; text: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-wd-success', text: 'text-wd-success' },
  degraded: { label: 'Degraded', dot: 'bg-wd-warning', text: 'text-wd-warning' },
  down: { label: 'Down', dot: 'bg-wd-danger', text: 'text-wd-danger' },
}

const pendingStatus = { label: 'Pending', dot: 'bg-wd-muted/50', text: 'text-wd-muted' }

const typeFilterLabels: Record<TypeFilter, string> = {
  all: 'All Types',
  http: 'HTTP',
  port: 'Port',
}

const statusOrder: Record<EndpointStatus, number> = { down: 0, degraded: 1, healthy: 2 }

function TipRow({ label, value, className, mono = true }: { label: string; value: string; className?: string; mono?: boolean }) {
  return (
    <div className="flex gap-4">
      <span className="text-wd-muted shrink-0 whitespace-nowrap">{label}</span>
      <span className={cn('font-medium ml-auto text-right', mono && 'font-mono', className)}>{value}</span>
    </div>
  )
}

const TIP_CLS = 'px-3 py-2 text-[11px] leading-relaxed min-w-[220px] max-w-[320px]'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_LIMIT = 100
const GRID_COLS =
  'grid-cols-[32px_110px_minmax(0,1.2fr)_minmax(0,1.5fr)_80px_90px_110px_80px]'

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'healthy', label: 'Healthy' },
  { key: 'degraded', label: 'Degraded' },
  { key: 'down', label: 'Down' },
]

// ---------------------------------------------------------------------------
// EndpointsPage
// ---------------------------------------------------------------------------

export default function EndpointsPage() {
  const navigate = useNavigate()
  const { request } = useApi()
  const { subscribe } = useSSE()

  // Data state
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalEndpoints, setTotalEndpoints] = useState(0)

  // Intersection observer sentinel for infinite scroll
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Measure the rows' scrollbar gutter so we can mirror it on the header.
  // Without this, header's grid computes fr tracks against the full container
  // width while rows' grid loses the scrollbar width — shifting every fixed
  // column after the fr tracks by that gutter width.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollGutter, setScrollGutter] = useState(0)

  // UI state
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sort, setSort] = useState({ col: 'status', asc: true })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Aggregation data: uptime stats and daily summaries (30d) per endpoint
  const [uptimeMap, setUptimeMap] = useState<Map<string, UptimeStats>>(new Map())
  const [dailyMap, setDailyMap] = useState<Map<string, DailySummary[]>>(new Map())
  const [aggLoading, setAggLoading] = useState(true)

  // Single-row delete confirm
  const [confirmDelete, setConfirmDelete] = useState<Endpoint | null>(null)
  const [deletingOne, setDeletingOne] = useState(false)

  // Derived: 30d uptime bar history, rolling 30d uptime %, and avg response per endpoint
  const historyMap = useMemo(() => {
    const map = new Map<string, DailyBucket[]>()
    for (const [id, dailies] of dailyMap) map.set(id, buildHistory(dailies))
    return map
  }, [dailyMap])

  const avg30dMap = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [id, dailies] of dailyMap) map.set(id, avg30dResponse(dailies))
    return map
  }, [dailyMap])

  const uptime30dMap = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [id, dailies] of dailyMap) map.set(id, avg30dUptime(dailies))
    return map
  }, [dailyMap])

  // Tick for relative time updates
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(timer)
  }, [])

  // ── Fetch endpoints ───────────────────────────────────────────────────────

  const fetchEndpoints = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data: res } = await request<{ data: ApiEndpoint[]; pagination: ApiPagination }>(
        `/endpoints?limit=${FETCH_LIMIT}`,
      )
      setEndpoints(res.data.map(mapEndpoint))
      setHasMore(res.pagination.hasMore)
      setNextCursor(res.pagination.nextCursor)
      setTotalEndpoints(res.pagination.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch endpoints')
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    fetchEndpoints()
  }, [fetchEndpoints])

  // Keep the header's right padding in sync with the rows' scrollbar gutter.
  // offsetWidth − clientWidth is the exact gutter (0 when no scrollbar).
  const measureGutter = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const gutter = el.offsetWidth - el.clientWidth
    setScrollGutter((prev) => (prev === gutter ? prev : gutter))
  }, [])

  useEffect(() => {
    measureGutter()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(measureGutter)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureGutter])

  // Fetch aggregation data (uptime + 30d daily summaries) for all loaded endpoints
  useEffect(() => {
    if (endpoints.length === 0) return
    let cancelled = false

    const fetchAggregation = async () => {
      setAggLoading(true)
      const ids = endpoints.map((ep) => ep.id)
      const [uptimeResults, dailyResults] = await Promise.all([
        Promise.allSettled(
          ids.map((id) =>
            request<{ data: UptimeStats }>(`/endpoints/${id}/uptime`).then((r) => ({ id, data: r.data.data })),
          ),
        ),
        Promise.allSettled(
          ids.map((id) =>
            request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=30`).then((r) => ({ id, data: r.data.data })),
          ),
        ),
      ])

      if (cancelled) return

      const newUptime = new Map<string, UptimeStats>()
      const failed = new Set<string>()
      for (let i = 0; i < uptimeResults.length; i++) {
        const r = uptimeResults[i]
        if (r.status === 'fulfilled') newUptime.set(r.value.id, r.value.data)
        else failed.add(ids[i])
      }
      setUptimeMap(newUptime)

      const newDaily = new Map<string, DailySummary[]>()
      for (let i = 0; i < dailyResults.length; i++) {
        const r = dailyResults[i]
        if (r.status === 'fulfilled') newDaily.set(r.value.id, r.value.data)
        else failed.add(ids[i])
      }
      setDailyMap(newDaily)
      setFailedAggIds(failed)
      setAggLoading(false)
    }

    fetchAggregation()
    return () => { cancelled = true }
  }, [endpoints.length, request]) // re-fetch when endpoint count changes

  // ── Load more (cursor pagination) ─────────────────────────────────────────

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const { data: res } = await request<{ data: ApiEndpoint[]; pagination: ApiPagination }>(
        `/endpoints?limit=${FETCH_LIMIT}&cursor=${nextCursor}`,
      )
      setEndpoints((prev) => [...prev, ...res.data.map(mapEndpoint)])
      setHasMore(res.pagination.hasMore)
      setNextCursor(res.pagination.nextCursor)
    } catch {
      // silently fail load-more
    } finally {
      setLoadingMore(false)
    }
  }, [request, nextCursor, loadingMore])

  // ── Intersection observer for infinite scroll ───────────────────────────
  useEffect(() => {
    if (!hasMore || loadingMore) return
    const el = sentinelRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) handleLoadMore() },
      { rootMargin: '100px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, handleLoadMore])

  // ── Aggregation retry for failed fetches ────────────────────────────────
  const [failedAggIds, setFailedAggIds] = useState<Set<string>>(new Set())

  const retryAggregation = useCallback(async (id: string) => {
    const [uptimeRes, dailyRes] = await Promise.allSettled([
      request<{ data: UptimeStats }>(`/endpoints/${id}/uptime`).then((r) => r.data.data),
      request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=30`).then((r) => r.data.data),
    ])
    if (uptimeRes.status === 'fulfilled') {
      setUptimeMap((prev) => new Map(prev).set(id, uptimeRes.value))
    }
    if (dailyRes.status === 'fulfilled') {
      setDailyMap((prev) => new Map(prev).set(id, dailyRes.value))
    }
    if (uptimeRes.status === 'fulfilled' && dailyRes.status === 'fulfilled') {
      setFailedAggIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    }
  }, [request])

  // ── SSE subscriptions ─────────────────────────────────────────────────────

  // check:complete — update endpoint with live check data
  useEffect(() => {
    return subscribe('check:complete', (raw) => {
      const evt = raw as CheckCompleteEvent

      setEndpoints((prev) =>
        prev.map((ep) =>
          ep.id === evt.endpointId
            ? {
                ...ep,
                status: evt.status,
                responseTime: evt.responseTime,
                statusCode: evt.statusCode,
                errorMessage: evt.errorMessage,
                lastCheckAt: new Date(evt.timestamp),
                consecutiveFailures:
                  evt.status === 'healthy' ? 0 : ep.consecutiveFailures + 1,
              }
            : ep,
        ),
      )
    })
  }, [subscribe])

  // endpoint:created — add to list
  useEffect(() => {
    return subscribe('endpoint:created', (raw) => {
      const evt = raw as EndpointCreatedEvent
      setEndpoints((prev) => [mapEndpoint(evt.endpoint), ...prev])
    })
  }, [subscribe])

  // endpoint:deleted — remove from list
  useEffect(() => {
    return subscribe('endpoint:deleted', (raw) => {
      const evt = raw as EndpointDeletedEvent
      setEndpoints((prev) => prev.filter((ep) => ep.id !== evt.endpointId))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(evt.endpointId)
        return next
      })
    })
  }, [subscribe])

  // endpoint:updated — update in list
  useEffect(() => {
    return subscribe('endpoint:updated', (raw) => {
      const evt = raw as EndpointUpdatedEvent
      setEndpoints((prev) =>
        prev.map((ep) => {
          if (ep.id !== evt.endpointId) return ep
          const c = evt.changes
          return {
            ...ep,
            ...(c.name !== undefined && { name: c.name }),
            ...(c.status !== undefined && { endpointStatus: c.status }),
            ...(c.checkInterval !== undefined && { checkInterval: c.checkInterval }),
          }
        }).filter((ep) => {
          if (ep.id === evt.endpointId && evt.changes.status === 'archived') return false
          return true
        }),
      )
    })
  }, [subscribe])

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleRecheck = useCallback(
    async (id: string) => {
      await request(`/endpoints/${id}/recheck`, { method: 'POST' })
    },
    [request],
  )

  const [recheckingAll, setRecheckingAll] = useState(false)
  const handleRecheckAll = useCallback(async () => {
    if (recheckingAll) return
    setRecheckingAll(true)
    try {
      await Promise.all(
        endpoints.map((ep) => request(`/endpoints/${ep.id}/recheck`, { method: 'POST' })),
      )
    } finally {
      setRecheckingAll(false)
    }
  }, [endpoints, request, recheckingAll])

  const handleToggle = useCallback(
    async (id: string) => {
      // Optimistic update
      setEndpoints((prev) =>
        prev.map((ep) =>
          ep.id === id
            ? { ...ep, endpointStatus: ep.endpointStatus === 'paused' ? 'active' : 'paused' }
            : ep,
        ),
      )
      await request(`/endpoints/${id}/toggle`, { method: 'PATCH' })
    },
    [request],
  )

  const handleDelete = useCallback(
    async (ids: Set<string>) => {
      await Promise.all([...ids].map((id) => request(`/endpoints/${id}`, { method: 'DELETE' })))
      setSelected(new Set())
    },
    [request],
  )

  const handleConfirmDeleteOne = useCallback(async () => {
    if (!confirmDelete || deletingOne) return
    setDeletingOne(true)
    try {
      await request(`/endpoints/${confirmDelete.id}`, { method: 'DELETE' })
      setConfirmDelete(null)
    } finally {
      setDeletingOne(false)
    }
  }, [confirmDelete, deletingOne, request])

  const handleBulkRecheck = useCallback(
    async (ids: Set<string>) => {
      await Promise.all(
        [...ids].map((id) => request(`/endpoints/${id}/recheck`, { method: 'POST' })),
      )
    },
    [request],
  )

  const handleBulkToggle = useCallback(
    async (ids: Set<string>) => {
      await Promise.all(
        [...ids].map((id) => request(`/endpoints/${id}/toggle`, { method: 'PATCH' })),
      )
    },
    [request],
  )

  // ── Sort / filter / select ────────────────────────────────────────────────

  const handleSort = useCallback((col: string) => {
    setSort((prev) => ({ col, asc: prev.col === col ? !prev.asc : true }))
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const filtered = useMemo(() => {
    let items = endpoints
    if (statusFilter !== 'all')
      items = items.filter((ep) => ep.status === statusFilter)
    if (typeFilter !== 'all') items = items.filter((ep) => ep.type === typeFilter)
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      items = items.filter(
        (ep) =>
          ep.name.toLowerCase().includes(q) ||
          ep.url.toLowerCase().includes(q) ||
          ep.type.toLowerCase().includes(q) ||
          (ep.status ?? '').toLowerCase().includes(q),
      )
    }
    return items
  }, [endpoints, search, statusFilter, typeFilter])

  const sorted = useMemo(() => {
    const { col, asc } = sort
    if (!col) return filtered
    const dir = asc ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (col === 'status') {
        const aOrder = a.status ? statusOrder[a.status] : -1
        const bOrder = b.status ? statusOrder[b.status] : -1
        return (aOrder - bOrder) * dir
      }
      if (col === 'responseTime') {
        return ((avg30dMap.get(a.id) ?? 0) - (avg30dMap.get(b.id) ?? 0)) * dir
      }
      if (col === 'uptime') {
        return ((uptime30dMap.get(a.id) ?? -2) - (uptime30dMap.get(b.id) ?? -2)) * dir
      }
      const aVal = a[col as keyof Endpoint] ?? ''
      const bVal = b[col as keyof Endpoint] ?? ''
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir
      return String(aVal).localeCompare(String(bVal)) * dir
    })
  }, [filtered, sort, uptime30dMap, avg30dMap])

  // Re-measure the scrollbar gutter after rows render — scrollbar appearance
  // changes clientWidth but may not trigger ResizeObserver on all browsers.
  useEffect(() => {
    measureGutter()
  }, [sorted.length, measureGutter])

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === sorted.length ? new Set() : new Set(sorted.map((ep) => ep.id)),
    )
  }, [sorted])

  const statusCounts = useMemo(() => {
    const counts = { all: endpoints.length, healthy: 0, degraded: 0, down: 0 }
    for (const ep of endpoints) {
      if (ep.status) counts[ep.status]++
    }
    return counts
  }, [endpoints])

  // ── Loading / error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-wd-muted">Loading endpoints...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Icon icon="solar:danger-triangle-outline" width={40} className="text-wd-danger/50" />
          <p className="text-sm text-wd-danger">{error}</p>
          <Button size="sm" variant="ghost" onPress={fetchEndpoints}>
            Retry
          </Button>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-xl font-semibold text-foreground">Endpoints</h1>
      </div>

      {/* Toolbar — search + status tabs + type filter */}
      <div className="flex items-center gap-3 shrink-0">
        <SearchField
          aria-label="Search endpoints"
          value={search}
          onChange={setSearch}
          className="!w-64"
        >
          <SearchField.Group className="!bg-wd-surface !border !border-wd-border/50 !rounded-lg !h-8">
            <SearchField.SearchIcon>
              <Icon icon="solar:magnifer-outline" width={16} className="text-wd-muted" />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search name, URL..." className="!text-xs" />
            <SearchField.ClearButton>
              <Icon icon="solar:close-circle-outline" width={16} className="text-wd-muted" />
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>

        <ToggleButtonGroup
          selectionMode="single"
          selectedKeys={new Set([statusFilter])}
          onSelectionChange={(keys) => {
            const sel = [...keys][0] as StatusFilter | undefined
            if (sel) setStatusFilter(sel)
          }}
          size="sm"
        >
          {statusFilters.map((f) => (
            <ToggleButton
              key={f.key}
              id={f.key}
              className={cn(
                '!text-xs !px-3',
                'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              )}
            >
              {f.label}
              <span className="ml-1 text-[10px] font-mono opacity-60">{statusCounts[f.key]}</span>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Dropdown>
          <Dropdown.Trigger>
            <div className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs cursor-pointer hover:bg-wd-surface-hover transition-colors">
              <Icon icon="solar:filter-outline" width={16} className="text-wd-muted" />
              <span className="text-foreground">{typeFilterLabels[typeFilter]}</span>
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start" className="!min-w-[140px]">
            <Dropdown.Menu
              selectionMode="single"
              selectedKeys={new Set([typeFilter])}
              onSelectionChange={(keys: Selection) => {
                const sel = [...keys][0] as TypeFilter | undefined
                if (sel) setTypeFilter(sel)
              }}
            >
              <Dropdown.Item id="all" className="!text-xs">
                All Types
              </Dropdown.Item>
              <Dropdown.Item id="http" className="!text-xs">
                HTTP Only
              </Dropdown.Item>
              <Dropdown.Item id="port" className="!text-xs">
                Port Only
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        <div className="flex-1" />

        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="!min-w-8 !h-8"
              isDisabled={recheckingAll || endpoints.length === 0}
              onPress={handleRecheckAll}
            >
              {recheckingAll ? (
                <Spinner size="sm" />
              ) : (
                <Icon icon="solar:refresh-outline" width={20} className="text-wd-muted" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1 text-[11px]">Recheck all endpoints</TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          className="!bg-wd-primary !text-wd-primary-foreground !text-xs !px-4"
          onPress={() => navigate('/endpoints/add')}
        >
          <Icon icon="solar:add-circle-outline" width={24} />
          Add Endpoint
        </Button>
      </div>

      {/* Table */}
      <div className="wd-endpoints-table-container flex flex-col flex-1 min-h-0 border border-wd-border/30 rounded-lg overflow-hidden">
        {/* Column header — stays outside the scroll container so it doesn't
            scroll with rows. We measure the rows' scrollbar gutter and mirror
            it as the header's right padding so both grids compute fr tracks
            against the same content width. */}
        <div
          className={cn(
            'grid items-center gap-x-3 px-3 py-2 shrink-0',
            'bg-[var(--surface-secondary)] border-b border-wd-border/30',
            'text-[11px] font-medium text-wd-muted select-none',
            GRID_COLS,
          )}
          style={{ paddingRight: `calc(0.75rem + ${scrollGutter}px)` }}
        >
          <Checkbox
            isSelected={sorted.length > 0 && selected.size === sorted.length}
            isIndeterminate={selected.size > 0 && selected.size < sorted.length}
            onChange={toggleSelectAll}
            size="sm"
            aria-label="Select all"
          >
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
          </Checkbox>
          {(
            [
              ['status', 'Status'],
              ['name', 'Name'],
            ] as const
          ).map(([col, label]) => (
            <button
              key={col}
              onClick={() => handleSort(col)}
              className="flex items-center gap-1 w-full justify-start hover:text-foreground transition-colors text-left"
            >
              {label}
              {sort.col === col && (
                <Icon
                  icon={sort.asc ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'}
                  width={16}
                />
              )}
            </button>
          ))}
          <span className="block w-full text-left">Uptime · 30d</span>
          {(
            [
              ['uptime', '30d %'],
              ['responseTime', 'Response'],
            ] as const
          ).map(([col, label]) => (
            <button
              key={col}
              onClick={() => handleSort(col)}
              className="flex items-center gap-1 w-full justify-start hover:text-foreground transition-colors text-left"
            >
              {label}
              {sort.col === col && (
                <Icon
                  icon={sort.asc ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'}
                  width={16}
                />
              )}
            </button>
          ))}
          <span className="block w-full text-left">Last Checked</span>
          <span />
        </div>

        {/* Rows */}
        <ScrollShadow
          ref={scrollRef}
          orientation="vertical"
          size={10}
          className="wd-endpoints-table-wrap flex-1 min-h-0 bg-[var(--surface)]"
        >
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Icon icon="solar:server-square-outline" width={40} className="text-wd-muted/30" />
              <p className="text-sm text-wd-muted">
                {endpoints.length === 0 ? 'No endpoints yet' : 'No endpoints match filters'}
              </p>
              {endpoints.length === 0 && (
                <Button
                  size="sm"
                  className="!bg-wd-primary !text-wd-primary-foreground !text-xs !px-4"
                  onPress={() => navigate('/endpoints/add')}
                >
                  <Icon icon="solar:add-circle-outline" width={24} />
                  Add Endpoint
                </Button>
              )}
            </div>
          ) : (
            <>
              {sorted.map((ep) => {
                const sc = ep.status ? statusConfig[ep.status] : pendingStatus
                return (
                  <div
                    key={ep.id}
                    role="row"
                    className={cn(
                      'grid items-center gap-x-3 px-3 py-2 cursor-pointer transition-colors relative',
                      'border-b border-wd-border/10 hover:bg-black/[0.04] dark:hover:bg-black/25',
                      ep.endpointStatus === 'paused' &&
                        "bg-wd-warning/[0.03] before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-0.5 before:bg-wd-warning/30 before:pointer-events-none",
                      GRID_COLS,
                    )}
                    onClick={() => navigate(`/endpoints/${ep.id}`)}
                  >
                    {/* Checkbox */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        isSelected={selected.has(ep.id)}
                        onChange={() => toggleSelect(ep.id)}
                        size="sm"
                        aria-label={`Select ${ep.name}`}
                      >
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                      </Checkbox>
                    </div>

                    {/* Status */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger className="!block !w-full !text-left !justify-start">
                        {ep.endpointStatus === 'paused' ? (
                          <div className="flex items-center gap-1.5">
                            <Icon icon="solar:pause-circle-outline" width={16} className="text-wd-warning/70" />
                            <span className="text-xs font-medium text-wd-warning/70">Paused</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className={cn('h-2 w-2 rounded-full shrink-0', sc.dot)} />
                            <span className={cn('text-xs font-medium', sc.text)}>{sc.label}</span>
                          </div>
                        )}
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        {ep.endpointStatus === 'paused' ? (
                          <>
                            <div className="text-wd-warning">Monitoring paused</div>
                            <div className="text-wd-muted/60 text-[10px] mt-0.5">Checks are skipped while paused</div>
                            {ep.status && (
                              <TipRow label="Last status" value={sc.label} className={sc.text} mono={false} />
                            )}
                          </>
                        ) : (
                          <>
                            {ep.errorMessage && (
                              <TipRow
                                label="Reason"
                                value={ep.errorMessage}
                                className="text-wd-danger"
                                mono={false}
                              />
                            )}
                            {ep.statusCode != null && (
                              <TipRow label="Last code" value={String(ep.statusCode)} />
                            )}
                            {ep.consecutiveFailures > 0 && (
                              <TipRow
                                label="Failures"
                                value={`${ep.consecutiveFailures} consecutive`}
                                className="text-wd-danger"
                                mono={false}
                              />
                            )}
                            {ep.status === 'healthy' && !ep.errorMessage && ep.endpointStatus !== 'paused' && (
                              <div className="text-wd-success">All checks passing</div>
                            )}
                            {ep.status === null && (
                              <div className="text-wd-muted">Waiting for first check</div>
                            )}
                          </>
                        )}
                      </TooltipContent>
                    </Tooltip>

                    {/* Name + URL */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger className="!block !w-full !text-left !justify-start">
                        <div className="flex flex-col min-w-0 text-left">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12.5px] font-medium text-foreground truncate">
                              {ep.name}
                            </span>
                            {ep.endpointStatus === 'paused' && (
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-wd-warning bg-wd-warning/10 px-1.5 py-0.5 rounded">
                                Paused
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono text-wd-muted/70 truncate">
                            {ep.type === 'http' && ep.method
                              ? `${ep.method} ${ep.url}`
                              : ep.url}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        <TipRow label="Type" value={ep.type.toUpperCase()} />
                        <TipRow label="Interval" value={`Every ${ep.checkInterval}s`} mono={false} />
                        {ep.method && (
                          <TipRow
                            label="Method"
                            value={`${ep.method} · expect ${ep.expectedStatusCodes?.join(', ') ?? '2xx'}`}
                          />
                        )}
                        {ep.type === 'port' && <TipRow label="Protocol" value="TCP" />}
                      </TooltipContent>
                    </Tooltip>

                    {/* Uptime bar (30d) */}
                    {(() => {
                      const aggFailed = failedAggIds.has(ep.id)
                      const history = historyMap.get(ep.id)
                      if (aggFailed && !history) {
                        return (
                          <div onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => retryAggregation(ep.id)}
                              className="text-wd-muted/40 hover:text-wd-muted transition-colors flex items-center gap-1.5 text-[11px]"
                            >
                              <Icon icon="solar:refresh-outline" width={16} />
                              Retry
                            </button>
                          </div>
                        )
                      }
                      return (
                        <div
                          className="w-full"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <UptimeBar history={history ?? buildHistory([])} loading={aggLoading} />
                        </div>
                      )
                    })()}

                    {/* Uptime % — rolling 30d from daily summaries */}
                    {(() => {
                      const rolling = uptime30dMap.get(ep.id)
                      const stats = uptimeMap.get(ep.id)
                      const hasAny = stats && (stats['24h'] != null || stats['7d'] != null || stats['30d'] != null || stats['90d'] != null)
                      return (
                        <Tooltip delay={400} closeDelay={0}>
                          <TooltipTrigger className="!block !w-full !text-left !justify-start">
                            <span className={cn('block w-full text-left text-xs font-mono font-medium', rolling != null ? uptimeColor(rolling) : 'text-wd-muted/40')}>
                              {rolling != null ? `${rolling.toFixed(2)}%` : '—'}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className={TIP_CLS}>
                            {hasAny ? (
                              <>
                                {([['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']] as const).map(([key, label]) => {
                                  const v = stats[key]
                                  return v != null
                                    ? <TipRow key={key} label={label} value={`${v}%`} className={uptimeColor(v)} />
                                    : <TipRow key={key} label={label} value="—" className="text-wd-muted" />
                                })}
                                <div className="text-wd-muted/60 mt-1 text-[10px]">Cell shows rolling 30d</div>
                              </>
                            ) : (
                              <div className="text-wd-muted">Waiting for check data</div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })()}

                    {/* Response time (30d avg) */}
                    {(() => {
                      const avg30d = avg30dMap.get(ep.id)
                      const dailies = dailyMap.get(ep.id)
                      const hasDaily = dailies && dailies.length > 0
                      return (
                        <Tooltip delay={400} closeDelay={0}>
                          <TooltipTrigger className="!block !w-full !text-left !justify-start">
                            <span
                              className={cn(
                                'block w-full text-left text-xs font-mono font-medium',
                                avg30d != null
                                  ? latencyColor(avg30d)
                                  : 'text-wd-muted/40',
                              )}
                            >
                              {avg30d != null ? `${avg30d}ms` : '—'}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className={TIP_CLS}>
                            {hasDaily ? (
                              <>
                                {ep.responseTime != null && (
                                  <TipRow label="Latest" value={`${ep.responseTime}ms`} className={latencyColor(ep.responseTime)} />
                                )}
                                {avg30d != null && (
                                  <TipRow label="Avg (30d)" value={`${avg30d}ms`} className={latencyColor(avg30d)} />
                                )}
                                <TipRow label="P95" value={`${Math.max(...dailies.map((d) => d.p95ResponseTime))}ms`} />
                                <TipRow label="Min" value={`${Math.min(...dailies.map((d) => d.minResponseTime))}ms`} />
                                <TipRow label="Max" value={`${Math.max(...dailies.map((d) => d.maxResponseTime))}ms`} className={latencyColor(Math.max(...dailies.map((d) => d.maxResponseTime)))} />
                                <div className="text-wd-muted/60 mt-1 text-[10px]">Rolling 30-day window</div>
                              </>
                            ) : ep.responseTime != null ? (
                              <>
                                <TipRow label="Latest" value={`${ep.responseTime}ms`} className={latencyColor(ep.responseTime)} />
                                <div className="text-wd-muted/60 mt-1 text-[10px]">More stats after aggregation runs</div>
                              </>
                            ) : (
                              <div className="text-wd-muted">No response data yet</div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })()}

                    {/* Last Checked */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger className="!block !w-full !text-left !justify-start">
                        <span className="block w-full text-left text-xs font-mono text-wd-muted">
                          {timeAgo(ep.lastCheckAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        <TipRow label="Checked at" value={formatTime(ep.lastCheckAt)} />
                        <TipRow label="Interval" value={`${ep.checkInterval}s`} />
                      </TooltipContent>
                    </Tooltip>

                    {/* Actions */}
                    <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
                      <Dropdown>
                        <Dropdown.Trigger>
                          <div
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-wd-border/40 transition-colors cursor-pointer"
                            aria-label={`Actions for ${ep.name}`}
                          >
                            <Icon icon="solar:menu-dots-bold" width={16} className="text-wd-muted" />
                          </div>
                        </Dropdown.Trigger>
                        <Dropdown.Popover placement="bottom end" className="!min-w-[180px]">
                          <Dropdown.Menu
                            onAction={(key) => {
                              if (key === 'recheck') handleRecheck(ep.id)
                              else if (key === 'toggle') handleToggle(ep.id)
                              else if (key === 'settings') navigate(`/endpoints/${ep.id}?tab=settings`)
                              else if (key === 'copy-url') {
                                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                  navigator.clipboard.writeText(ep.url).catch(() => {})
                                }
                              }
                              else if (key === 'delete') setConfirmDelete(ep)
                            }}
                          >
                            <Dropdown.Item id="recheck" className="!text-xs">
                              <Icon icon="solar:refresh-linear" width={16} className="mr-1.5" />
                              Check Now
                            </Dropdown.Item>
                            <Dropdown.Item id="toggle" className="!text-xs !text-wd-warning">
                              <Icon
                                icon={
                                  ep.endpointStatus !== 'paused'
                                    ? 'solar:pause-linear'
                                    : 'solar:play-linear'
                                }
                                width={16}
                                className="mr-1.5"
                              />
                              {ep.endpointStatus !== 'paused' ? 'Pause Monitoring' : 'Resume Monitoring'}
                            </Dropdown.Item>
                            <Dropdown.Item id="copy-url" className="!text-xs">
                              <Icon icon="solar:copy-linear" width={16} className="mr-1.5" />
                              Copy {ep.type === 'http' ? 'URL' : 'Address'}
                            </Dropdown.Item>
                            <Dropdown.Item id="settings" className="!text-xs">
                              <Icon icon="solar:settings-linear" width={16} className="mr-1.5" />
                              Settings
                            </Dropdown.Item>
                            <Dropdown.Item id="delete" className="!text-xs !text-wd-danger">
                              <Icon
                                icon="solar:trash-bin-minimalistic-linear"
                                width={16}
                                className="mr-1.5"
                              />
                              Delete Endpoint
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    </div>
                  </div>
                )
              })}
              {hasMore && (
                <div ref={sentinelRef} className="flex justify-center py-3">
                  <Spinner size="sm" />
                </div>
              )}
            </>
          )}
        </ScrollShadow>

        {/* Footer */}
        <div className="shrink-0 px-3 py-1.5 bg-[var(--surface-secondary)] border-t border-wd-border/30 flex items-center gap-3">
          {selected.size > 0 ? (
            <>
              <span className="text-[11px] font-medium text-foreground">
                <span className="font-mono">{selected.size}</span> selected
              </span>
              <div className="flex items-center gap-1.5">
                <Tooltip delay={300} closeDelay={0}>
                  <TooltipTrigger>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      className="!min-w-7 !h-7"
                      onPress={() => handleBulkToggle(selected)}
                    >
                      <Icon icon="solar:pause-outline" width={16} className="text-wd-muted" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="px-2 py-1 text-[11px]">
                    Toggle selected
                  </TooltipContent>
                </Tooltip>
                <Tooltip delay={300} closeDelay={0}>
                  <TooltipTrigger>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      className="!min-w-7 !h-7"
                      onPress={() => handleBulkRecheck(selected)}
                    >
                      <Icon icon="solar:refresh-outline" width={16} className="text-wd-muted" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="px-2 py-1 text-[11px]">
                    Recheck selected
                  </TooltipContent>
                </Tooltip>
                <Tooltip delay={300} closeDelay={0}>
                  <TooltipTrigger>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      className="!min-w-7 !h-7"
                      onPress={() => handleDelete(selected)}
                    >
                      <Icon
                        icon="solar:trash-bin-minimalistic-outline"
                        width={16}
                        className="text-wd-danger"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="px-2 py-1 text-[11px]">
                    Delete selected
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="flex-1" />
              <button
                onClick={() => setSelected(new Set())}
                className="text-[11px] text-wd-muted hover:text-foreground transition-colors"
              >
                Clear Selection
              </button>
            </>
          ) : (
            <span className="text-[11px] text-wd-muted">
              Showing <span className="font-mono">{sorted.length}</span> of <span className="font-mono">{totalEndpoints}</span>
            </span>
          )}
        </div>
      </div>

      {/* ── Delete confirm modal ─────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !deletingOne && setConfirmDelete(null)}
          />
          <div className="relative bg-wd-surface border border-wd-border rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-full bg-wd-danger/10 p-2">
                <Icon
                  icon="solar:trash-bin-minimalistic-linear"
                  width={24}
                  className="text-wd-danger"
                />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Delete Endpoint</h3>
                <p className="text-xs text-wd-muted">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-wd-muted mb-1">
              Are you sure you want to archive{' '}
              <span className="font-medium text-foreground">{confirmDelete.name}</span>?
            </p>
            <p className="text-xs text-wd-muted/60 mb-6">
              The endpoint will be moved to the archived list. Check history and incident data will
              be preserved.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="bordered"
                className="!text-xs"
                isDisabled={deletingOne}
                onPress={() => setConfirmDelete(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="!text-xs !bg-wd-danger !text-white"
                onPress={handleConfirmDeleteOne}
                isDisabled={deletingOne}
              >
                {deletingOne ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={16} />
                    Archive Endpoint
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
