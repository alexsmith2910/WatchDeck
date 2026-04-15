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

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface ApiEndpoint {
  _id: string
  name: string
  type: 'http' | 'port'
  url?: string
  host?: string
  port?: number
  method?: string
  expectedStatusCodes?: number[]
  checkInterval: number
  timeout: number
  enabled: boolean
  status: 'active' | 'paused' | 'archived'
  lastStatus?: 'healthy' | 'degraded' | 'down'
  lastCheckAt?: string
  lastResponseTime?: number
  lastStatusCode?: number | null
  lastErrorMessage?: string | null
  consecutiveFailures: number
}

interface ApiPagination {
  limit: number
  hasMore: boolean
  nextCursor: string | null
  prevCursor: string | null
  total: number
}

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

type EndpointStatus = 'healthy' | 'degraded' | 'down'
type StatusFilter = 'all' | EndpointStatus
type TypeFilter = 'all' | 'http' | 'port'

interface Endpoint {
  id: string
  name: string
  type: 'http' | 'port'
  url: string
  status: EndpointStatus | null
  enabled: boolean
  checkInterval: number
  consecutiveFailures: number
  lastCheckAt: Date | null
  method?: string
  expectedStatusCodes?: number[]
  // Live data from SSE check:complete
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
    enabled: doc.enabled,
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

function timeAgo(date: Date | null): string {
  if (!date) return 'Never'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatTime(date: Date | null): string {
  if (!date) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
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

const typeConfig: Record<'http' | 'port', { label: string; icon: string; color: string }> = {
  http: { label: 'HTTP', icon: 'solar:global-outline', color: 'text-wd-primary' },
  port: { label: 'PORT', icon: 'solar:plug-circle-outline', color: 'text-wd-muted' },
}

const typeFilterLabels: Record<TypeFilter, string> = {
  all: 'All Types',
  http: 'HTTP',
  port: 'Port',
}

function latencyColor(ms: number) {
  if (ms === 0) return 'text-wd-muted'
  if (ms < 200) return 'text-wd-success'
  if (ms < 500) return 'text-wd-warning'
  return 'text-wd-danger'
}

const statusOrder: Record<EndpointStatus, number> = { down: 0, degraded: 1, healthy: 2 }

function TipRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex gap-4">
      <span className="text-wd-muted shrink-0 whitespace-nowrap">{label}</span>
      <span className={cn('font-medium ml-auto text-right', className)}>{value}</span>
    </div>
  )
}

const TIP_CLS = 'px-3 py-2 text-[11px] leading-relaxed min-w-[220px] max-w-[320px]'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_LIMIT = 100
const GRID_COLS = 'grid-cols-[32px_40px_100px_1fr_90px_100px_100px_80px]'

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

