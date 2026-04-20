import { Fragment, memo, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  Button,
  Spinner,
  ToggleButtonGroup,
  ToggleButton,
  Dropdown,
  Separator,
  cn,
} from '@heroui/react'
import { Icon } from '@iconify/react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  Bar,
  BarChart,
  ReferenceLine,
} from 'recharts'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import type { ApiEndpoint, ApiCheck, ApiIncident, HourlySummary, DailySummary, UptimeStats } from '../types/api'
import { statusColors, formatDuration, formatRuntime, timeAgo, formatHour, formatDate, getIncidentRanges, latencyColor, uptimeColor } from '../utils/format'
import type { IncidentRange } from '../utils/format'
import MetricsTab from '../components/tabs/MetricsTab'
import ChecksTab from '../components/tabs/ChecksTab'
import IncidentsTab from '../components/tabs/IncidentsTab'
import SettingsTab from '../components/tabs/SettingsTab'
import NotificationsTab from '../components/tabs/NotificationsTab'
import ForegroundReferenceArea from '../components/ForegroundReferenceArea'
import UptimeBar, { buildHistory } from '../components/UptimeBar'

type TimeRange = '1h' | '24h' | '7d' | '30d'

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'metrics' | 'checks' | 'incidents' | 'notifications' | 'settings'

const tabs: { id: TabId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'solar:chart-square-linear' },
  { id: 'metrics', label: 'Metrics', icon: 'solar:graph-up-linear' },
  { id: 'checks', label: 'Checks', icon: 'solar:checklist-minimalistic-linear' },
  { id: 'incidents', label: 'Incidents', icon: 'solar:danger-triangle-linear' },
  { id: 'notifications', label: 'Notifications', icon: 'solar:bell-linear' },
  { id: 'settings', label: 'Settings', icon: 'solar:settings-linear' },
]

// ---------------------------------------------------------------------------
// Chart tooltip
// ---------------------------------------------------------------------------

function ChartTooltipContent({
  active,
  payload,
  label,
  unit,
  incidentRanges,
}: {
  active?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[]
  label?: string
  unit?: string
  incidentRanges?: IncidentRange[]
}) {
  if (!active || !payload?.length) return null

  // Check if this data point falls within an incident range
  const matchedRange = incidentRanges?.find(
    (r) => label != null && label >= r.x1 && label <= r.x2,
  )

  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg max-w-[280px]">
      <div className="text-[11px] font-mono text-wd-muted mb-1">{label}</div>
      {payload.map((entry: { dataKey: string; value: number; color: string }) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-wd-muted [word-break:normal] [overflow-wrap:normal]">{entry.dataKey}:</span>
          <span className="font-mono font-semibold text-foreground">
            {entry.value}
            {unit}
          </span>
        </div>
      ))}
      {matchedRange && (
        <div className={cn(
          'flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-wd-border/50 text-[11px] font-medium',
          matchedRange.type === 'down' ? 'text-wd-danger' : 'text-wd-warning',
        )}>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            matchedRange.type === 'down' ? 'bg-wd-danger' : 'bg-wd-warning',
          )} />
          {matchedRange.type === 'down' ? 'Outage detected' : 'Degraded performance'}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview chart types
// ---------------------------------------------------------------------------

type ChartMode = 'response' | 'uptime' | 'incidents'

