import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Button,
  Spinner,
  Separator,
  DateRangePicker,
  DateField,
  RangeCalendar,
  Dropdown,
  Header,
  Label,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { CalendarDate } from '@internationalized/date'
import { Icon } from '@iconify/react'
import { useApi } from '../../hooks/useApi'
import { useSSE } from '../../hooks/useSSE'
import type { ApiCheck, ApiIncident, ApiPagination } from '../../types/api'
import { formatDateTime, statusColors, latencyColor, formatDuration, timeAgo } from '../../utils/format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'healthy' | 'degraded' | 'down'
type SortField = 'timestamp' | 'status' | 'responseTime' | 'statusCode'
type SortDir = 'asc' | 'desc'

interface ChecksTabProps {
  endpointId: string
  endpointType: 'http' | 'port'
  initialExpandedId?: string | null
}

const STATUS_ORDER: Record<string, number> = { down: 0, degraded: 1, healthy: 2 }

// ---------------------------------------------------------------------------
// HTTP status code definitions with color categories
// ---------------------------------------------------------------------------

interface StatusCodeDef {
  code: number
  label: string
  color: 'text-wd-warning' | 'text-wd-danger' | 'text-wd-muted'
  dotColor: 'bg-wd-warning' | 'bg-wd-danger' | 'bg-wd-muted'
}

