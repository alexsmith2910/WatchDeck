import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Spinner } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import KpiCard from '../components/KpiCard'
import OverviewChart from '../components/OverviewChart'
import { Segmented } from '../components/endpoint-detail/primitives'
import { getIncidentRanges } from '../utils/format'
import { useFormat } from '../hooks/useFormat'
import { formatDateShort, formatHour, formatTime } from '../utils/time'
import type { Preferences } from '../context/PreferencesContext'

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface ApiEndpoint {
  _id: string
  name: string
  lastStatus?: 'healthy' | 'degraded' | 'down'
  enabled: boolean
  status: 'active' | 'paused' | 'archived'
}

interface ApiPagination {
  total: number
}

interface ApiIncident {
  _id: string
  endpointId: string
  status: 'active' | 'resolved'
  cause: string
  startedAt: string
}

interface UptimeStats {
  '24h': number | null
  '7d': number | null
  '30d': number | null
  '90d': number | null
}

interface HourlySummary {
  hour: string
  avgResponseTime: number
  p95ResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  uptimePercent: number
  totalChecks: number
  successCount: number
  failCount: number
  degradedCount: number
}

interface DailySummary {
  date: string
  avgResponseTime: number
  p95ResponseTime: number
  minResponseTime: number
  maxResponseTime: number
  uptimePercent: number
  totalChecks: number
  incidentCount: number
}

interface RawCheck {
  timestamp: string
  responseTime: number
  status: 'healthy' | 'degraded' | 'down'
  statusCode?: number
}

// ---------------------------------------------------------------------------
// Time range
// ---------------------------------------------------------------------------

type TimeRange = '1h' | '24h' | '7d' | '30d'

