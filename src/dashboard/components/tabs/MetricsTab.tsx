import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Spinner,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Dropdown,
  Header,
  Label,
  DateRangePicker,
  DateField,
  RangeCalendar,
  cn,
} from '@heroui/react'
import { Icon } from '@iconify/react'
import { CalendarDate } from '@internationalized/date'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useApi } from '../../hooks/useApi'
import type { HourlySummary, DailySummary, ApiCheck } from '../../types/api'
import { formatHour, getIncidentRanges } from '../../utils/format'
import type { IncidentRange } from '../../utils/format'
import ForegroundReferenceArea from '../ForegroundReferenceArea'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d' | 'custom'
type Granularity = 'auto' | 'hourly' | 'daily'
type ChartMode = 'response' | 'uptime' | 'errors'

interface MetricsTabProps {
  endpointId: string
  endpointType: 'http' | 'port'
}

// ---------------------------------------------------------------------------
// Series config — distinct colours, no min/max (those are ref lines)
// ---------------------------------------------------------------------------

const RESPONSE_SERIES = [
  { key: 'avg', label: 'Average', color: 'var(--wd-primary)', icon: 'solar:graph-up-linear' },
  { key: 'p95', label: 'P95', color: 'var(--wd-warning)', icon: 'solar:graph-up-linear' },
  { key: 'p99', label: 'P99', color: '#ec4899', icon: 'solar:graph-up-linear' },
]

const chartModes: { id: ChartMode; label: string; icon: string }[] = [
  { id: 'response', label: 'Response Time', icon: 'solar:graph-up-linear' },
  { id: 'uptime', label: 'Uptime', icon: 'solar:shield-check-linear' },
  { id: 'errors', label: 'Errors', icon: 'solar:danger-triangle-linear' },
]

