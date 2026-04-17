import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button, Tooltip, TooltipTrigger, TooltipContent } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useTheme } from '../hooks/useTheme'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import StatusPill from '../components/StatusPill'

// ---------------------------------------------------------------------------
// API types (minimal — only what we need)
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

interface ApiIncident {
  _id: string
  endpointId: string
  cause: string
  causeDetail?: string
  startedAt: string
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

interface TopBarProps {
  isCompact: boolean
  onToggleSidebar: () => void
}

export default function TopBar({ isCompact, onToggleSidebar }: TopBarProps) {
  const { isDark, toggleTheme } = useTheme()
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [activeIncidents, setActiveIncidents] = useState(0)
  const [topIncident, setTopIncident] = useState<ApiIncident | null>(null)
  const [responseTimes, setResponseTimes] = useState<Map<string, number>>(new Map())
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null)

  // Fetch on mount
  const fetchData = useCallback(async () => {
    try {
      const [epRes, incRes] = await Promise.all([
        request<{ data: ApiEndpoint[]; pagination: ApiPagination }>('/endpoints?limit=100'),
        request<{ data: ApiIncident[]; pagination: ApiPagination }>('/incidents?status=active&limit=1'),
      ])
      setEndpoints(epRes.data.data)
      setActiveIncidents(incRes.data.pagination?.total ?? 0)
      if (incRes.data.data.length > 0) {
        setTopIncident(incRes.data.data[0]!)
      }
    } catch {
      // Leave as defaults on failure
    }
  }, [request])

  useEffect(() => { fetchData() }, [fetchData])

  // SSE: check:complete
  useEffect(() => {
    return subscribe('check:complete', (raw) => {
      const evt = raw as { endpointId: string; status: string; responseTime: number; timestamp: string }
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
      setLastUpdateAt(new Date(evt.timestamp))
    })
  }, [subscribe])

  // SSE: endpoint changes
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

  // SSE: incident changes
  useEffect(() => {
    return subscribe('incident:opened', (raw) => {
      const evt = raw as { incident: ApiIncident }
      setActiveIncidents((prev) => prev + 1)
      setTopIncident(evt.incident)
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', () => {
      setActiveIncidents((prev) => Math.max(0, prev - 1))
      setTopIncident(null)
    })
  }, [subscribe])

  // Computed
  const statusCounts = useMemo(() => {
    const counts = { healthy: 0, degraded: 0, down: 0 }
    for (const ep of endpoints) {
      if (ep.lastStatus) counts[ep.lastStatus]++
    }
    return counts
  }, [endpoints])

  const avgLatencyMs = useMemo(() => {
    if (responseTimes.size === 0) return null
    const values = [...responseTimes.values()]
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }, [responseTimes])

  const totalCount = endpoints.length
  const healthyCount = statusCounts.healthy + statusCounts.degraded

  const lastUpdatedLabel = lastUpdateAt
    ? `Updated ${Math.max(0, Math.floor((Date.now() - lastUpdateAt.getTime()) / 1000))}s ago`
    : undefined

  const activeIncident = topIncident
    ? {
        name: topIncident.cause,
        detail: topIncident.causeDetail ?? '',
        duration: (() => {
          const s = Math.floor((Date.now() - new Date(topIncident.startedAt).getTime()) / 1000)
          if (s < 60) return `${s}s`
          const m = Math.floor(s / 60)
          if (m < 60) return `${m}m`
          return `${Math.floor(m / 60)}h ${m % 60}m`
        })(),
      }
    : undefined

  return (
    <header className="h-14 border-b border-wd-border bg-surface flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" onPress={onToggleSidebar}>
              <Icon
                className="text-wd-muted"
                icon="solar:sidebar-minimalistic-outline"
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isCompact ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Global status pill */}
      <StatusPill
        healthyCount={healthyCount}
        totalCount={totalCount}
        avgLatencyMs={avgLatencyMs}
        incidentCount={activeIncidents}
        activeIncident={activeIncident}
        lastUpdated={lastUpdatedLabel}
      />

      <div className="flex items-center gap-1">
        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost">
              <Icon
                className="text-wd-muted"
                icon="solar:magnifer-outline"
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            Search endpoints
            <kbd className="ml-1.5 rounded border border-wd-border/50 bg-wd-surface-hover/50 px-1 py-0.5 text-[10px] text-wd-muted/60">⌘K</kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" onPress={toggleTheme}>
              <Icon
                className="text-wd-muted"
                icon={isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'}
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isDark ? 'Light mode' : 'Dark mode'}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