const TIME_RANGES: { key: TimeRange; label: string; hoursNeeded: number }[] = [
  { key: '1h', label: '1h', hoursNeeded: 1 },
  { key: '24h', label: '24h', hoursNeeded: 24 },
  { key: '7d', label: '7d', hoursNeeded: 168 },
  { key: '30d', label: '30d', hoursNeeded: 720 },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHourLabel(iso: string, prefs: Preferences): string {
  return formatHour(iso, prefs)
}

function formatDay(iso: string, prefs: Preferences): string {
  return formatDateShort(iso, prefs)
}

function formatMinute(iso: string, prefs: Preferences): string {
  return formatTime(iso, prefs)
}

/** Human-friendly duration for the data warning */
function humanDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// OverviewPage
// ---------------------------------------------------------------------------

export default function OverviewPage() {
  const navigate = useNavigate()
  const { request } = useApi()
  const { subscribe } = useSSE()
  const { prefs } = useFormat()

  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [activeIncidents, setActiveIncidents] = useState<ApiIncident[]>([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')

  // Track latest response times from SSE for a live average
  const [responseTimes, setResponseTimes] = useState<Map<string, number>>(new Map())

  // Aggregation data
  const [chartData, setChartData] = useState<Record<string, string | number>[]>([])
  const [availabilityData, setAvailabilityData] = useState<Record<string, string | number>[]>([])
  const [chartLoading, setChartLoading] = useState(false)
  const [dataHours, setDataHours] = useState<number | null>(null) // actual data span in hours

  // KPI sparkline data (from latest hourly summaries across all endpoints)
  const [kpiResponseData, setKpiResponseData] = useState<{ label: string; value: number }[]>([])
  const [kpiUptimeData, setKpiUptimeData] = useState<{ label: string; value: number }[]>([])

  // Uptime stats (24h) across all endpoints — for KPI card + delta
  const [uptimeAvg24h, setUptimeAvg24h] = useState<number | null>(null)

  // Previous-period response time (for delta comparison)
  const [prevAvgResponse, setPrevAvgResponse] = useState<number | null>(null)

  // Fetch data on mount
  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [epRes, incRes] = await Promise.all([
        request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=100'),
        request<{ data: ApiIncident[]; pagination: ApiPagination }>('/incidents?status=active&limit=5'),
      ])
      setEndpoints(epRes.data.data)
      setActiveIncidents(incRes.data.data ?? [])

      // Fetch uptime stats for all endpoints
      const ids = epRes.data.data.map((ep: ApiEndpoint) => ep._id)
      if (ids.length > 0) {
        const uptimeResults = await Promise.allSettled(
          ids.map((id: string) => request<{ data: UptimeStats }>(`/endpoints/${id}/uptime`).then((r) => r.data.data)),
        )
        const uptimes: number[] = []
        for (const r of uptimeResults) {
          if (r.status === 'fulfilled' && r.value['24h'] != null) {
            uptimes.push(r.value['24h'])
          }
        }
        if (uptimes.length > 0) {
          setUptimeAvg24h(Math.round(uptimes.reduce((s, v) => s + v, 0) / uptimes.length * 100) / 100)
        } else {
          setUptimeAvg24h(null)
        }
      }
    } catch {
      // Leave as empty/zero on failure
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Fetch chart data when time range or endpoints change
  useEffect(() => {
    if (endpoints.length === 0) {
      setChartData([])
      setAvailabilityData([])
      setDataHours(null)
      return
    }
    let cancelled = false

    const fetchCharts = async () => {
      setChartLoading(true)
      try {
        const ids = endpoints.map((ep) => ep._id)

        if (timeRange === '1h') {
          // Use raw checks from the last hour
          const from = new Date(Date.now() - 3_600_000).toISOString()
          const results = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: RawCheck[]; pagination: ApiPagination }>(
                `/endpoints/${id}/checks?from=${from}&limit=100`,
              ).then((r) => r.data.data),
            ),
          )
          if (cancelled) return

          // Merge all checks into time buckets (1-minute resolution)
          const allChecks: RawCheck[] = []
          for (const r of results) {
            if (r.status === 'fulfilled') allChecks.push(...r.value)
          }
          allChecks.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

          // Bucket by minute
          const buckets = new Map<string, { rts: number[]; healthy: number; degraded: number; down: number; total: number }>()
          for (const c of allChecks) {
            const d = new Date(c.timestamp)
            d.setSeconds(0, 0)
            const key = d.toISOString()
            const b = buckets.get(key) ?? { rts: [], healthy: 0, degraded: 0, down: 0, total: 0 }
            b.rts.push(c.responseTime)
            b.total++
            if (c.status === 'healthy') b.healthy++
            else if (c.status === 'degraded') b.degraded++
            else b.down++
            buckets.set(key, b)
          }

          const rtData: Record<string, string | number>[] = []
          const avData: Record<string, string | number>[] = []
          for (const [key, b] of buckets) {
            const avg = Math.round(b.rts.reduce((s, v) => s + v, 0) / b.rts.length)
            const min = Math.min(...b.rts)
            const max = Math.max(...b.rts)
            const fails = b.down
            const degraded = b.degraded
            rtData.push({ label: formatMinute(key, prefs), avg, min, max, fails, degraded })
            const uptimeVal = b.total > 0 ? Math.round((b.healthy / b.total) * 10000) / 100 : 100
            const downPctVal = b.total > 0 ? Math.round((b.down / b.total) * 10000) / 100 : 0
            avData.push({
              label: formatMinute(key, prefs),
              uptime: uptimeVal,
              downPercent: downPctVal,
              fails,
              degraded,
              incidents: 0,
            })
          }

          if (!cancelled) {
            setChartData(rtData)
            setAvailabilityData(avData)
            // Compute actual data span
            if (allChecks.length >= 2) {
              const span = (new Date(allChecks[allChecks.length - 1]!.timestamp).getTime() - new Date(allChecks[0]!.timestamp).getTime()) / 3_600_000
              setDataHours(span)
            } else {
              setDataHours(allChecks.length > 0 ? 0.01 : null)
            }
          }
        } else if (timeRange === '24h') {
          // Use hourly summaries (last 24)
          const results = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: HourlySummary[] }>(`/endpoints/${id}/hourly?limit=24`).then((r) => r.data.data),
            ),
          )
          if (cancelled) return
          buildFromHourlies(results, cancelled)
        } else if (timeRange === '7d') {
          // Use daily summaries (last 7) — fall back to hourly if no daily data yet
          const dailyResults = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=7`).then((r) => r.data.data),
            ),
          )
          if (cancelled) return

          const hasDailyData = dailyResults.some(
            (r) => r.status === 'fulfilled' && r.value.length > 0,
          )

          if (hasDailyData) {
            buildFromDailies(dailyResults, cancelled)
          } else {
            // No daily summaries yet — fall back to hourly
            const hourlyResults = await Promise.allSettled(
              ids.map((id) =>
                request<{ data: HourlySummary[] }>(`/endpoints/${id}/hourly?limit=168`).then((r) => r.data.data),
              ),
            )
            if (cancelled) return
            buildFromHourlies(hourlyResults, cancelled)
          }
        } else {
          // 30d — try daily summaries first, fall back to hourly if none exist yet
          const dailyResults = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=30`).then((r) => r.data.data),
            ),
          )
          if (cancelled) return

          // Check if we got any daily data at all
          const hasDailyData = dailyResults.some(
            (r) => r.status === 'fulfilled' && r.value.length > 0,
          )

          if (hasDailyData) {
            buildFromDailies(dailyResults, cancelled)
          } else {
            // No daily summaries yet — fall back to hourly (up to 720 hours)
            const hourlyResults = await Promise.allSettled(
              ids.map((id) =>
                request<{ data: HourlySummary[] }>(`/endpoints/${id}/hourly?limit=720`).then((r) => r.data.data),
              ),
            )
            if (cancelled) return
            buildFromHourlies(hourlyResults, cancelled)
          }
        }
      } catch {
        // Leave charts empty on error
      } finally {
        if (!cancelled) setChartLoading(false)
      }
    }

    const buildFromHourlies = (results: PromiseSettledResult<HourlySummary[]>[], isCancelled: boolean) => {
      // Merge hourly summaries across endpoints by hour
      const byHour = new Map<string, { rts: number[]; p95s: number[]; mins: number[]; maxs: number[]; uptimes: number[]; healthy: number; degraded: number; down: number }>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const h of r.value) {
          const key = h.hour
          const b = byHour.get(key) ?? { rts: [], p95s: [], mins: [], maxs: [], uptimes: [], healthy: 0, degraded: 0, down: 0 }
          b.rts.push(h.avgResponseTime)
          b.p95s.push(h.p95ResponseTime)
          b.mins.push(h.minResponseTime)
          b.maxs.push(h.maxResponseTime)
          b.uptimes.push(h.uptimePercent)
          b.healthy += h.successCount
          b.degraded += h.degradedCount
          b.down += h.failCount
          byHour.set(key, b)
        }
      }

      const sorted = [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b))
      const rtData: Record<string, string | number>[] = []
      const avData: Record<string, string | number>[] = []
      const labelFn = sorted.length > 48 ? formatDay : formatHourLabel
      for (const [key, b] of sorted) {
        const avg = Math.round(b.rts.reduce((s, v) => s + v, 0) / b.rts.length)
        const p95 = Math.round(Math.max(...b.p95s))
        const min = Math.min(...b.mins)
        const max = Math.max(...b.maxs)
        const uptime = Math.round(b.uptimes.reduce((s, v) => s + v, 0) / b.uptimes.length * 100) / 100
        const total = b.healthy + b.degraded + b.down
        const downPct = total > 0 ? Math.round((b.down / total) * 10000) / 100 : 0
        rtData.push({ label: labelFn(key, prefs), avg, p95, min, max, fails: b.down, degraded: b.degraded })
        avData.push({ label: labelFn(key, prefs), uptime, downPercent: downPct, fails: b.down, degraded: b.degraded, incidents: 0 })
      }

      if (!isCancelled) {
        setChartData(rtData)
        setAvailabilityData(avData)
        if (sorted.length >= 2) {
          const span = (new Date(sorted[sorted.length - 1]![0]).getTime() - new Date(sorted[0]![0]).getTime()) / 3_600_000
          setDataHours(span)
        } else {
          setDataHours(sorted.length > 0 ? 1 : null)
        }
      }
    }

    const buildFromDailies = (results: PromiseSettledResult<DailySummary[]>[], isCancelled: boolean) => {
      const byDate = new Map<string, { rts: number[]; p95s: number[]; mins: number[]; maxs: number[]; uptimes: number[]; incidents: number }>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const d of r.value) {
          const key = d.date
          const b = byDate.get(key) ?? { rts: [], p95s: [], mins: [], maxs: [], uptimes: [], incidents: 0 }
          b.rts.push(d.avgResponseTime)
          b.p95s.push(d.p95ResponseTime)
          b.mins.push(d.minResponseTime)
          b.maxs.push(d.maxResponseTime)
          b.uptimes.push(d.uptimePercent)
          b.incidents += d.incidentCount ?? 0
          byDate.set(key, b)
        }
      }

      const sorted = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
      const rtData: Record<string, string | number>[] = []
      const avData: Record<string, string | number>[] = []
      for (const [key, b] of sorted) {
        const avg = Math.round(b.rts.reduce((s, v) => s + v, 0) / b.rts.length)
        const p95 = Math.round(Math.max(...b.p95s))
        const min = Math.min(...b.mins)
        const max = Math.max(...b.maxs)
        const uptime = Math.round(b.uptimes.reduce((s, v) => s + v, 0) / b.uptimes.length * 100) / 100
        const downPct = uptime < 100 ? Math.round((100 - uptime) * 100) / 100 : 0
        const fails = b.incidents
        rtData.push({ label: formatDay(key, prefs), avg, p95, min, max, fails })
        avData.push({ label: formatDay(key, prefs), uptime, downPercent: downPct, fails, incidents: 0 })
      }

      if (!isCancelled) {
        setChartData(rtData)
        setAvailabilityData(avData)
        if (sorted.length >= 2) {
          const span = (new Date(sorted[sorted.length - 1]![0]).getTime() - new Date(sorted[0]![0]).getTime()) / 3_600_000
          setDataHours(span)
        } else {
          setDataHours(sorted.length > 0 ? 24 : null)
        }
      }
    }

    fetchCharts()
    return () => { cancelled = true }
  }, [endpoints.length, timeRange, request])

  // Build KPI sparkline data + compute response time delta from chart data
  useEffect(() => {
    if (chartData.length > 0) {
      setKpiResponseData(chartData.map((d) => ({ label: String(d.label), value: Number(d.avg ?? 0) })))
      // Compute delta: compare first half avg vs second half avg
      const mid = Math.floor(chartData.length / 2)
      if (mid > 0) {
        const firstHalf = chartData.slice(0, mid)
        const secondHalf = chartData.slice(mid)
        const avgFirst = firstHalf.reduce((s, d) => s + Number(d.avg ?? 0), 0) / firstHalf.length
        const avgSecond = secondHalf.reduce((s, d) => s + Number(d.avg ?? 0), 0) / secondHalf.length
        setPrevAvgResponse(Math.round(avgFirst))
        // avgResponseTime (from SSE) is live; avgSecond is the recent half for reference
        void avgSecond // we use avgFirst as "prior period"
      }
    } else {
      setKpiResponseData([])
      setPrevAvgResponse(null)
    }
    if (availabilityData.length > 0) {
      setKpiUptimeData(availabilityData.map((d) => ({ label: String(d.label), value: Number(d.uptime ?? 100) })))
    } else {
      setKpiUptimeData([])
    }
  }, [chartData, availabilityData])

  // SSE: track live check results
  useEffect(() => {
    return subscribe('check:complete', (raw) => {
      const evt = raw as { endpointId: string; status: string; responseTime: number }
      setEndpoints((prev) =>
        prev.map((ep) =>
          ep._id === evt.endpointId
            ? { ...ep, lastStatus: evt.status as ApiEndpoint['lastStatus'] }
            : ep,
        ),
      )
      setResponseTimes((prev) => {
        const next = new Map(prev)
        next.set(evt.endpointId, evt.responseTime)
        return next
      })
    })
  }, [subscribe])

  // SSE: track endpoint changes
  useEffect(() => {
    return subscribe('endpoint:created', (raw) => {
      const evt = raw as { endpoint: ApiEndpoint }
      setEndpoints((prev) => [...prev, evt.endpoint])
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('endpoint:deleted', (raw) => {
      const evt = raw as { endpointId: string }
      setEndpoints((prev) => prev.filter((ep) => ep._id !== evt.endpointId))
    })
  }, [subscribe])

  // SSE: track incident changes
  useEffect(() => {
    return subscribe('incident:opened', (raw) => {
      const evt = raw as { incident: ApiIncident }
      if (evt.incident) {
        setActiveIncidents((prev) => [evt.incident, ...prev])
      }
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', (raw) => {
      const evt = raw as { incidentId: string }
      setActiveIncidents((prev) => prev.filter((i) => i._id !== evt.incidentId))
    })
  }, [subscribe])

  // Computed values
  const statusCounts = useMemo(() => {
    const counts = { healthy: 0, degraded: 0, down: 0, pending: 0 }
    for (const ep of endpoints) {
      if (ep.lastStatus) counts[ep.lastStatus]++
      else counts.pending++
    }
    return counts
  }, [endpoints])

  const avgResponseTime = useMemo(() => {
    if (responseTimes.size === 0) return null
    const values = [...responseTimes.values()]
    const sum = values.reduce((a, b) => a + b, 0)
    return Math.round(sum / values.length)
  }, [responseTimes])

  // Data warning
  const selectedRange = TIME_RANGES.find((r) => r.key === timeRange)!
  const dataInsufficient = dataHours != null && dataHours < selectedRange.hoursNeeded * 0.5

  const totalEndpoints = endpoints.length
  const upCount = statusCounts.healthy + statusCounts.degraded
  const downCount = statusCounts.down
  const incidentCount = activeIncidents.length

  // Incident KPI: find the endpoint name for the most recent active incident
  const topIncident = activeIncidents.length > 0 ? activeIncidents[0] : null
  const topIncidentEndpoint = topIncident
    ? endpoints.find((ep) => ep._id === topIncident.endpointId)?.name ?? null
    : null

  // Response time delta (vs prior half of chart period)
  const responseDelta = useMemo(() => {
    if (avgResponseTime == null || prevAvgResponse == null || prevAvgResponse === 0) return null
    const diff = avgResponseTime - prevAvgResponse
    const pct = Math.round((diff / prevAvgResponse) * 100)
    return { diff, pct }
  }, [avgResponseTime, prevAvgResponse])

  // Uptime delta: compare 24h uptime vs chart-period average
  const uptimeDelta = useMemo(() => {
    if (uptimeAvg24h == null || availabilityData.length < 1) return null
    const chartAvg = availabilityData.reduce((s, d) => s + Number(d.uptime ?? 100), 0) / availabilityData.length
    const diff = Math.round((uptimeAvg24h - chartAvg) * 100) / 100
    return diff
  }, [uptimeAvg24h, availabilityData])

  // Compute incident/degraded ranges for chart shading
  // Compute incident ranges from both datasets — availability for the uptime chart, chartData for response time
  const chartHighlightRanges = useMemo(() => getIncidentRanges(availabilityData), [availabilityData])
  const rtHighlightRanges = useMemo(() => getIncidentRanges(chartData), [chartData])

  // --- Early returns (after all hooks) ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-wd-muted">Loading overview...</p>
        </div>
      </div>
    )
  }

  if (totalEndpoints === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <div className="rounded-full bg-wd-primary/10 p-4">
            <Icon icon="solar:server-square-outline" width={40} className="text-wd-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">No endpoints yet</h2>
          <p className="text-sm text-wd-muted">
            Add your first endpoint to start monitoring. WatchDeck will track uptime,
            response times, and alert you when things go wrong.
          </p>
          <Button
            className="!bg-wd-primary !text-wd-primary-foreground !rounded-lg !font-medium"
            onPress={() => navigate('/endpoints/add')}
          >
            <Icon icon="solar:add-circle-outline" width={20} />
            Add Endpoint
          </Button>
        </div>
      </div>
    )
  }

  // Chart series configs — check which keys actually have data
  const hasP95 = chartData.some((d) => d.p95 != null && Number(d.p95) > 0)
  const hasMin = chartData.some((d) => d.min != null && Number(d.min) > 0)
  const hasMax = chartData.some((d) => d.max != null && Number(d.max) > 0)
  const responseTimeSeries = [
    { key: 'avg', label: 'Avg', color: 'var(--wd-primary)', icon: 'solar:graph-outline', value: avgResponseTime != null ? `${avgResponseTime}ms` : '\u2014', change: '', changeType: 'neutral' as const },
    { key: 'p95', label: 'P95', color: 'var(--wd-warning)', icon: 'solar:arrow-right-up-linear', value: hasP95 ? `${chartData[chartData.length - 1]?.p95 ?? '\u2014'}ms` : '\u2014', change: '', changeType: 'neutral' as const },
    { key: 'min', label: 'Min', color: 'var(--wd-success)', icon: 'solar:arrow-right-down-linear', value: hasMin ? `${Math.min(...chartData.map((d) => Number(d.min ?? 0)))}ms` : '\u2014', change: '', changeType: 'neutral' as const },
    { key: 'max', label: 'Max', color: 'var(--wd-danger)', icon: 'solar:arrow-right-up-linear', value: hasMax ? `${Math.max(...chartData.map((d) => Number(d.max ?? 0)))}ms` : '\u2014', change: '', changeType: 'neutral' as const },
  ]
  const rtDefaultHidden = [
    ...(!hasP95 ? ['p95'] : []),
    ...(!hasMin ? ['min'] : []),
    ...(!hasMax ? ['max'] : []),
  ]

  // Availability: compute summary stats
  const avgUptime = availabilityData.length > 0
    ? Math.round(availabilityData.reduce((s, d) => s + Number(d.uptime ?? 100), 0) / availabilityData.length * 100) / 100
    : null
  const hasDownPercent = availabilityData.some((d) => Number(d.downPercent ?? 0) > 0)

  const availabilitySeries = [
    { key: 'uptime', label: 'Uptime', color: 'var(--wd-success)', icon: 'solar:shield-check-outline', value: avgUptime != null ? `${avgUptime}%` : '\u2014', change: '', changeType: 'neutral' as const },
    { key: 'downPercent', label: 'Downtime', color: 'var(--wd-danger)', icon: 'solar:close-circle-outline', value: avgUptime != null ? `${Math.round((100 - avgUptime) * 100) / 100}%` : '\u2014', change: '', changeType: 'neutral' as const },
    { key: 'incidents', label: 'Incidents', color: 'var(--wd-warning)', icon: 'solar:danger-triangle-outline', value: String(incidentCount), change: '', changeType: 'neutral' as const },
  ]
  const avDefaultHidden = [
    ...(!hasDownPercent ? ['downPercent'] : []),
    ...(incidentCount === 0 ? ['incidents'] : []),
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Overview</h1>
        <div className="flex items-center gap-3">
          <Segmented<TimeRange>
            ariaLabel="Time range"
            options={TIME_RANGES.map((r) => ({ key: r.key, label: r.label }))}
            value={timeRange}
            onChange={setTimeRange}
            mono
          />
        </div>
      </div>

      {/* Data warning */}
      {dataInsufficient && (
        <div className="flex items-center gap-2 rounded-lg border border-wd-warning/30 bg-wd-warning/5 px-3 py-2">
          <Icon icon="solar:info-circle-outline" width={20} className="text-wd-warning shrink-0" />
          <span className="text-xs text-wd-warning">
            Only <span className="font-mono">{humanDuration(dataHours!)}</span> of data available for the selected <span className="font-mono">{selectedRange.label}</span> range
          </span>
        </div>
      )}
      {dataHours === null && !chartLoading && endpoints.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-wd-border/30 bg-wd-surface-hover/30 px-3 py-2">
          <Icon icon="solar:clock-circle-outline" width={20} className="text-wd-muted shrink-0" />
          <span className="text-xs text-wd-muted">
            Waiting for aggregated data &mdash; charts will populate after the first hourly rollup
          </span>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          index={0}
          title="Endpoints"
          value={String(totalEndpoints)}
          changeSegments={[
            { text: `${upCount} up`, color: 'success' },
            ...(statusCounts.degraded > 0 ? [{ text: `${statusCounts.degraded} degraded`, color: 'warning' as const }] : []),
            { text: `${downCount} down`, color: downCount > 0 ? 'danger' : 'success' },
          ]}
          icon="solar:server-square-outline"
          color="primary"
          chartData={[]}
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={1}
          title="Uptime (24h)"
          value={uptimeAvg24h != null ? `${uptimeAvg24h}%` : '\u2014'}
          change={uptimeDelta != null ? `${uptimeDelta > 0 ? '+' : ''}${uptimeDelta}%` : undefined}
          changeColor={uptimeDelta != null ? (uptimeDelta >= 0 ? 'success' : 'danger') : undefined}
          changeLabel={uptimeDelta != null ? 'vs period avg' : undefined}
          trend={uptimeDelta != null ? (uptimeDelta > 0 ? 'up' : uptimeDelta < 0 ? 'down' : 'flat') : undefined}
          icon="solar:shield-check-outline"
          color={
            uptimeAvg24h == null
              ? 'primary'
              : uptimeAvg24h >= 99.9
                ? 'success'
                : uptimeAvg24h >= 99
                  ? 'warning'
                  : 'danger'
          }
          chartData={kpiUptimeData}
          unit="%"
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={2}
          title="Avg Response"
          value={avgResponseTime != null ? `${avgResponseTime}ms` : '\u2014'}
          change={responseDelta != null ? `${responseDelta.pct > 0 ? '+' : ''}${responseDelta.pct}%` : undefined}
          changeColor={responseDelta != null ? (responseDelta.diff <= 0 ? 'success' : responseDelta.diff < 50 ? 'warning' : 'danger') : undefined}
          changeLabel={responseDelta != null ? 'vs prior' : undefined}
          trend={responseDelta != null ? (responseDelta.diff > 5 ? 'up' : responseDelta.diff < -5 ? 'down' : 'flat') : undefined}
          icon="solar:graph-outline"
          color={
            avgResponseTime == null
              ? 'primary'
              : avgResponseTime < 200
                ? 'success'
                : avgResponseTime < 500
                  ? 'warning'
                  : 'danger'
          }
          chartData={kpiResponseData}
          unit="ms"
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={3}
          title="Active Incidents"
          value={String(incidentCount)}
          changeSegments={
            topIncidentEndpoint
              ? [{ text: topIncidentEndpoint, color: 'danger' }]
              : incidentCount === 0
                ? [{ text: 'All clear', color: 'success' }]
                : undefined
          }
          icon="solar:danger-triangle-outline"
          color={incidentCount > 0 ? 'danger' : 'success'}
          chartData={[]}
          onClick={() => navigate('/incidents')}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {chartLoading ? (
          <>
            <div className="border border-wd-border/30 rounded-xl p-8 flex items-center justify-center min-h-[380px]">
              <Spinner size="md" />
            </div>
            <div className="border border-wd-border/30 rounded-xl p-8 flex items-center justify-center min-h-[380px]">
              <Spinner size="md" />
            </div>
          </>
        ) : chartData.length > 0 ? (
          <>
            <OverviewChart
              title="Response Time"
              icon="solar:graph-outline"
              series={responseTimeSeries}
              data={chartData}
              unit="ms"
              defaultHidden={rtDefaultHidden}
              highlightRanges={rtHighlightRanges}
            />
            <OverviewChart
              title="Availability"
              icon="solar:shield-check-outline"
              series={availabilitySeries}
              data={availabilityData}
              defaultHidden={avDefaultHidden}
              highlightRanges={chartHighlightRanges}
            />
          </>
        ) : (
          <>
            <div className="border border-wd-border/30 rounded-xl p-8 flex flex-col items-center justify-center gap-3 min-h-[380px]">
              <Icon icon="solar:graph-outline" width={40} className="text-wd-muted/30" />
              <p className="text-sm font-medium text-wd-muted">Response Time Chart</p>
              <p className="text-xs text-wd-muted/60">
                No data for this time range yet
              </p>
            </div>
            <div className="border border-wd-border/30 rounded-xl p-8 flex flex-col items-center justify-center gap-3 min-h-[380px]">
              <Icon icon="solar:shield-check-outline" width={40} className="text-wd-muted/30" />
              <p className="text-sm font-medium text-wd-muted">Availability Chart</p>
              <p className="text-xs text-wd-muted/60">
                No data for this time range yet
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
