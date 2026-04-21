/**
 * Delivery log — table of every dispatch attempt with filters.
 *
 * Layout cribs from the design: a single header row with search + status
 * toggle pills + channel/severity selects, then a dense table of rows. Rows
 * expose retry for failed dispatches; clicking opens the detail drawer.
 *
 * Pagination is cursor-based, filter changes reset the cursor.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Dropdown,
  SearchField,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi'
import { timeAgo } from '../../utils/format'
import { toast } from '../../ui/toast'
import type {
  ApiChannel,
  ApiNotificationLogRow,
  DeliveryStatus,
  NotificationKind,
  NotificationSeverity,
} from '../../types/notifications'
import {
  CHANNEL_TYPE_ICON,
  KIND_COLOR,
  KIND_LABEL,
  SEVERITY_STYLE,
  STATUS_STYLE,
} from '../../types/notifications'
import { readableReason } from './notificationHelpers'
import { Segmented } from '../endpoint-detail/primitives'

export interface LogFilters {
  channelId?: string
  severity?: NotificationSeverity
  kind?: NotificationKind
  status?: DeliveryStatus
  from?: string
  to?: string
  search?: string
  suppressedReason?: string
}

interface Props {
  channels: ApiChannel[]
  filters: LogFilters
  onFilterChange: (patch: Partial<LogFilters>) => void
  onOpenRow: (row: ApiNotificationLogRow) => void
  refreshKey: number
  endpointNameById: Map<string, string>
}

interface Envelope {
  data: ApiNotificationLogRow[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null; prevCursor: string | null; total: number }
}

const STATUS_PILLS: Array<{ key: DeliveryStatus | 'all'; label: string }> = [
  { key: 'all',        label: 'All' },
  { key: 'sent',       label: 'Sent' },
  { key: 'failed',     label: 'Failed' },
  { key: 'suppressed', label: 'Suppressed' },
  { key: 'pending',    label: 'Pending' },
]

export function DeliveryLog({ channels, filters, onFilterChange, onOpenRow, refreshKey, endpointNameById }: Props) {
  const { request } = useApi()
  const [rows, setRows] = useState<ApiNotificationLogRow[]>([])
  const [pagination, setPagination] = useState<Envelope['pagination'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  const channelName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of channels) m.set(c._id, c.name)
    return m
  }, [channels])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    params.set('limit', '25')
    if (filters.channelId) params.set('channelId', filters.channelId)
    if (filters.severity) params.set('severity', filters.severity)
    if (filters.kind) params.set('kind', filters.kind)
    if (filters.status) params.set('status', filters.status)
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    if (filters.search) params.set('search', filters.search)

    request<Envelope>(`/notifications/log?${params.toString()}`)
      .then((res) => {
        setRows(res.data?.data ?? [])
        setPagination(res.data?.pagination ?? null)
      })
      .catch(() => {
        setRows([])
        setPagination(null)
      })
      .finally(() => setLoading(false))
  }, [request, filters, cursor, refreshKey])

  useEffect(() => { setCursor(null) }, [
    filters.channelId, filters.severity, filters.kind, filters.status,
    filters.from, filters.to, filters.search,
  ])

  // Client-side reason filter — the API doesn't expose a dedicated param for
  // this, so we narrow the fetched page after the fact. Suppression volume is
  // low in practice, so this is fine for the target user base.
  const visibleRows = useMemo(() => {
    if (!filters.suppressedReason) return rows
    return rows.filter((r) => r.suppressedReason === filters.suppressedReason)
  }, [rows, filters.suppressedReason])

  const counts = useMemo(() => ({
    all: rows.length,
    sent: rows.filter((r) => r.deliveryStatus === 'sent').length,
    failed: rows.filter((r) => r.deliveryStatus === 'failed').length,
    suppressed: rows.filter((r) => r.deliveryStatus === 'suppressed').length,
    pending: rows.filter((r) => r.deliveryStatus === 'pending').length,
  }), [rows])

  const retry = async (row: ApiNotificationLogRow) => {
    setRetrying(row._id)
    try {
      const res = await request<{ data: unknown }>(`/notifications/log/${row._id}/retry`, { method: 'POST' })
      if (res.status >= 400) {
        toast.error('Retry failed', { description: `HTTP ${res.status}` })
      } else {
        toast.success('Retry dispatched', { description: row.messageSummary })
      }
    } finally {
      setRetrying(null)
    }
  }

  const activeStatus = filters.status ?? 'all'

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface flex flex-col min-w-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-wd-border/50 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-wd-primary/15 text-wd-primary flex items-center justify-center shrink-0">
            <Icon icon="solar:clipboard-text-outline" width={16} />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground leading-tight">Delivery Log</div>
            <div className="text-[11px] text-wd-muted mt-0.5">
              Every dispatch — click any row to open its full payload.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-wd-muted font-mono">
          <span className="text-wd-success">{counts.sent} sent</span>
          <span className="text-wd-danger">{counts.failed} failed</span>
          <span className="text-wd-warning">{counts.suppressed} suppressed</span>
          {counts.pending > 0 && <span>{counts.pending} pending</span>}
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 py-3 border-b border-wd-border/50 flex items-center gap-2 flex-wrap">
        <SearchField
          aria-label="Search log"
          value={filters.search ?? ''}
          onChange={(v) => onFilterChange({ search: v || undefined })}
          className="!w-64"
        >
          <SearchField.Group className="!bg-wd-surface !border !border-wd-border/50 !rounded-lg !h-8">
            <SearchField.SearchIcon>
              <Icon icon="solar:magnifer-outline" width={16} className="text-wd-muted" />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search summary, endpoint…" className="!text-xs" />
            <SearchField.ClearButton>
              <Icon icon="solar:close-circle-outline" width={16} className="text-wd-muted" />
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>

        <Segmented<DeliveryStatus | 'all'>
          ariaLabel="Delivery status"
          options={STATUS_PILLS}
          value={activeStatus}
          onChange={(sel) =>
            onFilterChange({ status: sel === 'all' ? undefined : sel })
          }
        />

        <SelectDropdown
          label="channel"
          value={filters.channelId ?? '__all__'}
          options={[
            { id: '__all__', label: 'All Channels' },
            ...channels.map((c) => ({ id: c._id, label: c.name })),
          ]}
          onChange={(id) =>
            onFilterChange({ channelId: id !== '__all__' ? id : undefined })
          }
        />

        <SelectDropdown
          label="severity"
          value={filters.severity ?? '__any__'}
          options={[
            { id: '__any__', label: 'Any Severity' },
            { id: 'critical', label: 'Critical' },
            { id: 'warning', label: 'Warning' },
            { id: 'info', label: 'Info' },
            { id: 'success', label: 'Success' },
          ]}
          onChange={(id) =>
            onFilterChange({ severity: id !== '__any__' ? (id as NotificationSeverity) : undefined })
          }
        />

        <SelectDropdown
          label="kind"
          value={filters.kind ?? '__all__'}
          options={[
            { id: '__all__', label: 'All Kinds' },
            { id: 'incident_opened', label: 'Opened' },
            { id: 'incident_resolved', label: 'Resolved' },
            { id: 'incident_escalated', label: 'Escalation' },
            { id: 'channel_test', label: 'Test' },
            { id: 'custom', label: 'Custom' },
          ]}
          onChange={(id) =>
            onFilterChange({ kind: id !== '__all__' ? (id as NotificationKind) : undefined })
          }
        />

        {(filters.channelId || filters.severity || filters.kind || filters.status || filters.search || filters.suppressedReason) && (
          <Button
            size="sm"
            variant="ghost"
            className="!text-[11px] !h-8 !min-h-0 !px-2 ml-auto !text-wd-muted"
            onPress={() => onFilterChange({
              channelId: undefined,
              severity: undefined,
              kind: undefined,
              status: undefined,
              search: undefined,
              suppressedReason: undefined,
            })}
          >
            <Icon icon="solar:close-circle-linear" width={16} />
            Clear Filters
          </Button>
        )}
      </div>

      {filters.suppressedReason && (
        <div className="px-4 py-2 border-b border-wd-border/40 flex items-center gap-2 text-[11px] text-wd-muted">
          Filtering suppressions by:
          <span className="inline-flex items-center gap-1 bg-wd-warning/10 text-wd-warning border border-wd-warning/20 rounded-full px-2 py-0.5 capitalize">
            {readableReason(filters.suppressedReason)}
            <button
              type="button"
              onClick={() => onFilterChange({ suppressedReason: undefined })}
              className="hover:text-foreground"
              aria-label="Remove reason filter"
            >
              <Icon icon="solar:close-circle-linear" width={16} />
            </button>
          </span>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-wd-surface-hover/30 text-wd-muted">
            <tr>
              <th className="text-left font-medium px-3 py-2 w-[140px]">When</th>
              <th className="text-left font-medium px-3 py-2 w-[140px]">Channel</th>
              <th className="text-left font-medium px-3 py-2">Event</th>
              <th className="text-left font-medium px-3 py-2 w-[110px]">Status</th>
              <th className="text-right font-medium px-3 py-2 w-[90px]">Latency</th>
              <th className="text-right font-medium px-3 py-2 w-[70px]"></th>
            </tr>
          </thead>
          <tbody>
            {loading && visibleRows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-wd-muted"><Spinner size="sm" /></td></tr>
            ) : visibleRows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-wd-muted">No dispatches match the current filters.</td></tr>
            ) : visibleRows.map((r) => {
              const st = STATUS_STYLE[r.deliveryStatus]
              return (
                <tr
                  key={r._id}
                  onClick={() => onOpenRow(r)}
                  className={cn(
                    'border-t border-wd-border/40 hover:bg-wd-surface-hover/30 cursor-pointer',
                    r.deliveryStatus === 'failed' && 'bg-wd-danger/[0.03]',
                  )}
                >
                  <td className="px-3 py-2 text-wd-muted">
                    <div className="inline-flex items-center gap-1.5">
                      <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', SEVERITY_STYLE[r.severity])} aria-label={r.severity} />
                      <Tooltip delay={200} closeDelay={0}>
                        <TooltipTrigger>
                          <span className="font-mono">{timeAgo(r.sentAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent className="text-[11px] px-2 py-1">{new Date(r.sentAt).toLocaleString()}</TooltipContent>
                      </Tooltip>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-wd-muted truncate max-w-[140px]">
                      <Icon icon={CHANNEL_TYPE_ICON[r.channelType]} width={16} />
                      <span className="truncate">{channelName.get(r.channelId) ?? r.channelTarget}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 min-w-0">
                    <div className="text-foreground truncate max-w-[420px]">{r.messageSummary}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[10.5px] text-wd-muted">
                      <span className={cn('uppercase tracking-wider font-semibold', KIND_COLOR[r.kind])}>
                        {KIND_LABEL[r.kind]}
                      </span>
                      {r.endpointId && (
                        <>
                          <span className="text-wd-muted/50">·</span>
                          <Link
                            to={`/endpoints/${r.endpointId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-wd-primary hover:underline truncate max-w-[160px]"
                          >
                            {endpointNameById.get(r.endpointId) ?? r.endpointId.slice(0, 6)}
                          </Link>
                        </>
                      )}
                      {r.deliveryStatus === 'failed' && r.failureReason && (
                        <>
                          <span className="text-wd-muted/50">·</span>
                          <span className="text-wd-danger truncate max-w-[240px]">{r.failureReason}</span>
                        </>
                      )}
                      {r.deliveryStatus === 'suppressed' && r.suppressedReason && (
                        <>
                          <span className="text-wd-muted/50">·</span>
                          <span className="text-wd-warning capitalize">{readableReason(r.suppressedReason)}</span>
                        </>
                      )}
                      {(r.coalescedCount ?? 0) > 1 && (
                        <>
                          <span className="text-wd-muted/50">·</span>
                          <span>{r.coalescedCount} coalesced</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium rounded px-1.5 py-0.5', st.className)}>
                      <Icon
                        icon={
                          r.deliveryStatus === 'sent' ? 'solar:check-circle-bold'
                          : r.deliveryStatus === 'failed' ? 'solar:close-circle-bold'
                          : r.deliveryStatus === 'suppressed' ? 'solar:minus-circle-outline'
                          : 'solar:clock-circle-outline'
                        }
                        width={16}
                      />
                      {st.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-wd-muted">
                    {r.deliveryStatus === 'suppressed' || r.deliveryStatus === 'pending' || typeof r.latencyMs !== 'number'
                      ? '—'
                      : `${r.latencyMs}ms`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.deliveryStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="!text-[11px] !h-6 !min-h-0 !px-2 !text-wd-primary"
                        onPress={() => void retry(r)}
                        isDisabled={retrying === r._id}
                      >
                        {retrying === r._id ? <Spinner size="sm" /> : 'Retry'}
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pagination && (pagination.hasMore || cursor) && (
        <div className="px-4 py-2 border-t border-wd-border/50 flex items-center justify-between text-[11px] text-wd-muted">
          <span><span className="font-mono">{pagination.total.toLocaleString()}</span> total</span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="!text-[11px] !h-6 !min-h-0 !px-2"
              onPress={() => setCursor(null)}
              isDisabled={!cursor}
            >
              First
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="!text-[11px] !h-6 !min-h-0 !px-2"
              onPress={() => pagination.nextCursor && setCursor(pagination.nextCursor)}
              isDisabled={!pagination.hasMore || !pagination.nextCursor}
            >
              Next
              <Icon icon="solar:alt-arrow-right-linear" width={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SelectDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ id: string; label: string }>
  onChange: (id: string) => void
}) {
  const current = options.find((o) => o.id === value) ?? options[0]
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          aria-label={`Filter by ${label}`}
          className={cn(
            'inline-flex items-center justify-between gap-2 h-8 px-2.5 rounded-lg text-xs cursor-pointer min-w-[140px]',
            'bg-wd-surface border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
          )}
        >
          <span className="text-foreground truncate">{current?.label ?? '—'}</span>
          <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted shrink-0" />
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="!min-w-[180px]">
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([value])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0]
            if (sel != null) onChange(String(sel))
          }}
        >
          {options.map((opt) => (
            <Dropdown.Item key={opt.id} id={opt.id} className="!text-xs">
              {opt.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