const HTTP_STATUS_CODES: StatusCodeDef[] = [
  // 4xx Client Errors
  { code: 400, label: 'Bad Request', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  { code: 401, label: 'Unauthorized', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  { code: 403, label: 'Forbidden', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  { code: 404, label: 'Not Found', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  { code: 408, label: 'Request Timeout', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  { code: 429, label: 'Too Many Requests', color: 'text-wd-warning', dotColor: 'bg-wd-warning' },
  // 5xx Server Errors
  { code: 500, label: 'Internal Server Error', color: 'text-wd-danger', dotColor: 'bg-wd-danger' },
  { code: 502, label: 'Bad Gateway', color: 'text-wd-danger', dotColor: 'bg-wd-danger' },
  { code: 503, label: 'Service Unavailable', color: 'text-wd-danger', dotColor: 'bg-wd-danger' },
  { code: 504, label: 'Gateway Timeout', color: 'text-wd-danger', dotColor: 'bg-wd-danger' },
]

// Build a lookup for dynamic codes from the loaded checks
function buildDynamicCodes(checks: ApiCheck[]): StatusCodeDef[] {
  const seen = new Set<number>()
  for (const c of checks) {
    if (c.statusCode != null && c.statusCode >= 400) {
      seen.add(c.statusCode)
    }
  }
  // Include only codes that actually appear in the data
  const defs: StatusCodeDef[] = []
  for (const code of [...seen].sort((a, b) => a - b)) {
    const known = HTTP_STATUS_CODES.find((s) => s.code === code)
    if (known) {
      defs.push(known)
    } else {
      // Unknown code — classify by range
      const is5xx = code >= 500
      defs.push({
        code,
        label: `HTTP ${code}`,
        color: is5xx ? 'text-wd-danger' : 'text-wd-warning',
        dotColor: is5xx ? 'bg-wd-danger' : 'bg-wd-warning',
      })
    }
  }
  return defs
}

// ---------------------------------------------------------------------------
// ChecksTab
// ---------------------------------------------------------------------------

export default function ChecksTab({ endpointId, endpointType, initialExpandedId }: ChecksTabProps) {
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [checks, setChecks] = useState<ApiCheck[]>([])
  const [pagination, setPagination] = useState<ApiPagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateRange, setDateRange] = useState<{ start: CalendarDate; end: CalendarDate } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedErrorCodes, setSelectedErrorCodes] = useState<Set<number>>(new Set())
  const [sortField, setSortField] = useState<SortField>('timestamp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null)
  const [expandedIncidents, setExpandedIncidents] = useState<ApiIncident[]>([])
  const [loadingIncidents, setLoadingIncidents] = useState(false)
  const expandedRef = useRef<HTMLDivElement>(null)

  // Sync expandedId when parent changes initialExpandedId (e.g. clicking a check on overview tab)
  useEffect(() => {
    if (initialExpandedId) {
      setExpandedId(initialExpandedId)
    }
  }, [initialExpandedId])

  // Scroll the expanded item into view (re-run after data loads so the ref is attached)
  useEffect(() => {
    if (expandedId && expandedRef.current) {
      expandedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [expandedId, loading])

  // Dynamic error codes from loaded checks
  const dynamicCodes = useMemo(() => buildDynamicCodes(checks), [checks])

  // Fetch checks
  const fetchChecks = useCallback(
    async (cursor?: string) => {
      if (!cursor) setLoading(true)
      else setLoadingMore(true)

      let url = `/endpoints/${endpointId}/checks?limit=20`
      if (cursor) url += `&cursor=${cursor}`
      if (statusFilter !== 'all') url += `&status=${statusFilter}`
      if (dateRange) {
        const from = new Date(dateRange.start.year, dateRange.start.month - 1, dateRange.start.day).toISOString()
        const to = new Date(dateRange.end.year, dateRange.end.month - 1, dateRange.end.day, 23, 59, 59).toISOString()
        url += `&from=${from}&to=${to}`
      }

      const res = await request<{ data: ApiCheck[]; pagination: ApiPagination }>(url)
      if (res.status < 400) {
        const items = res.data.data ?? []
        if (cursor) setChecks((prev) => [...prev, ...items])
        else setChecks(items)
        setPagination(res.data.pagination ?? null)
      }

      setLoading(false)
      setLoadingMore(false)
    },
    [endpointId, request, statusFilter, dateRange],
  )

  useEffect(() => {
    fetchChecks()
  }, [fetchChecks])

  // SSE: prepend new checks
  useEffect(() => {
    const unsub = subscribe('check:complete', (data: unknown) => {
      const payload = data as {
        endpointId: string
        status: string
        responseTime: number
        statusCode?: number
        timestamp: string
      }
      if (payload.endpointId !== endpointId) return

      const newCheck: ApiCheck = {
        _id: `live-${Date.now()}`,
        endpointId: payload.endpointId,
        timestamp: payload.timestamp,
        responseTime: payload.responseTime,
        statusCode: payload.statusCode,
        status: payload.status as ApiCheck['status'],
        duringMaintenance: false,
      }

      if (statusFilter !== 'all' && newCheck.status !== statusFilter) return
      setChecks((prev) => [newCheck, ...prev])
    })
    return unsub
  }, [endpointId, subscribe, statusFilter])

  // Client-side sort + filter
  const processedChecks = useMemo(() => {
    let result = [...checks]

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (c) =>
          c._id.toLowerCase().includes(q) ||
          (c.errorMessage && c.errorMessage.toLowerCase().includes(q)) ||
          (c.statusCode != null && String(c.statusCode).includes(q)) ||
          (c.statusReason && c.statusReason.toLowerCase().includes(q)),
      )
    }

    // Error code filter (multi-select)
    if (selectedErrorCodes.size > 0) {
      result = result.filter((c) => c.statusCode != null && selectedErrorCodes.has(c.statusCode))
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'timestamp':
          cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          break
        case 'status':
          cmp = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)
          break
        case 'responseTime':
          cmp = a.responseTime - b.responseTime
          break
        case 'statusCode':
          cmp = (a.statusCode ?? 0) - (b.statusCode ?? 0)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return result
  }, [checks, searchQuery, selectedErrorCodes, sortField, sortDir])

  // Fetch related incidents when a check is expanded
  const handleExpand = useCallback(
    async (checkId: string, timestamp: string) => {
      if (expandedId === checkId) {
        setExpandedId(null)
        return
      }
      setExpandedId(checkId)
      setExpandedIncidents([])
      setLoadingIncidents(true)

      const checkTime = new Date(timestamp).getTime()
      const from = new Date(checkTime - 5 * 60 * 1000).toISOString()
      const to = new Date(checkTime + 5 * 60 * 1000).toISOString()
      const res = await request<{ data: ApiIncident[] }>(
        `/incidents?endpointId=${endpointId}&from=${from}&to=${to}&limit=5`,
      )
      if (res.status < 400) setExpandedIncidents(res.data.data ?? [])
      setLoadingIncidents(false)
    },
    [endpointId, expandedId, request],
  )

  // Toggle sort
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'timestamp' ? 'desc' : 'asc')
    }
  }

  // Dropdown selection handler
  const handleErrorCodeSelection = (keys: Selection) => {
    if (keys === 'all') {
      setSelectedErrorCodes(new Set(dynamicCodes.map((d) => d.code)))
    } else {
      setSelectedErrorCodes(new Set([...keys].map((k) => Number(k))))
    }
  }

  const statusFilters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'healthy', label: 'Healthy' },
    { id: 'degraded', label: 'Degraded' },
    { id: 'down', label: 'Down' },
  ]

  return (
    <div className="space-y-4">
      {/* ── Filters Row 1: Status + Date Range ────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1">
          {statusFilters.map((f) => {
            const sc = f.id !== 'all' ? statusColors[f.id] : null
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                  statusFilter === f.id
                    ? f.id === 'all'
                      ? 'bg-wd-primary/10 text-wd-primary'
                      : `${sc!.bg} ${sc!.text}`
                    : 'text-wd-muted hover:text-foreground hover:bg-wd-surface-hover',
                )}
              >
                {sc && <span className={cn('h-2 w-2 rounded-full', sc.dot)} />}
                {f.label}
              </button>
            )
          })}
        </div>

        <DateRangePicker
          value={dateRange}
          onChange={setDateRange}
          aria-label="Filter by date range"
          className="max-w-xs"
        >
          <DateField.Group className="!h-8 !min-h-0 !text-xs !rounded-lg !border-wd-border/50 !bg-wd-surface-hover/50">
            <DateField.Input slot="start">
              {(segment) => <DateField.Segment segment={segment} />}
            </DateField.Input>
            <DateRangePicker.RangeSeparator />
            <DateField.Input slot="end">
              {(segment) => <DateField.Segment segment={segment} />}
            </DateField.Input>
            <DateField.Suffix>
              <DateRangePicker.Trigger>
                <DateRangePicker.TriggerIndicator />
              </DateRangePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DateRangePicker.Popover>
            <RangeCalendar aria-label="Filter by date range">
              <RangeCalendar.Header>
                <RangeCalendar.YearPickerTrigger>
                  <RangeCalendar.YearPickerTriggerHeading />
                  <RangeCalendar.YearPickerTriggerIndicator />
                </RangeCalendar.YearPickerTrigger>
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </RangeCalendar.Header>
              <RangeCalendar.Grid>
                <RangeCalendar.GridHeader>
                  {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
                </RangeCalendar.GridHeader>
                <RangeCalendar.GridBody>
                  {(date) => <RangeCalendar.Cell date={date} />}
                </RangeCalendar.GridBody>
              </RangeCalendar.Grid>
              <RangeCalendar.YearPickerGrid>
                <RangeCalendar.YearPickerGridBody>
                  {({year}) => <RangeCalendar.YearPickerCell year={year} />}
                </RangeCalendar.YearPickerGridBody>
              </RangeCalendar.YearPickerGrid>
            </RangeCalendar>
          </DateRangePicker.Popover>
        </DateRangePicker>
      </div>

      {/* ── Filters Row 2: Search + Error Code Dropdown ──────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Icon
            icon="solar:magnifer-linear"
            width={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-wd-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by ID, error, status code..."
            className="w-full text-xs bg-wd-surface border border-wd-border/50 rounded-lg pl-8 pr-3 py-1.5 text-foreground placeholder:text-wd-muted/50 focus:outline-none focus:border-wd-primary/50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-wd-muted hover:text-foreground cursor-pointer"
            >
              <Icon icon="solar:close-circle-linear" width={14} />
            </button>
          )}
        </div>

        {/* Error code multi-select dropdown */}
        {endpointType === 'http' && dynamicCodes.length > 0 && (
          <Dropdown>
            <button
              type="button"
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border',
                selectedErrorCodes.size > 0
                  ? 'bg-wd-danger/5 text-wd-danger border-wd-danger/20'
                  : 'text-wd-muted border-wd-border/50 hover:text-foreground hover:bg-wd-surface-hover/50',
              )}
            >
              <Icon icon="solar:filter-linear" width={13} />
              {selectedErrorCodes.size > 0
                ? `${selectedErrorCodes.size} code${selectedErrorCodes.size > 1 ? 's' : ''}`
                : 'Error Codes'}
              <Icon icon="solar:alt-arrow-down-linear" width={12} className="text-wd-muted" />
            </button>
            <Dropdown.Popover placement="bottom start" className="!min-w-[240px]">
              <Dropdown.Menu>
                {dynamicCodes.some((d) => d.code >= 400 && d.code < 500) && (
                  <Dropdown.Section
                    selectionMode="multiple"
                    selectedKeys={new Set([...selectedErrorCodes].filter((c) => c >= 400 && c < 500).map(String))}
                    onSelectionChange={(keys) => {
                      const codes4xx = keys === 'all'
                        ? dynamicCodes.filter((d) => d.code >= 400 && d.code < 500).map((d) => d.code)
                        : [...keys].map((k) => Number(k))
                      const existing5xx = [...selectedErrorCodes].filter((c) => c >= 500)
                      setSelectedErrorCodes(new Set([...codes4xx, ...existing5xx]))
                    }}
                  >
                    <Header>4xx Client Errors</Header>
                    {dynamicCodes
                      .filter((d) => d.code >= 400 && d.code < 500)
                      .map((d) => (
                        <Dropdown.Item key={String(d.code)} id={String(d.code)} textValue={`${d.code} ${d.label}`}>
                          <Dropdown.ItemIndicator />
                          <Label className={cn('!text-xs !font-mono !font-semibold', d.color)}>{d.code}</Label>
                          <span className="text-[11px] text-wd-muted ml-auto">{d.label}</span>
                        </Dropdown.Item>
                      ))}
                  </Dropdown.Section>
                )}
                {dynamicCodes.some((d) => d.code >= 400 && d.code < 500) && dynamicCodes.some((d) => d.code >= 500) && (
                  <Separator />
                )}
                {dynamicCodes.some((d) => d.code >= 500) && (
                  <Dropdown.Section
                    selectionMode="multiple"
                    selectedKeys={new Set([...selectedErrorCodes].filter((c) => c >= 500).map(String))}
                    onSelectionChange={(keys) => {
                      const codes5xx = keys === 'all'
                        ? dynamicCodes.filter((d) => d.code >= 500).map((d) => d.code)
                        : [...keys].map((k) => Number(k))
                      const existing4xx = [...selectedErrorCodes].filter((c) => c >= 400 && c < 500)
                      setSelectedErrorCodes(new Set([...existing4xx, ...codes5xx]))
                    }}
                  >
                    <Header>5xx Server Errors</Header>
                    {dynamicCodes
                      .filter((d) => d.code >= 500)
                      .map((d) => (
                        <Dropdown.Item key={String(d.code)} id={String(d.code)} textValue={`${d.code} ${d.label}`}>
                          <Dropdown.ItemIndicator />
                          <Label className={cn('!text-xs !font-mono !font-semibold', d.color)}>{d.code}</Label>
                          <span className="text-[11px] text-wd-muted ml-auto">{d.label}</span>
                        </Dropdown.Item>
                      ))}
                  </Dropdown.Section>
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}

        {/* Clear filters */}
        {(selectedErrorCodes.size > 0 || dateRange || searchQuery) && (
          <button
            type="button"
            onClick={() => {
              setSelectedErrorCodes(new Set())
              setDateRange(null)
              setSearchQuery('')
              setStatusFilter('all')
            }}
            className="text-[11px] text-wd-muted hover:text-foreground cursor-pointer"
          >
            Clear all
          </button>
        )}
      </div>

      {/* ── Check List ────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Spinner size="md" />
        </div>
      ) : processedChecks.length === 0 ? (
        <div className="text-center py-12 text-wd-muted">
          <Icon icon="solar:checklist-minimalistic-linear" width={36} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No checks found</p>
          <p className="text-xs text-wd-muted/60 mt-1">Adjust your filters or wait for new checks</p>
        </div>
      ) : (
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl overflow-hidden">
          {/* Sortable header */}
          <div className="grid grid-cols-[32px_1fr_100px_90px_80px_32px] gap-2 px-4 py-2.5 border-b border-wd-border/50 bg-wd-surface-hover/30">
            <span />
            <SortHeader field="timestamp" label="Date & Time" current={sortField} dir={sortDir} onSort={handleSort} />
            <SortHeader field="status" label="Status" current={sortField} dir={sortDir} onSort={handleSort} />
            <SortHeader field="responseTime" label="Response" current={sortField} dir={sortDir} onSort={handleSort} align="right" />
            <SortHeader
              field="statusCode"
              label={endpointType === 'http' ? 'Code' : 'Port'}
              current={sortField}
              dir={sortDir}
              onSort={handleSort}
              align="right"
            />
            {/* Export menu */}
            <Dropdown>
              <Dropdown.Trigger>
                <button
                  type="button"
                  className="p-0.5 rounded text-wd-muted hover:text-foreground transition-colors cursor-pointer"
                  aria-label="Table options"
                >
                  <Icon icon="solar:menu-dots-bold" width={14} />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end" className="!min-w-[160px]">
                <Dropdown.Menu>
                  <Dropdown.Item id="export-csv" className="!text-xs">Export as CSV</Dropdown.Item>
                  <Dropdown.Item id="export-json" className="!text-xs">Export as JSON</Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>

          {/* Check rows */}
          {processedChecks.map((check) => {
            const isExpanded = expandedId === check._id
            const sc = statusColors[check.status]

            return (
              <div key={check._id} ref={isExpanded ? expandedRef : undefined}>
                <button
                  type="button"
                  onClick={() => handleExpand(check._id, check.timestamp)}
                  className={cn(
                    'w-full grid grid-cols-[32px_1fr_100px_90px_80px_32px] gap-2 px-4 py-2.5 text-left transition-colors cursor-pointer',
                    'hover:bg-wd-surface-hover/50',
                    isExpanded && 'bg-wd-surface-hover/30',
                    check.duringMaintenance && 'opacity-60',
                  )}
                >
                  <div className="flex items-center justify-center">
                    <Icon
                      icon="solar:alt-arrow-right-linear"
                      width={14}
                      className={cn(
                        'text-wd-muted transition-transform duration-200',
                        isExpanded && 'rotate-90',
                      )}
                    />
                  </div>

                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-foreground font-medium truncate">
                      {formatDateTime(check.timestamp)}
                    </span>
                    {check.duringMaintenance && (
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-wd-muted/10 text-wd-muted">
                        MAINT
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', sc.dot)} />
                    <span className={cn('text-xs font-medium capitalize', sc.text)}>{check.status}</span>
                  </div>

                  <span className={cn('text-xs font-mono text-right', latencyColor(check.responseTime))}>
                    {check.responseTime}ms
                  </span>

                  <span className="text-xs font-mono text-right text-wd-muted">
                    {endpointType === 'http'
                      ? check.statusCode ?? '—'
                      : check.portOpen != null
                        ? check.portOpen
                          ? 'Open'
                          : 'Closed'
                        : '—'}
                  </span>
                  <span />
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-wd-border/30 bg-wd-surface-hover/20 px-4 py-4 pl-12">
                    <div className="grid grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-3">
                      <DetailField label="Response Time" value={`${check.responseTime}ms`} />
                      <DetailField label="Status" value={check.status} />
                      {check.statusReason && <DetailField label="Status Reason" value={check.statusReason} />}
                      {endpointType === 'http' && (
                        <DetailField label="Status Code" value={check.statusCode != null ? String(check.statusCode) : '—'} />
                      )}
                      {endpointType === 'port' && (
                        <DetailField label="Port Open" value={check.portOpen != null ? (check.portOpen ? 'Yes' : 'No') : '—'} />
                      )}
                      {check.sslDaysRemaining != null && (
                        <DetailField
                          label="SSL Days Remaining"
                          value={String(check.sslDaysRemaining)}
                          valueClass={check.sslDaysRemaining <= 14 ? 'text-wd-warning' : 'text-wd-success'}
                        />
                      )}
                      <DetailField
                        label="During Maintenance"
                        value={check.duringMaintenance ? 'Yes' : 'No'}
                      />
                      <DetailField label="Timestamp" value={formatDateTime(check.timestamp)} />
                      <DetailField label="Check ID" value={check._id} mono />
                    </div>

                    {check.errorMessage && (
                      <div className="mt-3 rounded-lg bg-wd-danger/5 border border-wd-danger/10 px-3 py-2">
                        <span className="text-[10px] font-medium text-wd-danger uppercase tracking-wider">Error</span>
                        <p className="text-xs text-wd-danger/80 mt-0.5 break-all">{check.errorMessage}</p>
                      </div>
                    )}

                    {check.bodyValidation && (
                      <div className="mt-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Icon
                            icon={check.bodyValidation.passed ? 'solar:check-circle-linear' : 'solar:close-circle-linear'}
                            width={14}
                            className={check.bodyValidation.passed ? 'text-wd-success' : 'text-wd-danger'}
                          />
                          <span className="text-xs font-medium text-foreground">
                            Body Validation — {check.bodyValidation.passed ? 'Passed' : 'Failed'}
                          </span>
                        </div>
                        {check.bodyValidation.results.length > 0 && (
                          <div className="space-y-1 pl-5">
                            {check.bodyValidation.results.map((r, i) => (
                              <div key={i} className="text-[11px] text-wd-muted">
                                {r.rule && <span className="font-medium text-foreground">{r.rule}: </span>}
                                {r.actual && <span>got &quot;{r.actual}&quot;</span>}
                                {r.error && <span className="text-wd-danger"> — {r.error}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <Separator className="!bg-wd-border/30 my-3" />
                    <div>
                      <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
                        Related Incidents
                      </span>
                      {loadingIncidents ? (
                        <div className="flex items-center gap-2 mt-2">
                          <Spinner size="sm" />
                          <span className="text-xs text-wd-muted">Loading...</span>
                        </div>
                      ) : expandedIncidents.length === 0 ? (
                        <p className="text-xs text-wd-muted/60 mt-1.5">No incidents around this check</p>
                      ) : (
                        <div className="space-y-1.5 mt-2">
                          {expandedIncidents.map((inc) => {
                            const isActive = inc.status === 'active'
                            return (
                              <div
                                key={inc._id}
                                className={cn(
                                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2',
                                  isActive
                                    ? 'bg-wd-danger/5 border border-wd-danger/10'
                                    : 'bg-wd-surface-hover/40',
                                )}
                              >
                                <span
                                  className={cn(
                                    'h-2 w-2 rounded-full shrink-0',
                                    isActive ? 'bg-wd-danger' : 'bg-wd-muted',
                                  )}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium text-foreground truncate">
                                    {inc.cause}
                                    {inc.causeDetail && (
                                      <span className="text-wd-muted font-normal"> — {inc.causeDetail}</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-wd-muted">
                                    {isActive
                                      ? `Started ${timeAgo(inc.startedAt)}`
                                      : `Lasted ${inc.durationSeconds ? formatDuration(inc.durationSeconds) : '—'}`}
                                    {' · '}{inc.notificationsSent} notification{inc.notificationsSent !== 1 ? 's' : ''}
                                  </div>
                                </div>
                                <span
                                  className={cn(
                                    'text-[10px] font-medium px-2 py-0.5 rounded-full',
                                    isActive ? 'bg-wd-danger/10 text-wd-danger' : 'bg-wd-surface-hover text-wd-muted',
                                  )}
                                >
                                  {isActive ? 'Active' : 'Resolved'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Load More ─────────────────────────────────────────────── */}
      {pagination?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="bordered"
            className="!text-xs"
            onPress={() => {
              if (pagination.nextCursor) fetchChecks(pagination.nextCursor)
            }}
            isDisabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <Spinner size="sm" className="mr-1" />
                Loading...
              </>
            ) : (
              <>
                <Icon icon="solar:arrow-down-linear" width={14} className="mr-1" />
                Load More ({pagination.total - checks.length} remaining)
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

function SortHeader({
  field,
  label,
  current,
  dir,
  onSort,
  align,
}: {
  field: SortField
  label: string
  current: SortField
  dir: SortDir
  onSort: (f: SortField) => void
  align?: 'right'
}) {
  const isActive = current === field
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        'flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider cursor-pointer transition-colors',
        align === 'right' && 'justify-end',
        isActive ? 'text-foreground' : 'text-wd-muted hover:text-foreground',
      )}
    >
      {label}
      <Icon
        icon={isActive && dir === 'asc' ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'}
        width={12}
        className={isActive ? 'text-wd-primary' : 'text-wd-muted/40'}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Detail field helper
// ---------------------------------------------------------------------------

function DetailField({
  label,
  value,
  valueClass,
  mono,
}: {
  label: string
  value: string
  valueClass?: string
  mono?: boolean
}) {
  return (
    <div>
      <span className="text-[10px] text-wd-muted uppercase tracking-wider block">{label}</span>
      <span
        className={cn(
          'text-xs font-medium text-foreground mt-0.5 block',
          mono && 'font-mono text-[11px] text-wd-muted',
          valueClass,
        )}
      >
        {value}
      </span>
    </div>
  )
}