// Minimum data-points per preset — show chart as soon as any data exists
const EXPECTED_POINTS: Record<Exclude<TimeRange, 'custom'>, number> = {
  '1h': 1,
  '24h': 1,
  '7d': 1,
  '30d': 1,
  '90d': 1,
}

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

  const matchedRange = incidentRanges?.find(
    (r) => label != null && label >= r.x1 && label <= r.x2,
  )

  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg max-w-[280px]">
      <div className="text-[11px] text-wd-muted mb-1">{label}</div>
      {payload.map((entry: { dataKey: string; value: number; color: string; name?: string }) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-wd-muted [word-break:normal] [overflow-wrap:normal]">{entry.name ?? entry.dataKey}:</span>
          <span className="font-semibold text-foreground">
            {typeof entry.value === 'number' ? Math.round(entry.value) : entry.value}
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
// KPI tooltip wrapper
// ---------------------------------------------------------------------------

function KpiTooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <Tooltip delay={200} closeDelay={0}>
      <TooltipTrigger>{children}</TooltipTrigger>
      <TooltipContent placement="bottom" className="px-2.5 py-1.5 text-[11px] max-w-[280px] text-center font-medium [word-break:normal] [overflow-wrap:normal]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// MetricsTab
// ---------------------------------------------------------------------------

export default function MetricsTab({ endpointId }: MetricsTabProps) {
  const { request } = useApi()

  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  const [dateRange, setDateRange] = useState<{ start: CalendarDate; end: CalendarDate } | null>(null)
  const [granularity, setGranularity] = useState<Granularity>('auto')
  const [chartMode, setChartMode] = useState<ChartMode>('response')
  const [visibleSeries, setVisibleSeries] = useState(new Set(['avg', 'p95']))
  const [hourlySummaries, setHourlySummaries] = useState<HourlySummary[]>([])
  const [rawChecks, setRawChecks] = useState<ApiCheck[]>([])
  const [loading, setLoading] = useState(true)

  // Effective granularity
  const effectiveGranularity = useMemo(() => {
    if (granularity !== 'auto') return granularity
    if (timeRange === '1h') return 'raw' as const
    if (timeRange === '24h') return 'hourly' as const
    return 'daily' as const
  }, [granularity, timeRange])

  // Build from/to ISO strings from either preset or custom date range
  const dateParams = useMemo(() => {
    if (timeRange === 'custom' && dateRange) {
      const from = new Date(dateRange.start.year, dateRange.start.month - 1, dateRange.start.day).toISOString()
      const to = new Date(dateRange.end.year, dateRange.end.month - 1, dateRange.end.day, 23, 59, 59).toISOString()
      return { from, to }
    }
    const now = Date.now()
    const rangeMs: Record<string, number> = {
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
      '90d': 90 * 24 * 60 * 60 * 1000,
    }
    const ms = rangeMs[timeRange]
    return ms ? { from: new Date(now - ms).toISOString(), to: undefined } : { from: undefined, to: undefined }
  }, [timeRange, dateRange])

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true)

    const fromQ = dateParams.from ? `&from=${dateParams.from}` : ''
    const toQ = dateParams.to ? `&to=${dateParams.to}` : ''

    if (effectiveGranularity === 'raw' || timeRange === '1h') {
      const from = dateParams.from ?? new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const res = await request<{ data: ApiCheck[] }>(
        `/endpoints/${endpointId}/checks?limit=100&from=${from}${toQ}`,
      )
      setRawChecks(res.status < 400 ? (res.data.data ?? []) : [])
      setHourlySummaries([])
    } else if (effectiveGranularity === 'hourly') {
      const limitMap: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160, custom: 720 }
      const limit = limitMap[timeRange] ?? 24
      const res = await request<{ data: HourlySummary[] }>(
        `/endpoints/${endpointId}/hourly?limit=${limit}${fromQ}${toQ}`,
      )
      setHourlySummaries(res.status < 400 ? (res.data.data ?? []) : [])
      setRawChecks([])
    } else {
      const limitMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, custom: 365 }
      const limit = limitMap[timeRange] ?? 30
      const res = await request<{ data: DailySummary[] }>(
        `/endpoints/${endpointId}/daily?limit=${limit}${fromQ}${toQ}`,
      )
      const dailies = res.status < 400 ? (res.data.data ?? []) : []
      setHourlySummaries(
        dailies.map((d) => ({
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
        })),
      )
      setRawChecks([])
    }

    setLoading(false)
  }, [endpointId, request, timeRange, effectiveGranularity, dateParams])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Chart data
  const useRaw = rawChecks.length > 0
  const chartData = useMemo(() => {
    if (useRaw) {
      const sorted = [...rawChecks].sort(
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
        downtime: c.status === 'healthy' ? 0 : c.status === 'degraded' ? 50 : 100,
        fails: c.status === 'down' ? 1 : 0,
        degraded: c.status === 'degraded' ? 1 : 0,
      }))
    }

    if (hourlySummaries.length === 0) return []
    const sorted = [...hourlySummaries].sort(
      (a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime(),
    )
    const isDaily = effectiveGranularity === 'daily'
    return sorted.map((h) => ({
      label: isDaily
        ? new Date(h.hour).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : formatHour(h.hour),
      avg: Math.round(h.avgResponseTime),
      p95: Math.round(h.p95ResponseTime),
      p99: Math.round(h.p99ResponseTime),
      uptime: h.uptimePercent,
      downtime: +(100 - h.uptimePercent).toFixed(2),
      fails: h.failCount,
      degraded: h.degradedCount,
    }))
  }, [rawChecks, hourlySummaries, useRaw, effectiveGranularity])

  // 50% data threshold — only for presets, not custom
  const hasEnoughData = useMemo(() => {
    if (timeRange === 'custom') return chartData.length > 0
    const threshold = EXPECTED_POINTS[timeRange] ?? 1
    return chartData.length >= threshold
  }, [chartData, timeRange])

  // Auto-hide P95/P99 on 1h when they match avg (raw data = same value per check)
  useEffect(() => {
    if (timeRange === '1h' && chartData.length > 0) {
      const allSame = chartData.every((d) => d.p95 === d.avg && d.p99 === d.avg)
      if (allSame) {
        setVisibleSeries((prev) => {
          const next = new Set(prev)
          next.delete('p95')
          next.delete('p99')
          if (!next.has('avg')) next.add('avg')
          return next
        })
      }
    }
  }, [timeRange, chartData])

  // KPI stats
  const kpiStats = useMemo(() => {
    if (useRaw && rawChecks.length > 0) {
      const times = rawChecks.map((c) => c.responseTime).sort((a, b) => a - b)
      const n = times.length
      const sum = times.reduce((s, t) => s + t, 0)
      const p95i = Math.min(Math.ceil(n * 0.95) - 1, n - 1)
      const healthy = rawChecks.filter((c) => c.status === 'healthy').length
      return {
        avg: Math.round(sum / n),
        p95: times[p95i] ?? 0,
        uptime: n > 0 ? ((healthy / n) * 100).toFixed(2) : '—',
        total: n,
      }
    }
    if (hourlySummaries.length === 0) return null
    let sumAvg = 0
    let sumP95 = 0
    let totalChecks = 0
    let uptimeSum = 0
    for (const h of hourlySummaries) {
      sumAvg += h.avgResponseTime * h.totalChecks
      sumP95 += h.p95ResponseTime
      totalChecks += h.totalChecks
      uptimeSum += h.uptimePercent
    }
    const n = hourlySummaries.length
    return {
      avg: totalChecks > 0 ? Math.round(sumAvg / totalChecks) : 0,
      p95: Math.round(sumP95 / n),
      uptime: (uptimeSum / n).toFixed(2),
      total: totalChecks,
    }
  }, [rawChecks, hourlySummaries, useRaw])

  // Incident ranges for reference area shading
  const incidentRanges = useMemo(() => getIncidentRanges(chartData), [chartData])

  // Min/Max reference line values — exclude incident data (operational only)
  const refLines = useMemo(() => {
    if (chartMode !== 'response' || chartData.length === 0) return null
    let min = Infinity
    let max = -Infinity
    for (const d of chartData) {
      // Skip data during incidents — min/max is for healthy operation only
      if (Number(d.fails ?? 0) > 0 || Number(d.degraded ?? 0) > 0) continue
      const v = Number(d.avg)
      if (v <= 0) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max }
  }, [chartData, chartMode])

  // Toggle series visibility
  const toggleSeries = (key: string) => {
    setVisibleSeries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Handle preset selection (clears custom range)
  const selectPreset = (r: Exclude<TimeRange, 'custom'>) => {
    setTimeRange(r)
    setDateRange(null)
  }

  // Handle custom date range selection
  const handleDateRangeChange = (value: { start: CalendarDate; end: CalendarDate } | null) => {
    if (value) {
      setDateRange(value)
      setTimeRange('custom')
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Controls ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Time range presets + DateRangePicker */}
        <div className="flex items-center gap-3">
          {/* Live indicator — shown for all preset ranges (they include current data) */}
          {timeRange !== 'custom' && (
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-wd-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-wd-success" />
              </span>
              <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-wd-success">Live</span>
            </div>
          )}
          <div className="flex items-center gap-0.5 rounded-lg bg-wd-surface-hover/50 p-0.5">
            {(['1h', '24h', '7d', '30d', '90d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => selectPreset(r)}
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

          {/* HeroUI DateRangePicker with calendar popover */}
          <DateRangePicker
            value={dateRange}
            onChange={handleDateRangeChange}
            aria-label="Custom date range"
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
              <RangeCalendar aria-label="Custom date range">
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

        {/* Granularity toggle */}
        <div className="flex items-center gap-2">
          <Tooltip delay={200} closeDelay={0}>
            <TooltipTrigger>
              <span className="text-[11px] text-wd-muted cursor-help">Granularity:</span>
            </TooltipTrigger>
            <TooltipContent placement="bottom" className="px-2.5 py-1.5 text-[11px] max-w-[280px] text-center font-medium [word-break:normal] [overflow-wrap:normal]">
              Controls the time resolution of chart data. &quot;Auto&quot; picks the best granularity for the selected range.
            </TooltipContent>
          </Tooltip>
          <div className="flex items-center gap-0.5 rounded-lg bg-wd-surface-hover/50 p-0.5">
            {(['auto', 'hourly', 'daily'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer capitalize',
                  granularity === g
                    ? 'bg-wd-surface text-foreground shadow-sm'
                    : 'text-wd-muted hover:text-foreground',
                )}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────────── */}
      {kpiStats && (
        <div className="grid grid-cols-4 gap-4">
          <KpiTooltip text="Average response time across all checks in the selected period">
            <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5 cursor-help">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="rounded-lg bg-wd-primary/10 p-1.5">
                  <Icon icon="solar:graph-up-linear" width={16} className="text-wd-primary" />
                </div>
                <span className="text-[11px] text-wd-muted">Avg Response</span>
              </div>
              <div className="text-xl font-mono font-semibold text-foreground">
                {kpiStats.avg}<span className="text-xs text-wd-muted font-normal">ms</span>
              </div>
            </div>
          </KpiTooltip>
          <KpiTooltip text="95th percentile response time — 95% of checks responded faster than this value">
            <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5 cursor-help">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="rounded-lg bg-wd-warning/10 p-1.5">
                  <Icon icon="solar:graph-up-linear" width={16} className="text-wd-warning" />
                </div>
                <span className="text-[11px] text-wd-muted">P95 Response</span>
              </div>
              <div className="text-xl font-mono font-semibold text-foreground">
                {kpiStats.p95}<span className="text-xs text-wd-muted font-normal">ms</span>
              </div>
            </div>
          </KpiTooltip>
          <KpiTooltip text="Percentage of checks that returned a healthy status in this period">
            <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5 cursor-help">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="rounded-lg bg-wd-success/10 p-1.5">
                  <Icon icon="solar:shield-check-linear" width={16} className="text-wd-success" />
                </div>
                <span className="text-[11px] text-wd-muted">Uptime</span>
              </div>
              <div className="text-xl font-mono font-semibold text-foreground">
                {kpiStats.uptime}<span className="text-xs text-wd-muted font-normal">%</span>
              </div>
            </div>
          </KpiTooltip>
          <KpiTooltip text="Total number of health checks completed in the selected period">
            <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5 cursor-help">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="rounded-lg bg-wd-surface-hover p-1.5">
                  <Icon icon="solar:checklist-minimalistic-linear" width={16} className="text-wd-muted" />
                </div>
                <span className="text-[11px] text-wd-muted">Total Checks</span>
              </div>
              <div className="text-xl font-mono font-semibold text-foreground">
                {kpiStats.total.toLocaleString()}
              </div>
            </div>
          </KpiTooltip>
        </div>
      )}

      {/* ── Main Chart ────────────────────────────────────────────── */}
      <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
        {/* Chart mode + series toggles + export */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-1">
            {chartModes.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setChartMode(m.id)}
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

          {chartMode === 'response' && (
            <div className="flex items-center gap-1.5">
              {RESPONSE_SERIES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggleSeries(s.key)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer',
                    visibleSeries.has(s.key)
                      ? 'border'
                      : 'text-wd-muted bg-wd-surface-hover/50 opacity-50',
                  )}
                  style={
                    visibleSeries.has(s.key)
                      ? {
                          backgroundColor: `color-mix(in srgb, ${s.color} 10%, transparent)`,
                          borderColor: `color-mix(in srgb, ${s.color} 30%, transparent)`,
                          color: s.color,
                        }
                      : undefined
                  }
                >
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                  {s.label}
                </button>
              ))}
              {/* Min/Max legend (reference lines, not toggleable) */}
              <span className="flex items-center gap-1 text-[10px] text-wd-muted ml-2">
                <span className="w-3 border-t border-dashed border-wd-success" /> Min
                <span className="w-3 border-t border-dashed border-wd-danger ml-1.5" /> Max
              </span>
            </div>
          )}

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
                <Dropdown.Item id="export-csv" textValue="Export CSV">
                  <Label className="!text-xs">Export as CSV</Label>
                </Dropdown.Item>
                <Dropdown.Item id="export-json" textValue="Export JSON">
                  <Label className="!text-xs">Export as JSON</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          </div>
        </div>

        {/* Chart area */}
        {loading ? (
          <div className="h-80 flex items-center justify-center">
            <Spinner size="md" />
          </div>
        ) : !hasEnoughData ? (
          <div className="h-80 flex flex-col items-center justify-center text-wd-muted gap-2">
            <Icon icon="solar:chart-square-linear" width={28} className="opacity-40" />
            <p className="text-sm">Not enough data for {timeRange} view yet</p>
            <p className="text-[11px] text-wd-muted/60">
              Need at least {EXPECTED_POINTS[timeRange as keyof typeof EXPECTED_POINTS] ?? '—'} data points, have {chartData.length}
            </p>
          </div>
        ) : chartMode === 'errors' && chartData.every((d) => Number(d.fails ?? 0) === 0 && Number(d.degraded ?? 0) === 0) ? (
          <div className="h-80 flex flex-col items-center justify-center gap-2">
            <Icon icon="solar:shield-check-bold" width={28} className="text-wd-success opacity-60" />
            <p className="text-sm font-medium text-wd-success">No errors detected</p>
            <p className="text-[11px] text-wd-muted/60">
              No outages or degraded checks in the last {timeRange === 'custom' ? 'selected period' : timeRange}
            </p>
          </div>
        ) : (
          <div className="h-80 select-none">
            <ResponsiveContainer
              className="[&_.recharts-surface]:outline-hidden [&_*:focus]:!outline-none"
              width="100%"
              height="100%"
            >
              {chartMode === 'errors' ? (
                /* ── Errors: stacked area — down (red) on top, degraded (yellow) below ── */
                <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="metricsGrad-fails" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--wd-danger)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--wd-danger)" stopOpacity={0.04} />
                    </linearGradient>
                    <linearGradient id="metricsGrad-degraded" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--wd-warning)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--wd-warning)" stopOpacity={0.04} />
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
                    allowDecimals={false}
                    width={40}
                    domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 1]}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent incidentRanges={incidentRanges} />}
                    cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                  />
                  <Area
                    dataKey="degraded"
                    name="Degraded"
                    stackId="errors"
                    stroke="var(--wd-warning)"
                    strokeWidth={1.5}
                    fill="url(#metricsGrad-degraded)"
                    fillOpacity={1}
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--wd-warning)' }}
                    isAnimationActive={false}
                  />
                  <Area
                    dataKey="fails"
                    name="Down"
                    stackId="errors"
                    stroke="var(--wd-danger)"
                    strokeWidth={2}
                    fill="url(#metricsGrad-fails)"
                    fillOpacity={1}
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--wd-danger)' }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              ) : chartMode === 'uptime' ? (
                /* ── Uptime: green area + striped reference areas for incidents ── */
                <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="metricsGrad-uptime" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--wd-success)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--wd-success)" stopOpacity={0.05} />
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
                    domain={[0, 100]}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent unit="%" incidentRanges={incidentRanges} />}
                    cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                  />
                  <Area
                    dataKey="uptime"
                    name="Uptime"
                    stroke="var(--wd-success)"
                    strokeWidth={2}
                    fill="url(#metricsGrad-uptime)"
                    fillOpacity={1}
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--wd-success)' }}
                  />
                  <ForegroundReferenceArea ranges={incidentRanges} />
                </AreaChart>
              ) : (
                /* ── Response time: areas + min/max ref lines + incident ref areas ── */
                <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    {RESPONSE_SERIES.map((s) => (
                      <linearGradient key={s.key} id={`metricsGrad-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={s.color} stopOpacity={0.12} />
                        <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                      </linearGradient>
                    ))}
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
                    domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 100]}
                  />
                  <RechartsTooltip
                    content={<ChartTooltipContent unit="ms" incidentRanges={incidentRanges} />}
                    cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                  />
                  {/* Min reference line (operational data only) */}
                  {refLines && refLines.min > 0 && (
                    <ReferenceLine
                      y={refLines.min}
                      stroke="var(--wd-success)"
                      strokeDasharray="6 3"
                      strokeOpacity={0.7}
                      label={{
                        value: `Min ${refLines.min}ms`,
                        position: 'insideTopRight',
                        fontSize: 10,
                        fill: 'var(--wd-success)',
                      }}
                    />
                  )}
                  {/* Max reference line (operational data only) */}
                  {refLines && refLines.max > 0 && (
                    <ReferenceLine
                      y={refLines.max}
                      stroke="var(--wd-danger)"
                      strokeDasharray="6 3"
                      strokeOpacity={0.7}
                      label={{
                        value: `Max ${refLines.max}ms`,
                        position: 'insideBottomRight',
                        fontSize: 10,
                        fill: 'var(--wd-danger)',
                      }}
                    />
                  )}
                  {/* Area series */}
                  {RESPONSE_SERIES.map((s) =>
                    visibleSeries.has(s.key) ? (
                      <Area
                        key={s.key}
                        dataKey={s.key}
                        name={s.label}
                        stroke={s.color}
                        strokeWidth={s.key === 'avg' ? 2 : 1.5}
                        strokeDasharray={s.key === 'p99' ? '4 2' : undefined}
                        fill={`url(#metricsGrad-${s.key})`}
                        fillOpacity={s.key === 'avg' ? 1 : 0.5}
                        type="monotone"
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null,
                  )}
                  <ForegroundReferenceArea ranges={incidentRanges} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── Response Time Distribution ────────────────────────────── */}
      {chartMode === 'response' && chartData.length > 0 && hasEnoughData && (
        <ResponseDistribution data={chartData} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Response time distribution histogram
// ---------------------------------------------------------------------------

function ResponseDistribution({ data }: { data: Record<string, string | number>[] }) {
  const buckets = useMemo(() => {
    // Exclude incident data points from the distribution
    const values = data
      .filter((d) => Number(d.fails ?? 0) === 0 && Number(d.degraded ?? 0) === 0)
      .map((d) => Number(d.avg))
      .filter((v) => v > 0)
    if (values.length === 0) return []

    const min = Math.min(...values)
    const max = Math.max(...values)
    if (min === max) return [{ range: `${min}ms`, count: values.length, pct: 100 }]

    // Build 8 even buckets
    const bucketCount = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(values.length))))
    const step = Math.ceil((max - min) / bucketCount) || 1
    const counts = new Array(bucketCount).fill(0) as number[]
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / step), bucketCount - 1)
      counts[idx]++
    }
    const maxCount = Math.max(...counts)
    return counts.map((c, i) => ({
      range: `${Math.round(min + i * step)}–${Math.round(min + (i + 1) * step)}ms`,
      count: c,
      pct: maxCount > 0 ? (c / maxCount) * 100 : 0,
    }))
  }, [data])

  if (buckets.length === 0) return null

  const values = data
    .filter((d) => Number(d.fails ?? 0) === 0 && Number(d.degraded ?? 0) === 0)
    .map((d) => Number(d.avg))
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  const n = values.length
  const median = n % 2 === 0 ? Math.round((values[n / 2 - 1]! + values[n / 2]!) / 2) : values[Math.floor(n / 2)]!
  const p90 = values[Math.min(Math.ceil(n * 0.9) - 1, n - 1)]!
  const stddev = Math.round(
    Math.sqrt(values.reduce((s, v) => s + (v - (values.reduce((a, b) => a + b, 0) / n)) ** 2, 0) / n),
  )

  return (
    <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon icon="solar:chart-2-linear" width={16} className="text-wd-muted" />
          <span className="text-sm font-semibold text-foreground">Response Time Distribution</span>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-wd-muted">
          <span>Median: <span className="font-mono font-semibold text-foreground">{median}ms</span></span>
          <span>P90: <span className="font-mono font-semibold text-foreground">{p90}ms</span></span>
          <span>Std Dev: <span className="font-mono font-semibold text-foreground">±{stddev}ms</span></span>
        </div>
      </div>
      <div className="space-y-1">
        {buckets.map((b, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-wd-muted w-[100px] text-right shrink-0">{b.range}</span>
            <div className="flex-1 h-5 bg-wd-surface-hover/40 rounded overflow-hidden">
              <div
                className="h-full rounded bg-wd-primary/60 transition-all duration-300"
                style={{ width: `${b.pct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-wd-muted w-[32px] text-right shrink-0">{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
