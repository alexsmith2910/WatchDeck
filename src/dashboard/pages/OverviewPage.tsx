import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Spinner } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import KpiCard from '../components/KpiCard'

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface ApiEndpoint {
  _id: string
  lastStatus?: 'healthy' | 'degraded' | 'down'
  enabled: boolean
  status: 'active' | 'paused' | 'archived'
}

interface ApiPagination {
  total: number
}

// ---------------------------------------------------------------------------
// OverviewPage
// ---------------------------------------------------------------------------

export default function OverviewPage() {
  const navigate = useNavigate()
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [activeIncidents, setActiveIncidents] = useState(0)
  const [loading, setLoading] = useState(true)

  // Track latest response times from SSE for a live average
  const [responseTimes, setResponseTimes] = useState<Map<string, number>>(new Map())

  // Fetch data on mount
  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [epRes, incRes] = await Promise.all([
        request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=100'),
        request<{ data: unknown[]; pagination: ApiPagination }>('/incidents?status=active&limit=1'),
      ])
      setEndpoints(epRes.data.data)
      setActiveIncidents(incRes.data.pagination?.total ?? 0)
    } catch {
      // Leave as empty/zero on failure
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // SSE: track live check results
  useEffect(() => {
    return subscribe('check:complete', (raw) => {
      const evt = raw as { endpointId: string; status: string; responseTime: number }
      // Update endpoint status in local state
      setEndpoints((prev) =>
        prev.map((ep) =>
          ep._id === evt.endpointId
            ? { ...ep, lastStatus: evt.status as ApiEndpoint['lastStatus'] }
            : ep,
        ),
      )
      // Track response time
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
    return subscribe('incident:opened', () => {
      setActiveIncidents((prev) => prev + 1)
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', () => {
      setActiveIncidents((prev) => Math.max(0, prev - 1))
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

  const totalEndpoints = endpoints.length
  const upCount = statusCounts.healthy + statusCounts.degraded
  const downCount = statusCounts.down

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Overview</h1>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          index={0}
          title="Endpoints"
          value={String(totalEndpoints)}
          changeSegments={[
            { text: `${upCount} up`, color: 'success' },
            { text: '\u00B7', color: 'primary' },
            { text: `${downCount} down`, color: downCount > 0 ? 'danger' : 'success' },
          ]}
          icon="solar:server-square-outline"
          color="primary"
          chartData={[]}
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={1}
          title="Healthy"
          value={`${statusCounts.healthy}/${totalEndpoints}`}
          changeSegments={
            statusCounts.degraded > 0
              ? [{ text: `${statusCounts.degraded} degraded`, color: 'warning' }]
              : undefined
          }
          icon="solar:check-circle-outline"
          color="success"
          chartData={[]}
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={2}
          title="Avg Response"
          value={avgResponseTime != null ? `${avgResponseTime}ms` : '\u2014'}
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
          chartData={[]}
          onClick={() => navigate('/endpoints')}
        />
        <KpiCard
          index={3}
          title="Active Incidents"
          value={String(activeIncidents)}
          icon="solar:danger-triangle-outline"
          color={activeIncidents > 0 ? 'danger' : 'success'}
          chartData={[]}
          onClick={() => navigate('/incidents')}
        />
      </div>

      {/* Charts placeholder */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="border border-wd-border/30 rounded-xl p-8 flex flex-col items-center justify-center gap-3 min-h-[300px]">
          <Icon icon="solar:graph-outline" width={40} className="text-wd-muted/30" />
          <p className="text-sm font-medium text-wd-muted">Response Time Chart</p>
          <p className="text-xs text-wd-muted/60">
            Historical data will appear here once aggregation is running
          </p>
        </div>
        <div className="border border-wd-border/30 rounded-xl p-8 flex flex-col items-center justify-center gap-3 min-h-[300px]">
          <Icon icon="solar:shield-check-outline" width={40} className="text-wd-muted/30" />
          <p className="text-sm font-medium text-wd-muted">Availability Chart</p>
          <p className="text-xs text-wd-muted/60">
            Historical data will appear here once aggregation is running
          </p>
        </div>
      </div>
    </div>
  )
}