  // UI state
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sort, setSort] = useState({ col: 'status', asc: true })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Rolling response time history from SSE (last N checks per endpoint)
  const responseHistory = useRef<Map<string, number[]>>(new Map())
  const HISTORY_SIZE = 20

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch endpoints')
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    fetchEndpoints()
  }, [fetchEndpoints])

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

  // ── SSE subscriptions ─────────────────────────────────────────────────────

  // check:complete — update endpoint with live check data + track history
  useEffect(() => {
    return subscribe('check:complete', (raw) => {
      const evt = raw as CheckCompleteEvent

      // Track response time history
      if (evt.responseTime > 0) {
        const hist = responseHistory.current
        const arr = hist.get(evt.endpointId) ?? []
        arr.push(evt.responseTime)
        if (arr.length > HISTORY_SIZE) arr.shift()
        hist.set(evt.endpointId, arr)
      }

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
            ...(c.enabled !== undefined && { enabled: c.enabled }),
            ...(c.checkInterval !== undefined && { checkInterval: c.checkInterval }),
            // If archived, remove from active list
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

  const handleToggle = useCallback(
    async (id: string) => {
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
        return ((a.responseTime ?? 0) - (b.responseTime ?? 0)) * dir
      }
      const aVal = a[col as keyof Endpoint] ?? ''
      const bVal = b[col as keyof Endpoint] ?? ''
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir
      return String(aVal).localeCompare(String(bVal)) * dir
    })
  }, [filtered, sort])

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
              <Icon icon="solar:magnifer-outline" width={15} className="text-wd-muted" />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search name, URL..." className="!text-xs" />
            <SearchField.ClearButton>
              <Icon icon="solar:close-circle-outline" width={14} className="text-wd-muted" />
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
                'dark:data-[selected=true]:!bg-wd-primary/50',
              )}
            >
              {f.label}
              <span className="ml-1 text-[10px] opacity-60">{statusCounts[f.key]}</span>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Dropdown>
          <Dropdown.Trigger>
            <Button size="sm" variant="ghost" className="!text-xs !h-8 !px-3">
              <Icon icon="solar:filter-outline" width={14} className="text-wd-muted" />
              {typeFilterLabels[typeFilter]}
            </Button>
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
              onPress={fetchEndpoints}
            >
              <Icon icon="solar:refresh-outline" width={16} className="text-wd-muted" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1 text-[11px]">Refresh all</TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          className="!bg-wd-primary dark:!bg-wd-primary/50 !text-wd-primary-foreground !text-xs !px-4"
        >
          <Icon icon="solar:add-circle-outline" width={22} />
          Add Endpoint
        </Button>
      </div>

      {/* Table */}
      <div className="wd-endpoints-table-container flex flex-col flex-1 min-h-0 border border-wd-border/30 rounded-lg overflow-hidden">
        {/* Column header */}
        <div
          className={cn(
            'grid items-center gap-x-2 px-3 py-2 shrink-0',
            'bg-[var(--surface-secondary)] border-b border-wd-border/30',
            'text-[11px] font-medium text-wd-muted select-none',
            GRID_COLS,
          )}
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
          <span>#</span>
          {(
            [
              ['status', 'Status'],
              ['name', 'Name'],
              ['type', 'Type'],
              ['responseTime', 'Response'],
            ] as const
          ).map(([col, label]) => (
            <button
              key={col}
              onClick={() => handleSort(col)}
              className="flex items-center gap-1 hover:text-foreground transition-colors text-left"
            >
              {label}
              {sort.col === col && (
                <Icon
                  icon={sort.asc ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'}
                  width={12}
                />
              )}
            </button>
          ))}
          <span>Last Checked</span>
          <span />
        </div>

        {/* Rows */}
        <ScrollShadow
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
                  className="!bg-wd-primary dark:!bg-wd-primary/50 !text-wd-primary-foreground !text-xs !px-4"
                >
                  <Icon icon="solar:add-circle-outline" width={22} />
                  Add Endpoint
                </Button>
              )}
            </div>
          ) : (
            <>
              {sorted.map((ep, idx) => {
                const sc = ep.status ? statusConfig[ep.status] : pendingStatus
                const tc = typeConfig[ep.type]
                return (
                  <div
                    key={ep.id}
                    role="row"
                    className={cn(
                      'grid items-center gap-x-2 px-3 py-2 cursor-pointer transition-colors',
                      'border-b border-wd-border/10 hover:bg-wd-surface-hover',
                      !ep.enabled && 'opacity-50',
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

                    {/* # */}
                    <span className="text-[11px] text-wd-muted/50">{idx + 1}</span>

                    {/* Status */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger>
                        <div className="flex items-center gap-2">
                          <span className={cn('h-2 w-2 rounded-full shrink-0', sc.dot)} />
                          <span className={cn('text-xs font-medium', sc.text)}>{sc.label}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        {ep.errorMessage && (
                          <TipRow
                            label="Reason"
                            value={ep.errorMessage}
                            className="text-wd-danger"
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
                          />
                        )}
                        {!ep.enabled && (
                          <div className="text-wd-warning">Endpoint is paused</div>
                        )}
                        {ep.status === 'healthy' && !ep.errorMessage && ep.enabled && (
                          <div className="text-wd-success">All checks passing</div>
                        )}
                        {ep.status === null && (
                          <div className="text-wd-muted">Waiting for first check</div>
                        )}
                      </TooltipContent>
                    </Tooltip>

                    {/* Name + URL */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger>
                        <div className="flex flex-col min-w-0 text-left">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground truncate">
                              {ep.name}
                            </span>
                            {!ep.enabled && (
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-wd-warning bg-wd-warning/10 px-1.5 py-0.5 rounded">
                                Paused
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-wd-muted truncate">{ep.url}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        <TipRow label="Interval" value={`Every ${ep.checkInterval}s`} />
                        {ep.method && (
                          <TipRow
                            label="Method"
                            value={`${ep.method} · expect ${ep.expectedStatusCodes?.join(', ') ?? '2xx'}`}
                          />
                        )}
                        {ep.type === 'port' && <TipRow label="Protocol" value="TCP" />}
                      </TooltipContent>
                    </Tooltip>

                    {/* Type */}
                    <div className="flex items-center gap-1.5">
                      <Icon icon={tc.icon} width={14} className={tc.color} />
                      <span className="text-[11px] font-medium text-wd-muted">{tc.label}</span>
                    </div>

                    {/* Response time */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger>
                        <span
                          className={cn(
                            'text-sm font-medium',
                            ep.responseTime != null
                              ? latencyColor(ep.responseTime)
                              : 'text-wd-muted',
                          )}
                        >
                          {ep.responseTime != null ? `${ep.responseTime}ms` : '—'}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        {(() => {
                          const hist = responseHistory.current.get(ep.id)
                          if (hist && hist.length > 1) {
                            const min = Math.min(...hist)
                            const max = Math.max(...hist)
                            const avg = Math.round(hist.reduce((a, b) => a + b, 0) / hist.length)
                            return (
                              <>
                                <TipRow label="Latest" value={`${ep.responseTime}ms`} className={latencyColor(ep.responseTime!)} />
                                <TipRow label="Avg" value={`${avg}ms`} className={latencyColor(avg)} />
                                <TipRow label="Min" value={`${min}ms`} />
                                <TipRow label="Max" value={`${max}ms`} className={latencyColor(max)} />
                                <div className="text-wd-muted/60 mt-1 text-[10px]">Last {hist.length} checks this session</div>
                              </>
                            )
                          }
                          if (ep.responseTime != null) {
                            return (
                              <>
                                <TipRow label="Latest" value={`${ep.responseTime}ms`} className={latencyColor(ep.responseTime)} />
                                <div className="text-wd-muted/60 mt-1 text-[10px]">More stats after a few checks</div>
                              </>
                            )
                          }
                          return <div className="text-wd-muted">No response data yet</div>
                        })()}
                      </TooltipContent>
                    </Tooltip>

                    {/* Last Checked */}
                    <Tooltip delay={400} closeDelay={0}>
                      <TooltipTrigger>
                        <span className="text-xs text-wd-muted">
                          {timeAgo(ep.lastCheckAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className={TIP_CLS}>
                        <TipRow label="Checked at" value={formatTime(ep.lastCheckAt)} />
                        <TipRow label="Interval" value={`${ep.checkInterval}s`} />
                      </TooltipContent>
                    </Tooltip>

                    {/* Actions */}
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Tooltip delay={300} closeDelay={0}>
                        <TooltipTrigger>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            className="!min-w-7 !h-7"
                            onPress={() => handleRecheck(ep.id)}
                          >
                            <Icon
                              icon="solar:refresh-outline"
                              width={15}
                              className="text-wd-muted"
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="px-2 py-1 text-[11px]">
                          Recheck now
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip delay={300} closeDelay={0}>
                        <TooltipTrigger>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            className="!min-w-7 !h-7"
                            onPress={() => handleToggle(ep.id)}
                          >
                            <Icon
                              icon={
                                ep.enabled
                                  ? 'solar:pause-outline'
                                  : 'solar:play-outline'
                              }
                              width={15}
                              className="text-wd-muted"
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="px-2 py-1 text-[11px]">
                          {ep.enabled ? 'Pause' : 'Resume'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )
              })}
              {hasMore && (
                <div className="flex justify-center py-3">
                  {loadingMore ? (
                    <Spinner size="sm" />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="!text-xs"
                      onPress={handleLoadMore}
                    >
                      Load more
                    </Button>
                  )}
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
                {selected.size} selected
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
                      <Icon icon="solar:pause-outline" width={14} className="text-wd-muted" />
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
                      <Icon icon="solar:refresh-outline" width={14} className="text-wd-muted" />
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
                        width={14}
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
                Clear selection
              </button>
            </>
          ) : (
            <span className="text-[11px] text-wd-muted">
              Showing {sorted.length} of {endpoints.length}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
