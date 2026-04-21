/**
 * Filter bar + history table for the Incidents page.
 *
 * The table itself is client-filtered over the already-fetched history page.
 * The status/range toggles and endpoint filter trigger a refetch in the parent
 * because those shift which incidents the API returns; severity/cause/search
 * are applied in-memory and never round-trip. This keeps typing in the search
 * box snappy while still letting the table scale to larger time windows when
 * the user opts in.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Dropdown,
  ScrollShadow,
  SearchField,
  Spinner,
  ToggleButton,
  ToggleButtonGroup,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import type { ApiIncident } from '../../types/api'
import type { ApiChannel, ChannelType } from '../../types/notifications'
import {
  CAUSE_META,
  causeKindChipClass,
  endpointDisplay,
  fmtAbsTime,
  fmtDuration,
  metaFor,
  severityDotClass,
  severityOf,
  type CauseKind,
  type EndpointLite,
  type EndpointSparkline,
  type Severity,
} from './incidentHelpers'
import { WideSpark } from '../health/HealthCharts'
import { timeAgo } from '../../utils/format'
import { LiveDuration } from './LiveTime'

export type StatusFilter = 'all' | 'active' | 'resolved'
export type TimeRange = '24h' | '7d' | '30d' | 'all'

export interface IncidentFilters {
  status: StatusFilter
  severity: Severity | 'all'
  endpointId: string
  cause: string
  range: TimeRange
  q: string
}

export const DEFAULT_FILTERS: IncidentFilters = {
  status: 'all',
  severity: 'all',
  endpointId: 'all',
  cause: 'all',
  range: '7d',
  q: '',
}

interface Props {
  incidents: ApiIncident[]
  activeIncidents: ApiIncident[]
  endpointById: Map<string, EndpointLite>
  channelById: Map<string, ApiChannel>
  sparklineByIncidentId: Map<string, EndpointSparkline>
  filters: IncidentFilters
  onFiltersChange: (patch: Partial<IncidentFilters>) => void
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
}

const SEVERITY_OPTIONS: Array<{ key: 'all' | Severity; label: string; dot?: string }> = [
  { key: 'all', label: 'All Severities' },
  { key: 'Critical', label: 'Critical', dot: 'var(--wd-danger)' },
  { key: 'Major', label: 'Major', dot: 'var(--wd-warning)' },
  { key: 'Minor', label: 'Minor', dot: 'var(--wd-primary)' },
]

const CAUSE_OPTIONS: Array<{ key: string; label: string; kind?: CauseKind }> = [
  { key: 'all', label: 'All Causes' },
  ...Object.entries(CAUSE_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    kind: meta.kind,
  })),
]

export function IncidentsTable({
  incidents,
  activeIncidents,
  endpointById,
  channelById,
  sparklineByIncidentId,
  filters,
  onFiltersChange,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
}: Props) {
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase()
    return incidents.filter((inc) => {
      if (filters.status !== 'all') {
        if (filters.status === 'active' && inc.status !== 'active') return false
        if (filters.status === 'resolved' && inc.status !== 'resolved') return false
      }
      if (filters.severity !== 'all' && severityOf(inc) !== filters.severity) return false
      if (filters.cause !== 'all' && inc.cause !== filters.cause) return false
      if (q) {
        const ep = endpointDisplay(endpointById.get(inc.endpointId))
        const hay = `${ep.name} ${ep.url} ${metaFor(inc.cause).label} ${inc.causeDetail ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [incidents, filters, endpointById])

  // Pin active incidents to the top only when no filter has been applied. Any
  // deviation from the defaults (status, severity, endpoint, cause, range,
  // search) drops the pin and falls back to the natural API order.
  const isDefaultFilters =
    filters.status === DEFAULT_FILTERS.status &&
    filters.severity === DEFAULT_FILTERS.severity &&
    filters.endpointId === DEFAULT_FILTERS.endpointId &&
    filters.cause === DEFAULT_FILTERS.cause &&
    filters.range === DEFAULT_FILTERS.range &&
    filters.q.trim() === DEFAULT_FILTERS.q

  const displayed = useMemo(() => {
    if (!isDefaultFilters) return filtered
    // Merge active (which may include incidents older than the history window)
    // with filtered, dedupe by id, and sort active-first then newest.
    const seen = new Set<string>()
    const merged: ApiIncident[] = []
    for (const inc of activeIncidents) {
      if (seen.has(inc._id)) continue
      seen.add(inc._id)
      merged.push(inc)
    }
    for (const inc of filtered) {
      if (seen.has(inc._id)) continue
      seen.add(inc._id)
      merged.push(inc)
    }
    return merged.sort((a, b) => {
      const aActive = a.status === 'active' ? 1 : 0
      const bActive = b.status === 'active' ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })
  }, [isDefaultFilters, activeIncidents, filtered])

  const endpointOpts = useMemo(() => {
    const eps = [...endpointById.values()].sort((a, b) => a.name.localeCompare(b.name))
    return [{ _id: 'all', name: 'All Endpoints' } as EndpointLite, ...eps]
  }, [endpointById])

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <FilterBar
        filters={filters}
        endpointOpts={endpointOpts}
        onChange={onFiltersChange}
        count={displayed.length}
      />
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden flex flex-col min-h-0">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5">
            <div className="text-[13px] font-semibold text-foreground">History</div>
            <span className="text-[11px] text-wd-muted font-mono">
              {displayed.length} incident{displayed.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="inline-flex items-center gap-1.5 text-[11px] text-wd-muted">
            <Icon icon="solar:sort-from-top-to-bottom-linear" width={16} />
            {isDefaultFilters ? 'Active first · then newest' : 'Newest first'}
          </div>
        </div>

        <TableHeader />

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon icon="solar:shield-check-linear" width={28} className="text-wd-success mb-3" />
            <div className="text-[13px] text-foreground font-medium">No incidents match these filters.</div>
            <div className="text-[11px] text-wd-muted mt-1">
              Try a wider time range or clear filters above.
            </div>
          </div>
        ) : (
          <ScrollShadow orientation="vertical" size={10} className="flex-1 min-h-0">
            {displayed.map((inc) => (
              <TableRow
                key={inc._id}
                incident={inc}
                endpoint={endpointById.get(inc.endpointId)}
                channelById={channelById}
                sparkline={sparklineByIncidentId.get(inc._id)}
              />
            ))}
            {hasMore && (
              <InfiniteSentinel loadingMore={loadingMore} onLoadMore={onLoadMore} />
            )}
          </ScrollShadow>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  endpointOpts,
  onChange,
  count,
}: {
  filters: IncidentFilters
  endpointOpts: EndpointLite[]
  onChange: (patch: Partial<IncidentFilters>) => void
  count: number
}) {
  const toggleClass = cn(
    '!text-xs !px-3',
    'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
  )

  const selectedEndpointLabel =
    filters.endpointId === 'all'
      ? 'All Endpoints'
      : endpointOpts.find((e) => e._id === filters.endpointId)?.name ?? 'Endpoint'
  const selectedSeverityLabel =
    SEVERITY_OPTIONS.find((o) => o.key === filters.severity)?.label ?? 'All Severities'
  const selectedCauseLabel =
    CAUSE_OPTIONS.find((o) => o.key === filters.cause)?.label ?? 'All Causes'

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <ToggleButtonGroup
        selectionMode="single"
        selectedKeys={new Set([filters.status])}
        onSelectionChange={(keys: Selection) => {
          const sel = [...keys][0] as StatusFilter | undefined
          if (sel) onChange({ status: sel })
        }}
        size="sm"
      >
        <ToggleButton key="all" id="all" className={toggleClass}>All</ToggleButton>
        <ToggleButton key="active" id="active" className={toggleClass}>Active</ToggleButton>
        <ToggleButton key="resolved" id="resolved" className={toggleClass}>Resolved</ToggleButton>
      </ToggleButtonGroup>

      <FilterDropdown label="Severity" value={selectedSeverityLabel}>
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([filters.severity])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0] as string | undefined
            if (sel) onChange({ severity: sel as Severity | 'all' })
          }}
        >
          {SEVERITY_OPTIONS.map((o) => (
            <Dropdown.Item key={o.key} id={o.key} className="!text-xs">
              {o.dot && (
                <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: o.dot }} />
              )}
              {o.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </FilterDropdown>

      <FilterDropdown label="Endpoint" value={selectedEndpointLabel}>
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([filters.endpointId])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0] as string | undefined
            if (sel) onChange({ endpointId: sel })
          }}
        >
          {endpointOpts.map((e) => (
            <Dropdown.Item key={e._id} id={e._id} className="!text-xs">
              {e.name}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </FilterDropdown>

      <FilterDropdown label="Cause" value={selectedCauseLabel}>
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([filters.cause])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0] as string | undefined
            if (sel) onChange({ cause: sel })
          }}
        >
          {CAUSE_OPTIONS.map((o) => (
            <Dropdown.Item key={o.key} id={o.key} className="!text-xs">
              {o.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </FilterDropdown>

      <ToggleButtonGroup
        selectionMode="single"
        selectedKeys={new Set([filters.range])}
        onSelectionChange={(keys: Selection) => {
          const sel = [...keys][0] as TimeRange | undefined
          if (sel) onChange({ range: sel })
        }}
        size="sm"
      >
        {(['24h', '7d', '30d', 'all'] as const).map((r) => (
          <ToggleButton key={r} id={r} className={toggleClass}>
            {r === 'all' ? 'All' : r}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] text-wd-muted font-mono">{count} shown</span>
        <SearchField
          aria-label="Search incidents"
          value={filters.q}
          onChange={(q) => onChange({ q })}
          className="!w-64"
        >
          <SearchField.Group className="!bg-wd-surface !border !border-wd-border/50 !rounded-lg !h-8">
            <SearchField.SearchIcon>
              <Icon icon="solar:magnifer-outline" width={16} className="text-wd-muted" />
            </SearchField.SearchIcon>
            <SearchField.Input
              placeholder="Endpoint, cause, detail…"
              className="!text-xs"
            />
            <SearchField.ClearButton>
              <Icon icon="solar:close-circle-outline" width={16} className="text-wd-muted" />
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>
      </div>
    </div>
  )
}

function FilterDropdown({
  label,
  value,
  children,
}: {
  label: string
  value: string
  children: React.ReactNode
}) {
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          role="button"
          tabIndex={0}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs cursor-pointer border border-wd-border/50 bg-wd-surface hover:bg-wd-surface-hover transition-colors"
        >
          <span className="text-wd-muted">{label}:</span>
          <span className="text-foreground truncate max-w-[140px]">{value}</span>
          <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted" />
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="!min-w-[200px]">
        {children}
      </Dropdown.Popover>
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const GRID_COLS =
  'grid-cols-[18px_96px_minmax(140px,1.2fr)_minmax(140px,1.4fr)_110px_90px_140px_120px_36px]'

function TableHeader() {
  return (
    <div
      className={cn(
        'grid items-center gap-x-3 px-4 py-2.5 border-b border-wd-border/50 bg-wd-surface-hover/30 shrink-0',
        GRID_COLS,
      )}
    >
      <span />
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Status
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Endpoint
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Cause
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Started
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Duration
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Alerts
      </span>
      <span className="text-[10px] font-semibold text-wd-muted uppercase tracking-[0.08em]">
        Response Time
      </span>
      <span />
    </div>
  )
}

const TableRow = memo(function TableRow({
  incident,
  endpoint,
  channelById,
  sparkline,
}: {
  incident: ApiIncident
  endpoint: EndpointLite | undefined
  channelById: Map<string, ApiChannel>
  sparkline: EndpointSparkline | undefined
}) {
  const navigate = useNavigate()
  const ep = endpointDisplay(endpoint)
  const sev = severityOf(incident)
  const meta = metaFor(incident.cause)
  const isActive = incident.status === 'active'
  const resolvedDuration = incident.durationSeconds ?? 0
  const sparkValues = sparkline?.values ?? []
  // Memoize labels so WideSpark's memo short-circuits when the row re-renders
  // for unrelated reasons (otherwise a fresh array busts it every time).
  const sparkLabels = useMemo(
    () => sparkline?.timestamps.map(formatCheckTime) ?? [],
    [sparkline],
  )
  const sparkColor = isActive ? 'var(--wd-danger)' : 'var(--wd-muted)'
  const channels =
    endpoint?.notificationChannelIds
      ?.map((id) => channelById.get(id))
      .filter((c): c is ApiChannel => !!c) ?? []
  const visibleChannels = channels.slice(0, 3)
  const overflowChannels = Math.max(0, channels.length - visibleChannels.length)

  const statusPill = isActive
    ? { cls: 'bg-wd-danger/15 text-wd-danger', label: 'Active' }
    : { cls: 'bg-wd-success/15 text-wd-success', label: 'Resolved' }

  const go = () => navigate(`/incidents/${incident._id}`)

  return (
    <div
      role="row"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === 'Enter') go()
      }}
      className={cn(
        'grid items-center gap-x-3 px-4 py-2.5 cursor-pointer transition-colors border-b border-wd-border/10',
        'hover:bg-wd-surface-hover/50',
        isActive && 'bg-wd-danger/[0.02]',
        GRID_COLS,
      )}
    >
      <div className="flex justify-center">
        <span className={cn('inline-block w-2 h-2 rounded-full', severityDotClass(sev))} />
      </div>

      <div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            statusPill.cls,
          )}
        >
          {isActive && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
            </span>
          )}
          {!isActive && <Icon icon="solar:check-circle-bold" width={16} />}
          {statusPill.label}
        </span>
      </div>

      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-foreground truncate">
          {ep.name}
          {ep.kind && (
            <span className="ml-1.5 inline-block px-1 py-[1px] rounded text-[9px] font-mono font-medium uppercase tracking-[0.08em] text-wd-muted/80 bg-wd-surface-hover/60 border border-wd-border/50 align-middle">
              {ep.kind}
            </span>
          )}
        </div>
        {ep.url && (
          <div className="text-[10.5px] text-wd-muted font-mono truncate">{ep.url}</div>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              'shrink-0 px-1.5 py-[1px] rounded text-[9.5px] font-semibold font-mono uppercase tracking-[0.08em]',
              causeKindChipClass(meta.kind),
            )}
          >
            {meta.short}
          </span>
          <span className="text-[12px] font-medium text-foreground truncate">{meta.label}</span>
        </div>
        {incident.causeDetail && (
          <div className="text-[10.5px] text-wd-muted truncate mt-0.5">{incident.causeDetail}</div>
        )}
      </div>

      <div className="min-w-0">
        <div className="text-[11.5px] text-foreground font-mono">{timeAgo(incident.startedAt)}</div>
        <div className="text-[10px] text-wd-muted/80 font-mono truncate">
          {fmtAbsTime(incident.startedAt)}
        </div>
      </div>

      <div
        className={cn(
          'text-[12px] font-mono',
          isActive ? 'text-wd-danger font-semibold' : 'text-wd-muted',
        )}
      >
        {isActive ? (
          <LiveDuration startedAt={incident.startedAt} />
        ) : (
          fmtDuration(resolvedDuration)
        )}
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-mono font-medium text-foreground tabular-nums">
          {incident.notificationsSent}
        </span>
        {channels.length > 0 ? (
          <span className="inline-flex items-center gap-1 min-w-0">
            {visibleChannels.map((c) => (
              <ChannelChip key={c._id} channel={c} />
            ))}
            {overflowChannels > 0 && (
              <span className="text-[10px] font-mono text-wd-muted">+{overflowChannels}</span>
            )}
          </span>
        ) : (
          <span className="text-[10.5px] text-wd-muted/60 italic">no channels</span>
        )}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="min-w-0"
      >
        {sparkValues.length > 1 ? (
          <WideSpark
            data={sparkValues}
            labels={sparkLabels}
            formatValue={(n) => `${Math.round(n).toLocaleString()} ms`}
            color={sparkColor}
            height={26}
          />
        ) : (
          <span className="text-[11px] text-wd-muted/60 font-mono">—</span>
        )}
      </div>

      <div onClick={(e) => e.stopPropagation()} className="flex justify-center">
        <RowMenu incident={incident} onView={go} />
      </div>
    </div>
  )
})

function formatCheckTime(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${date} · ${time}`
}

const CHANNEL_ICON: Record<ChannelType, string> = {
  discord: 'ic:baseline-discord',
  slack:   'logos:slack-icon',
  email:   'solar:letter-outline',
  webhook: 'solar:code-square-outline',
}

const CHANNEL_LABEL: Record<ChannelType, string> = {
  discord: 'Discord',
  slack:   'Slack',
  email:   'Email',
  webhook: 'Webhook',
}

function ChannelChip({ channel }: { channel: ApiChannel }) {
  return (
    <span
      title={`${CHANNEL_LABEL[channel.type]} · ${channel.name}`}
      className="inline-flex items-center justify-center h-[18px] w-[18px] rounded border border-wd-border/50 bg-wd-surface-hover/60 text-wd-muted shrink-0"
    >
      <Icon icon={CHANNEL_ICON[channel.type]} width={16} />
    </span>
  )
}

function RowMenu({ incident, onView }: { incident: ApiIncident; onView: () => void }) {
  const copyId = () => {
    void navigator.clipboard?.writeText(incident._id).catch(() => {})
  }
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          role="button"
          aria-label="Row actions"
          tabIndex={0}
          className="h-6 w-6 rounded-md flex items-center justify-center text-wd-muted hover:text-foreground hover:bg-wd-surface-hover/60 transition-colors cursor-pointer"
        >
          <Icon icon="solar:menu-dots-bold" width={16} />
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" className="!min-w-[180px]">
        <Dropdown.Menu
          onAction={(key) => {
            if (key === 'view') onView()
            else if (key === 'copy') copyId()
          }}
        >
          <Dropdown.Item id="view" className="!text-xs">
            <Icon icon="solar:eye-linear" width={16} className="mr-1.5" />
            View Details
          </Dropdown.Item>
          <Dropdown.Item id="copy" className="!text-xs">
            <Icon icon="solar:copy-linear" width={16} className="mr-1.5" />
            Copy Incident ID
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// Infinite-scroll sentinel
// ---------------------------------------------------------------------------

function InfiniteSentinel({
  loadingMore,
  onLoadMore,
}: {
  loadingMore: boolean
  onLoadMore: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore) onLoadMore()
      },
      { threshold: 0.1 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadingMore, onLoadMore])
  return (
    <div ref={ref} className="flex justify-center py-3">
      <Spinner size="sm" />
    </div>
  )
}