const chartModes: { id: ChartMode; label: string; icon: string }[] = [
  { id: 'response', label: 'Response Time', icon: 'solar:graph-up-linear' },
  { id: 'uptime', label: 'Uptime', icon: 'solar:shield-check-linear' },
  { id: 'incidents', label: 'Incidents', icon: 'solar:danger-triangle-linear' },
]

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { request } = useApi()
  const { subscribe } = useSSE()

  const validTabs: TabId[] = ['overview', 'metrics', 'checks', 'incidents', 'notifications', 'settings']
  const initialTab = (searchParams.get('tab') as TabId | null)
  const initialTabSafe: TabId = initialTab && validTabs.includes(initialTab) ? initialTab : 'overview'

  // ── State ──────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true)
  const [aggLoading, setAggLoading] = useState(true)
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null)
  const [latestCheck, setLatestCheck] = useState<ApiCheck | null>(null)
  const [uptimeStats, setUptimeStats] = useState<UptimeStats | null>(null)
  const [daily30d, setDaily30d] = useState<DailySummary[]>([])
  const [incidents30d, setIncidents30d] = useState<ApiIncident[]>([])
  const [activeTab, setActiveTabState] = useState<TabId>(initialTabSafe)
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabState(tab)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (tab === 'overview') next.delete('tab')
      else next.set('tab', tab)
      return next
    }, { replace: true })
  }, [setSearchParams])

  // Overview tab state
  const [chartMode, setChartMode] = useState<ChartMode>('response')
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  const [hourlySummaries, setHourlySummaries] = useState<HourlySummary[]>([])
  const [recentChecks, setRecentChecks] = useState<ApiCheck[]>([])
  const [allChecks, setAllChecks] = useState<ApiCheck[]>([])
  const [incidents, setIncidents] = useState<ApiIncident[]>([])
  const [loadingOverview, setLoadingOverview] = useState(true)

  // Cross-tab navigation: open a specific item expanded
  const [focusedIncidentId, setFocusedIncidentId] = useState<string | null>(null)
  const [focusedCheckId, setFocusedCheckId] = useState<string | null>(null)

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // ── Fetch endpoint data ────────────────────────────────────────────────
  // Split into two phases so the page renders as soon as the endpoint + uptime
  // stats arrive; the 30d history (dailies + incidents) loads in the background
  // and the uptime bar animates until it's ready.
  const fetchEndpoint = useCallback(async () => {
    if (!id) return

    // Phase 1 — fast: endpoint + uptime stats (unblocks render)
    const [epRes, uptimeRes] = await Promise.all([
      request<{ data: ApiEndpoint; latestCheck: ApiCheck | null }>(`/endpoints/${id}`),
      request<{ data: UptimeStats }>(`/endpoints/${id}/uptime`),
    ])
    if (epRes.status < 400) {
      setEndpoint(epRes.data.data)
      setLatestCheck(epRes.data.latestCheck)
    }
    if (uptimeRes.status < 400) {
      setUptimeStats(uptimeRes.data.data)
    }
    setLoading(false)

    // Phase 2 — slower: 30d dailies + incidents (fills uptime bar with real data)
    setAggLoading(true)
    const [dailyRes, incRes] = await Promise.all([
      request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=30`),
      request<{ data: ApiIncident[] }>(`/incidents?endpointId=${id}&limit=500`),
    ])
    if (dailyRes.status < 400) {
      setDaily30d(dailyRes.data.data ?? [])
    }
    if (incRes.status < 400) {
      const cutoff = Date.now() - 30 * 86400_000
      setIncidents30d(
        (incRes.data.data ?? []).filter(
          (i) => new Date(i.startedAt).getTime() >= cutoff,
        ),
      )
    }
    setAggLoading(false)
  }, [id, request])

  // ── Fetch overview tab data ────────────────────────────────────────────
  const fetchOverviewData = useCallback(async () => {
    if (!id) return
    setLoadingOverview(true)

    // Always fetch recent checks + incidents (sidebar cards)
    const [checksRes, incRes] = await Promise.all([
      request<{ data: ApiCheck[]; pagination: unknown }>(`/endpoints/${id}/checks?limit=10`),
      request<{ data: ApiIncident[]; pagination: unknown }>(`/incidents?endpointId=${id}&limit=5`),
    ])
    if (checksRes.status < 400) setRecentChecks(checksRes.data.data ?? [])
    if (incRes.status < 400) setIncidents(incRes.data.data ?? [])

    // Fetch chart data based on time range
    if (timeRange === '1h') {
      // Always use raw checks for 1h
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const rawRes = await request<{ data: ApiCheck[]; pagination: unknown }>(
        `/endpoints/${id}/checks?limit=100&from=${from}`,
      )
      setAllChecks(rawRes.status < 400 ? (rawRes.data.data ?? []) : [])
      setHourlySummaries([])
    } else if (timeRange === '30d') {
      // Use daily summaries for 30d
      const dailyRes = await request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=30`)
      const dailies = dailyRes.status < 400 ? (dailyRes.data.data ?? []) : []
      // Convert daily summaries to hourly shape for the chart
      setHourlySummaries(dailies.map((d) => ({
        hour: d.date,
        avgResponseTime: d.avgResponseTime,
        p95ResponseTime: d.p95ResponseTime,
        p99ResponseTime: d.p99ResponseTime,
        minResponseTime: d.minResponseTime,
        maxResponseTime: d.maxResponseTime,
        uptimePercent: d.uptimePercent,
        totalChecks: d.totalChecks,
        successCount: 0,
        failCount: d.incidentCount,
        degradedCount: 0,
      })))
      setAllChecks([])
    } else if (timeRange === '7d') {
      // 7d — use daily summaries, fall back to hourly if none exist
      const dailyRes = await request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=7`)
      const dailies = dailyRes.status < 400 ? (dailyRes.data.data ?? []) : []
      if (dailies.length > 0) {
        setHourlySummaries(dailies.map((d) => ({
          hour: d.date,
          avgResponseTime: d.avgResponseTime,
          p95ResponseTime: d.p95ResponseTime,
          p99ResponseTime: d.p99ResponseTime,
          minResponseTime: d.minResponseTime,
          maxResponseTime: d.maxResponseTime,
          uptimePercent: d.uptimePercent,
          totalChecks: d.totalChecks,
          successCount: 0,
          failCount: d.incidentCount,
          degradedCount: 0,
        })))
      } else {
        const hourlyRes = await request<{ data: HourlySummary[] }>(
          `/endpoints/${id}/hourly?limit=168`,
        )
        setHourlySummaries(hourlyRes.status < 400 ? (hourlyRes.data.data ?? []) : [])
      }
      setAllChecks([])
    } else {
      // 24h — hourly summaries, falls back to raw checks if sparse
      const hourlyRes = await request<{ data: HourlySummary[] }>(
        `/endpoints/${id}/hourly?limit=24`,
      )
      const hourlies = hourlyRes.status < 400 ? (hourlyRes.data.data ?? []) : []
      setHourlySummaries(hourlies)

      if (hourlies.length < 1) {
        const rawRes = await request<{ data: ApiCheck[]; pagination: unknown }>(
          `/endpoints/${id}/checks?limit=60`,
        )
        setAllChecks(rawRes.status < 400 ? (rawRes.data.data ?? []) : [])
      } else {
        setAllChecks([])
      }
    }

    setLoadingOverview(false)
  }, [id, request, timeRange])

  useEffect(() => {
    fetchEndpoint()
    fetchOverviewData()
  }, [fetchEndpoint, fetchOverviewData])

  // ── SSE live updates ───────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('check:complete', (data: unknown) => {
      const payload = data as { endpointId: string; status: string; responseTime: number; statusCode?: number; timestamp: string }
      if (payload.endpointId !== id) return

      // Update endpoint last* fields
      setEndpoint((ep) =>
        ep
          ? {
              ...ep,
              lastStatus: payload.status as ApiEndpoint['lastStatus'],
              lastResponseTime: payload.responseTime,
              lastStatusCode: payload.statusCode ?? null,
              lastCheckAt: payload.timestamp,
            }
          : ep,
      )

      // Prepend to recent checks + allChecks (for raw chart fallback)
      const newCheck: ApiCheck = {
        _id: `live-${Date.now()}`,
        endpointId: payload.endpointId,
        timestamp: payload.timestamp,
        responseTime: payload.responseTime,
        statusCode: payload.statusCode,
        status: payload.status as ApiCheck['status'],
        duringMaintenance: false,
      }
      setRecentChecks((prev) => [newCheck, ...prev].slice(0, 10))
      setAllChecks((prev) => (prev.length > 0 ? [newCheck, ...prev].slice(0, 60) : prev))
    })
    return unsub
  }, [id, subscribe])

  // ── Chart data ─────────────────────────────────────────────────────────
  // Use raw checks for 1h, or 24h fallback when < 4 hourly buckets
  const useRawChart = (timeRange === '1h' || (timeRange === '24h' && hourlySummaries.length === 0)) && allChecks.length > 0

  const chartData = useMemo(() => {
    if (useRawChart) {
      if (allChecks.length === 0) return []
      const sorted = [...allChecks].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )
      return sorted.map((c) => ({
        label: new Date(c.timestamp).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        avg: c.responseTime,
        p95: c.responseTime,
        p99: c.responseTime,
        uptime: c.status === 'healthy' ? 100 : c.status === 'degraded' ? 50 : 0,
        fails: c.status === 'down' ? 1 : 0,
        degraded: c.status === 'degraded' ? 1 : 0,
      }))
    }

    if (hourlySummaries.length === 0) return []
    const sorted = [...hourlySummaries].sort(
      (a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime(),
    )
    return sorted.map((h) => ({
      label: timeRange === '30d' || timeRange === '7d'
        ? new Date(h.hour).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : formatHour(h.hour),
      avg: h.avgResponseTime,
      p95: h.p95ResponseTime,
      p99: h.p99ResponseTime,
      uptime: h.uptimePercent,
      fails: h.failCount,
      degraded: h.degradedCount,
    }))
  }, [hourlySummaries, allChecks, useRawChart, timeRange])

  // ── Performance stats from hourly summaries or raw checks ───────────────
  const perfStats = useMemo(() => {
    if (useRawChart && allChecks.length > 0) {
      // Exclude incident checks (status !== 'healthy') from min/max
      const healthy = allChecks.filter((c) => c.status === 'healthy' && c.responseTime > 0)
      const times = healthy.map((c) => c.responseTime).sort((a, b) => a - b)
      const allTimes = allChecks.map((c) => c.responseTime).sort((a, b) => a - b)
      const n = allTimes.length
      const sum = allTimes.reduce((s, t) => s + t, 0)
      const p95i = Math.min(Math.ceil(n * 0.95) - 1, n - 1)
      const p99i = Math.min(Math.ceil(n * 0.99) - 1, n - 1)
      return {
        min: times[0] ?? 0,
        max: times[times.length - 1] ?? 0,
        avg: Math.round(sum / n),
        p95: allTimes[p95i] ?? 0,
        p99: allTimes[p99i] ?? 0,
        totalChecks: n,
      }
    }

    if (hourlySummaries.length === 0) return null
    let min = Infinity
    let max = -Infinity
    let sumAvg = 0
    let sumP95 = 0
    let sumP99 = 0
    let totalChecks = 0
    for (const h of hourlySummaries) {
      // Skip hours with failures from min/max (operational metrics only)
      if (h.failCount === 0 && h.degradedCount === 0) {
        if (h.minResponseTime > 0 && h.minResponseTime < min) min = h.minResponseTime
        if (h.maxResponseTime > max) max = h.maxResponseTime
      }
      sumAvg += h.avgResponseTime * h.totalChecks
      sumP95 += h.p95ResponseTime
      sumP99 += h.p99ResponseTime
      totalChecks += h.totalChecks
    }
    const n = hourlySummaries.length
    return {
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
      avg: totalChecks === 0 ? 0 : Math.round(sumAvg / totalChecks),
      p95: Math.round(sumP95 / n),
      p99: Math.round(sumP99 / n),
      totalChecks,
    }
  }, [hourlySummaries, allChecks, useRawChart])

  // ── Actions ────────────────────────────────────────────────────────────
  const handleToggle = useCallback(async () => {
    if (!id) return
    const res = await request<{ data: ApiEndpoint }>(`/endpoints/${id}/toggle`, { method: 'PATCH' })
    if (res.status < 400) setEndpoint(res.data.data)
  }, [id, request])

  const handleRecheck = useCallback(async () => {
    if (!id) return
    await request(`/endpoints/${id}/recheck`, { method: 'POST' })
  }, [id, request])

  const handleDelete = useCallback(async () => {
    if (!id) return
    setDeleting(true)
    const res = await request(`/endpoints/${id}`, { method: 'DELETE' })
    setDeleting(false)
    if (res.status < 400 || res.status === 204) {
      navigate('/endpoints')
    }
  }, [id, request, navigate])

  // ── Derived values ─────────────────────────────────────────────────────
  const currentStatus = endpoint?.lastStatus ?? 'unknown'
  const sc = statusColors[currentStatus]

  // 30d aggregate stats derived from dailies + incidents
  const stats30d = useMemo(() => {
    let totalChecks = 0
    let weightedUptime = 0
    let weightedResp = 0
    for (const d of daily30d) {
      totalChecks += d.totalChecks
      weightedUptime += d.uptimePercent * d.totalChecks
      weightedResp += d.avgResponseTime * d.totalChecks
    }
    const uptimePct = totalChecks > 0 ? weightedUptime / totalChecks : null
    const avgResponse = totalChecks > 0 ? Math.round(weightedResp / totalChecks) : null

    // Downtime from incidents (more accurate than check-based estimates)
    const now = Date.now()
    let downtimeSec = 0
    for (const inc of incidents30d) {
      if (inc.status === 'active') {
        downtimeSec += Math.max(0, (now - new Date(inc.startedAt).getTime()) / 1000)
      } else {
        downtimeSec += inc.durationSeconds ?? 0
      }
    }

    // MTTR — mean time to resolve over resolved incidents
    const resolved = incidents30d.filter((i) => i.status === 'resolved' && (i.durationSeconds ?? 0) > 0)
    const mttrSec = resolved.length > 0
      ? Math.round(resolved.reduce((s, i) => s + (i.durationSeconds ?? 0), 0) / resolved.length)
      : null

    // Streak — time since last incident ended. 0 if an incident is active.
    let streakSec: number | null = null
    const active = incidents30d.find((i) => i.status === 'active')
    if (active) {
      streakSec = 0
    } else {
      const endTimes = incidents30d
        .filter((i) => i.status === 'resolved' && i.resolvedAt)
        .map((i) => new Date(i.resolvedAt!).getTime())
      if (endTimes.length > 0) {
        streakSec = Math.floor((now - Math.max(...endTimes)) / 1000)
      } else if (endpoint) {
        // No incidents ever → streak equals endpoint age
        streakSec = Math.floor((now - new Date(endpoint.createdAt).getTime()) / 1000)
      }
    }

    return {
      uptimePct,
      downtimeSec: Math.round(downtimeSec),
      avgResponse,
      incidentCount: incidents30d.length,
      mttrSec,
      streakSec,
    }
  }, [daily30d, incidents30d, endpoint])

  const history30d = useMemo(() => buildHistory(daily30d, 30), [daily30d])

  // --- Early returns (after all hooks) ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!endpoint) {
    return (
      <div className="p-6 space-y-4 text-center">
        <Icon icon="solar:ghost-linear" width={48} className="mx-auto text-wd-muted" />
        <h2 className="text-lg font-semibold text-foreground">Endpoint not found</h2>
        <Button variant="bordered" onPress={() => navigate('/endpoints')}>
          Back to Endpoints
        </Button>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-wd-muted mb-3">
          <Link to="/endpoints" className="hover:text-foreground transition-colors">
            Endpoints
          </Link>
          <Icon icon="solar:alt-arrow-right-linear" width={16} />
          <span className="text-foreground">{endpoint.name}</span>
        </div>

        {/* Name + status + actions row */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Pulsating status dot */}
            <div className="relative flex items-center justify-center">
              <span className={cn('h-3 w-3 rounded-full', sc.dot)} />
              {currentStatus !== 'unknown' && (
                <span
                  className={cn(
                    'absolute h-3 w-3 rounded-full animate-ping opacity-40',
                    sc.dot,
                  )}
                />
              )}
            </div>

            <div>
              <h1 className="text-xl font-semibold text-foreground">{endpoint.name}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs font-mono text-wd-muted">
                  {endpoint.type === 'http' ? endpoint.url : `${endpoint.host}:${endpoint.port}`}
                </span>
                <span className="text-xs text-wd-muted/40">|</span>
                <span className={cn('text-xs font-medium', sc.text)}>
                  {currentStatus === 'unknown' ? 'No data' : currentStatus}
                </span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="bordered"
              className="!text-xs"
              onPress={handleRecheck}
              isDisabled={endpoint.status !== 'active'}
            >
              <Icon icon="solar:refresh-linear" width={16} />
              Recheck
            </Button>
            <Button
              size="sm"
              variant="bordered"
              className="!text-xs"
              onPress={handleToggle}
            >
              <Icon
                icon={
                  endpoint.status === 'active'
                    ? 'solar:pause-linear'
                    : 'solar:play-linear'
                }
                width={16}
              />
              {endpoint.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
            <Dropdown>
              <Dropdown.Trigger>
                <div className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-wd-border/50 bg-wd-surface hover:bg-wd-surface-hover transition-colors cursor-pointer">
                  <Icon icon="solar:menu-dots-bold" width={16} className="text-wd-muted" />
                </div>
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end" className="!min-w-[140px]">
                <Dropdown.Menu
                  onAction={(key) => {
                    if (key === 'edit') setActiveTab('settings')
                    if (key === 'delete') setShowDeleteModal(true)
                  }}
                >
                  <Dropdown.Item id="edit" className="!text-xs">
                    <Icon icon="solar:pen-linear" width={16} className="mr-1.5" />
                    Edit
                  </Dropdown.Item>
                  <Dropdown.Item id="delete" className="!text-xs !text-wd-danger">
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={16} className="mr-1.5" />
                    Delete
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
        </div>

        {/* KPI strip + 30d uptime visualization */}
        <div className="flex items-start gap-6 mt-4">
          {/* Stats — 30d rolling window. Flex row with vertical separators
              between cells; wraps to new rows when viewport is narrow. */}
          <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-2.5">
            {([
              {
                key: 'runtime',
                icon: 'solar:clock-circle-linear',
                accent: 'primary',
                label: 'Runtime',
                value: <LiveRuntime createdAt={endpoint.createdAt} />,
              },
              {
                key: 'uptime',
                icon: 'solar:shield-check-linear',
                accent: 'success',
                label: 'Uptime',
                value: stats30d.uptimePct != null ? `${stats30d.uptimePct.toFixed(2)}%` : '—',
                valueClass: stats30d.uptimePct != null ? uptimeColor(stats30d.uptimePct) : undefined,
              },
              {
                key: 'downtime',
                icon: 'solar:close-circle-linear',
                accent: 'danger',
                label: 'Downtime',
                value: stats30d.downtimeSec > 0 ? formatRuntime(stats30d.downtimeSec) : '0m',
                valueClass: stats30d.downtimeSec > 0 ? 'text-wd-danger' : undefined,
              },
              {
                key: 'avg',
                icon: 'solar:graph-up-linear',
                accent: 'warning',
                label: 'Avg Response',
                value: stats30d.avgResponse != null ? `${stats30d.avgResponse}ms` : '—',
                valueClass: stats30d.avgResponse != null ? latencyColor(stats30d.avgResponse) : undefined,
              },
              {
                key: 'incidents',
                icon: 'solar:danger-triangle-linear',
                accent: 'danger',
                label: 'Incidents',
                value: String(stats30d.incidentCount),
                valueClass: stats30d.incidentCount > 0 ? 'text-wd-danger' : undefined,
              },
              {
                key: 'mttr',
                icon: 'solar:restart-circle-linear',
                accent: 'muted',
                label: 'MTTR',
                value: stats30d.mttrSec != null ? formatDuration(stats30d.mttrSec) : '—',
              },
              {
                key: 'streak',
                icon: 'solar:medal-ribbon-star-linear',
                accent: 'success',
                label: 'Streak',
                value:
                  stats30d.streakSec == null
                    ? '—'
                    : stats30d.streakSec === 0
                      ? 'Active Incident'
                      : formatRuntime(stats30d.streakSec),
                valueClass: stats30d.streakSec === 0 ? 'text-wd-danger' : undefined,
              },
            ] as const).map((s, i) => (
              <Fragment key={s.key}>
                {i > 0 && (
                  <Separator orientation="vertical" className="!h-7 !bg-wd-border/50" />
                )}
                <StatCell
                  icon={s.icon}
                  accent={s.accent}
                  label={s.label}
                  value={s.value}
                  valueClass={s.valueClass}
                />
              </Fragment>
            ))}
          </div>

          {/* Daily uptime — 30d visualization */}
          <div className="w-[360px] shrink-0">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-foreground">Daily Uptime</span>
              <span className="text-[10px] font-mono text-wd-muted">1 cell = 24h · 30d</span>
            </div>
            <UptimeBar history={history30d} loading={aggLoading} />
          </div>
        </div>
      </div>

      <Separator className="!bg-wd-border/50" />

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-wd-border/50">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors cursor-pointer',
              'border-b-2 -mb-px',
              activeTab === tab.id
                ? 'border-wd-primary text-wd-primary'
                : 'border-transparent text-wd-muted hover:text-foreground',
            )}
          >
            <Icon icon={tab.icon} width={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <OverviewTab
          endpoint={endpoint}
          chartMode={chartMode}
          onChartModeChange={setChartMode}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          chartData={chartData}
          recentChecks={recentChecks}
          incidents={incidents}
          uptimeStats={uptimeStats}
          perfStats={perfStats}
          loading={loadingOverview}
          onTabChange={setActiveTab}
          onIncidentClick={(incId) => { setFocusedIncidentId(incId); setActiveTab('incidents') }}
          onCheckClick={(checkId) => { setFocusedCheckId(checkId); setActiveTab('checks') }}
        />
      )}

      {activeTab === 'metrics' && (
        <MetricsTab endpointId={id!} endpointType={endpoint.type} />
      )}

      {activeTab === 'checks' && (
        <ChecksTab endpointId={id!} endpointType={endpoint.type} initialExpandedId={focusedCheckId} />
      )}

      {activeTab === 'incidents' && (
        <IncidentsTab endpointId={id!} initialExpandedId={focusedIncidentId} />
      )}

      {activeTab === 'notifications' && (
        <NotificationsTab
          endpoint={endpoint}
          onJumpToSettings={() => setActiveTab('settings')}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsTab
          endpoint={endpoint}
          onUpdate={(ep) => setEndpoint(ep)}
          onDelete={() => navigate('/endpoints')}
          onToggle={handleToggle}
        />
      )}

      {/* ── Delete confirmation modal ───────────────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowDeleteModal(false)}
          />
          {/* Modal */}
          <div className="relative bg-wd-surface border border-wd-border rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-full bg-wd-danger/10 p-2">
                <Icon icon="solar:trash-bin-minimalistic-linear" width={24} className="text-wd-danger" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Delete Endpoint</h3>
                <p className="text-xs text-wd-muted">This action cannot be undone</p>
              </div>
            </div>

            <p className="text-sm text-wd-muted mb-1">
              Are you sure you want to archive <span className="font-medium text-foreground">{endpoint.name}</span>?
            </p>
            <p className="text-xs text-wd-muted/60 mb-6">
              The endpoint will be moved to the archived list. Check history and incident data will be preserved.
            </p>

            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="bordered"
                className="!text-xs"
                onPress={() => setShowDeleteModal(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="!text-xs !bg-wd-danger !text-white"
                onPress={handleDelete}
                isDisabled={deleting}
              >
                {deleting ? (
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

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  endpoint,
  chartMode,
  onChartModeChange,
  timeRange,
  onTimeRangeChange,
  chartData,
  recentChecks,
  incidents,
  uptimeStats,
  perfStats,
  loading,
  onTabChange,
  onIncidentClick,
  onCheckClick,
}: {
  endpoint: ApiEndpoint
  chartMode: ChartMode
  onChartModeChange: (mode: ChartMode) => void
  timeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  chartData: Array<Record<string, string | number>>
  recentChecks: ApiCheck[]
  incidents: ApiIncident[]
  uptimeStats: UptimeStats | null
  perfStats: { min: number; max: number; avg: number; p95: number; p99: number; totalChecks: number } | null
  loading: boolean
  onTabChange: (tab: TabId) => void
  onIncidentClick: (incidentId: string) => void
  onCheckClick: (checkId: string) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner size="md" />
      </div>
    )
  }

  // Incident ranges for chart reference areas
  // Expanded ranges for area/line charts (single-point incidents span a neighbour bucket)
  const incidentRanges = useMemo(() => getIncidentRanges(chartData, true), [chartData])
  // Raw ranges for bar charts (single bucket is already visible)
  const incidentRangesRaw = useMemo(() => getIncidentRanges(chartData, false), [chartData])

  // Min/max response time for static reference lines (exclude incident data)
  const responseMinMax = useMemo(() => {
    if (chartData.length === 0 || chartMode !== 'response') return null
    let min = Infinity
    let max = -Infinity
    for (const d of chartData) {
      if (Number(d.fails ?? 0) > 0 || Number(d.degraded ?? 0) > 0) continue
      const v = Number(d.avg)
      if (v <= 0) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (min === Infinity) return null
    return { min, max }
  }, [chartData, chartMode])

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* ── Left column (2/3) — chart + incidents/checks ───────────────── */}
      <div className="col-span-2 space-y-6">
        {/* Chart card */}
      <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
        {/* Chart mode toggle */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1">
            {chartModes.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChartModeChange(m.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                  chartMode === m.id
                    ? 'bg-wd-primary/10 text-wd-primary'
                    : 'text-wd-muted hover:text-foreground hover:bg-wd-surface-hover',
                )}
              >
                <Icon icon={m.icon} width={16} />
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-lg bg-wd-surface-hover/50 p-0.5">
              {(['1h', '24h', '7d', '30d'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onTimeRangeChange(r)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-[11px] font-mono font-medium transition-colors cursor-pointer',
                    timeRange === r
                      ? 'bg-wd-surface text-foreground shadow-sm'
                      : 'text-wd-muted hover:text-foreground',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Export menu */}
          <Dropdown>
            <Dropdown.Trigger>
              <button
                type="button"
                className="p-1.5 rounded-lg text-wd-muted hover:text-foreground hover:bg-wd-surface-hover/50 transition-colors cursor-pointer"
                aria-label="Chart options"
              >
                <Icon icon="solar:menu-dots-bold" width={20} />
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

        {/* Chart */}
        {chartData.length === 0 ? (
          <div className="h-72 flex flex-col items-center justify-center text-wd-muted gap-2">
            <Icon icon="solar:chart-square-linear" width={28} className="opacity-40" />
            <p className="text-sm">
              Waiting for data — charts populate after checks run
            </p>
          </div>
        ) : (
          <div className="h-72 select-none">
            <ResponsiveContainer className="[&_.recharts-surface]:outline-hidden [&_*:focus]:!outline-none" width="100%" height="100%">
              {chartMode === 'incidents' ? (
                <BarChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
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
                    allowDecimals={false}
                    width={40}
                    domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 1]}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent incidentRanges={incidentRangesRaw} />}
                    cursor={{ fill: 'var(--wd-border)', opacity: 0.3 }}
                  />
                  <Bar dataKey="fails" fill="var(--wd-danger)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="degraded" fill="var(--wd-warning)" radius={[3, 3, 0, 0]} />
                  <ForegroundReferenceArea ranges={incidentRangesRaw} />
                </BarChart>
              ) : (
                <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="detailChartGrad" x1="0" x2="0" y1="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor={chartMode === 'uptime' ? 'var(--wd-success)' : 'var(--wd-primary)'}
                        stopOpacity={0.12}
                      />
                      <stop
                        offset="95%"
                        stopColor={chartMode === 'uptime' ? 'var(--wd-success)' : 'var(--wd-primary)'}
                        stopOpacity={0}
                      />
                    </linearGradient>
                    <linearGradient id="detailChartGradP95" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--wd-warning)" stopOpacity={0.08} />
                      <stop offset="95%" stopColor="var(--wd-warning)" stopOpacity={0} />
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
                    domain={chartMode === 'uptime' ? [0, 100] : [0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 100]}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent unit={chartMode === 'uptime' ? '%' : 'ms'} incidentRanges={incidentRanges} />}
                    cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                  />
                  {chartMode === 'response' ? (
                    <>
                      {responseMinMax && responseMinMax.min !== Infinity && (
                        <ReferenceLine
                          y={responseMinMax.min}
                          stroke="var(--wd-success)"
                          strokeDasharray="3 3"
                          strokeOpacity={0.6}
                          label={{
                            value: `Min ${responseMinMax.min}ms`,
                            position: 'insideTopRight',
                            fontSize: 10,
                            fill: 'var(--wd-success)',
                          }}
                        />
                      )}
                      {responseMinMax && responseMinMax.max !== -Infinity && (
                        <ReferenceLine
                          y={responseMinMax.max}
                          stroke="var(--wd-danger)"
                          strokeDasharray="3 3"
                          strokeOpacity={0.6}
                          label={{
                            value: `Max ${responseMinMax.max}ms`,
                            position: 'insideBottomRight',
                            fontSize: 10,
                            fill: 'var(--wd-danger)',
                          }}
                        />
                      )}
                      <Area
                        dataKey="p95"
                        stroke="var(--wd-warning)"
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                        fill="url(#detailChartGradP95)"
                        fillOpacity={1}
                        type="monotone"
                        dot={false}
                      />
                      <Area
                        dataKey="avg"
                        stroke="var(--wd-primary)"
                        strokeWidth={2}
                        fill="url(#detailChartGrad)"
                        fillOpacity={1}
                        type="monotone"
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    </>
                  ) : (
                    <Area
                      dataKey="uptime"
                      stroke="var(--wd-success)"
                      strokeWidth={2}
                      fill="url(#detailChartGrad)"
                      fillOpacity={1}
                      type="monotone"
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                    />
                  )}
                  <ForegroundReferenceArea ranges={incidentRanges} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </div>

        {/* Incidents + Live Checks (side by side) */}
        <div className="grid grid-cols-2 gap-6">
        {/* Recent incidents */}
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Icon icon="solar:danger-triangle-linear" width={16} className="text-wd-muted" />
              <h3 className="text-sm font-semibold text-foreground">Recent Incidents</h3>
              {incidents.length > 0 && (
                <span className="text-[10px] text-wd-muted">({incidents.length})</span>
              )}
            </div>
            <span
              className="text-[10px] text-wd-primary font-medium cursor-pointer hover:underline"
              onClick={() => onTabChange('incidents')}
            >
              View all &rarr;
            </span>
          </div>

          {incidents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 h-full -translate-y-8">
              <Icon icon="solar:shield-check-linear" width={28} className="text-wd-success mb-2" />
              <p className="text-xs text-wd-muted">All Clear — No Incidents</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-52 overflow-y-auto wd-scroll-thin">
              {incidents.map((inc) => {
                const isActive = inc.status === 'active'
                return (
                  <div
                    key={inc._id}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors cursor-pointer',
                      isActive
                        ? 'bg-wd-danger/5 border border-wd-danger/10 hover:bg-wd-danger/8'
                        : 'bg-wd-surface-hover/40 hover:bg-wd-surface-hover',
                    )}
                    onClick={() => onIncidentClick(inc._id)}
                  >
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full shrink-0',
                        isActive ? 'bg-wd-danger animate-pulse' : 'bg-wd-success',
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-foreground truncate">{inc.cause}</div>
                      <div className="text-[10px] text-wd-muted">
                        {isActive
                          ? `Started ${timeAgo(inc.startedAt)} — ${formatDate(inc.startedAt)}`
                          : `Lasted ${inc.durationSeconds ? formatDuration(inc.durationSeconds) : '—'} — ${formatDate(inc.startedAt)}`}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0',
                        isActive ? 'bg-wd-danger/10 text-wd-danger' : 'bg-wd-success/10 text-wd-success',
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

        {/* Live checks */}
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Icon icon="solar:pulse-2-linear" width={16} className="text-wd-muted" />
              <h3 className="text-sm font-semibold text-foreground">Live Checks</h3>
              <span className="text-[10px] text-wd-muted">({recentChecks.length})</span>
            </div>
            <span
              className="text-[10px] text-wd-primary font-medium cursor-pointer hover:underline"
              onClick={() => onTabChange('checks')}
            >
              View all &rarr;
            </span>
          </div>

          {recentChecks.length === 0 ? (
            <div className="py-4 text-center">
              <Icon icon="solar:pulse-2-linear" width={24} className="mx-auto text-wd-muted/40 mb-1.5" />
              <p className="text-xs text-wd-muted">No checks yet</p>
            </div>
          ) : (
            <div className="space-y-1 max-h-52 overflow-y-auto wd-scroll-thin">
              {recentChecks.map((check) => {
                const csc = statusColors[check.status]
                return (
                  <div
                    key={check._id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-wd-surface-hover/30 hover:bg-wd-surface-hover/60 transition-colors cursor-pointer"
                    onClick={() => onCheckClick(check._id)}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', csc.dot)} />
                    <div className="flex-1 min-w-0 flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono font-medium text-foreground">
                          {check.responseTime}ms
                        </span>
                        {check.statusCode && (
                          <span className="text-[10px] font-mono text-wd-muted">{check.statusCode}</span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-wd-muted shrink-0">
                        {timeAgo(check.timestamp)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      </div>

      {/* ── Right column (1/3) — details panel ────────────────────────── */}
      <div>
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5">
          {/* Performance */}
          <div className="flex items-center gap-2 mb-2.5">
            <Icon icon="solar:graph-up-linear" width={16} className="text-wd-primary" />
            <h3 className="text-xs font-semibold text-foreground">Performance</h3>
            {perfStats && (
              <span className="text-[10px] text-wd-muted ml-auto"><span className="font-mono">{perfStats.totalChecks}</span> checks</span>
            )}
          </div>
          {perfStats ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">Avg</div>
                <div className="text-sm font-mono font-semibold text-foreground">{perfStats.avg}<span className="text-[10px] text-wd-muted font-normal">ms</span></div>
              </div>
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">Min</div>
                <div className="text-sm font-mono font-semibold text-wd-success">{perfStats.min}<span className="text-[10px] text-wd-muted font-normal">ms</span></div>
              </div>
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">Max</div>
                <div className="text-sm font-mono font-semibold text-wd-danger">{perfStats.max}<span className="text-[10px] text-wd-muted font-normal">ms</span></div>
              </div>
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">P95</div>
                <div className="text-sm font-mono font-semibold text-wd-warning">{perfStats.p95}<span className="text-[10px] text-wd-muted font-normal">ms</span></div>
              </div>
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">P99</div>
                <div className="text-sm font-mono font-semibold text-wd-warning">{perfStats.p99}<span className="text-[10px] text-wd-muted font-normal">ms</span></div>
              </div>
              <div className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] text-wd-muted">Checks</div>
                <div className="text-sm font-mono font-semibold text-foreground">{perfStats.totalChecks}</div>
              </div>
            </div>
          ) : (
            <div className="py-3 text-center">
              <p className="text-xs text-wd-muted">No performance data yet</p>
            </div>
          )}

          <Separator className="!bg-wd-border/30 my-3.5" />
          
          {/* Uptime stats */}
          <div className="flex items-center gap-2 mb-2.5">
            <Icon icon="solar:shield-check-linear" width={16} className="text-wd-success" />
            <h3 className="text-xs font-semibold text-foreground">Uptime</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['24h', '7d', '30d', '90d'] as const).map((period) => (
              <div key={period} className="rounded-lg bg-wd-surface-hover/50 px-2.5 py-1.5">
                <div className="text-[10px] font-mono text-wd-muted">{period}</div>
                <div className="text-sm font-mono font-semibold text-foreground">
                  {uptimeStats?.[period] != null ? `${uptimeStats[period]!.toFixed(2)}%` : '—'}
                </div>
              </div>
            ))}
          </div>

          <Separator className="!bg-wd-border/30 my-3.5" />

          {/* Configuration + Alerting side by side, stacks on narrow viewports */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Configuration */}
            <div>
              <div className="flex items-center gap-2 mb-2.5">
                <Icon icon="solar:settings-minimalistic-linear" width={16} className="text-wd-muted" />
                <h3 className="text-xs font-semibold text-foreground">Configuration</h3>
              </div>
              <div className="space-y-2">
                <InfoRow label="Type" value={endpoint.type.toUpperCase()} />
                {endpoint.type === 'http' && (
                  <>
                    <InfoRow label="Method" value={endpoint.method ?? 'GET'} />
                    <InfoRow
                      label="Status Codes"
                      value={endpoint.expectedStatusCodes?.join(', ') ?? '200-299'}
                    />
                  </>
                )}
                {endpoint.type === 'port' && (
                  <InfoRow label="Port" value={String(endpoint.port ?? '—')} />
                )}
                <InfoRow label="Interval" value={endpoint.checkInterval >= 60
                  ? `${Math.floor(endpoint.checkInterval / 60)}m`
                  : `${endpoint.checkInterval}s`}
                />
                <InfoRow label="Timeout" value={`${endpoint.timeout / 1000}s`} />
                <InfoRow label="Latency Limit" value={`${endpoint.latencyThreshold}ms`} />
              </div>
            </div>

            {/* Alerting */}
            <div>
              <div className="flex items-center gap-2 mb-2.5">
                <Icon icon="solar:bell-linear" width={16} className="text-wd-warning" />
                <h3 className="text-xs font-semibold text-foreground">Alerting</h3>
              </div>
              <div className="space-y-2">
                <InfoRow label="Fail Threshold" value={`${endpoint.failureThreshold} checks`} mono={false} />
                <InfoRow label="Cooldown" value={formatDuration(endpoint.alertCooldown)} mono={false} />
                <InfoRow label="Recovery Alert" value={endpoint.recoveryAlert ? 'Yes' : 'No'} mono={false} />
                <InfoRow label="Escalation" value={endpoint.escalationDelay > 0
                  ? `after ${formatDuration(endpoint.escalationDelay)}`
                  : 'Off'}
                  mono={false}
                />
                {endpoint.type === 'http' && (
                  <InfoRow label="SSL Warning" value={`${endpoint.sslWarningDays} days`} mono={false} />
                )}
                <InfoRow label="Channels" value={`${endpoint.notificationChannelIds.length} linked`} mono={false} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers — small subcomponents
// ---------------------------------------------------------------------------

function InfoRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-wd-muted w-28 shrink-0">{label}</span>
      <span className={cn('text-[11px] font-medium text-foreground', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

const statAccent: Record<'primary' | 'success' | 'warning' | 'danger' | 'muted', { bg: string; fg: string }> = {
  primary: { bg: 'bg-wd-primary/10', fg: 'text-wd-primary' },
  success: { bg: 'bg-wd-success/10', fg: 'text-wd-success' },
  warning: { bg: 'bg-wd-warning/10', fg: 'text-wd-warning' },
  danger: { bg: 'bg-wd-danger/10', fg: 'text-wd-danger' },
  muted: { bg: 'bg-wd-surface-hover', fg: 'text-wd-muted' },
}

const LiveRuntime = memo(function LiveRuntime({ createdAt }: { createdAt: string }) {
  const startMs = useMemo(() => new Date(createdAt).getTime(), [createdAt])
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startMs) / 1000)),
  )
  useEffect(() => {
    const id = setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [startMs])
  return <>{formatRuntime(seconds)}</>
})

function StatCell({
  icon,
  accent,
  label,
  value,
  valueClass,
}: {
  icon: string
  accent: 'primary' | 'success' | 'warning' | 'danger' | 'muted'
  label: string
  value: ReactNode
  valueClass?: string
}) {
  const a = statAccent[accent]
  return (
    <div className="flex items-center gap-2">
      <div className={cn('rounded-lg p-1.5', a.bg)}>
        <Icon icon={icon} width={16} className={a.fg} />
      </div>
      <div>
        <div className="text-[10px] text-wd-muted">{label}</div>
        <div className={cn('text-sm font-mono font-semibold text-foreground', valueClass)}>{value}</div>
      </div>
    </div>
  )
}
