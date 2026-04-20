import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button, Popover, Tooltip, TooltipTrigger, TooltipContent, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useTheme } from '../hooks/useTheme'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import { toast } from '../ui/toast'
import StatusPill from '../components/StatusPill'
import type { ApiNotificationPreferences } from '../types/notifications'

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
  const [globalMuteUntil, setGlobalMuteUntil] = useState<string | null>(null)
  const [clearingMute, setClearingMute] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())

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

  // Fetch global mute on mount + whenever mute events fire
  const fetchGlobalMute = useCallback(async () => {
    try {
      const res = await request<{ data: ApiNotificationPreferences | null }>(
        '/notifications/preferences',
      )
      setGlobalMuteUntil(res.data.data?.globalMuteUntil ?? null)
    } catch {
      // Leave as-is on failure
    }
  }, [request])

  useEffect(() => { fetchGlobalMute() }, [fetchGlobalMute])

  useEffect(() => {
    const offMuted = subscribe('notification:muted', () => fetchGlobalMute())
    const offUnmuted = subscribe('notification:unmuted', () => fetchGlobalMute())
    return () => {
      offMuted()
      offUnmuted()
    }
  }, [subscribe, fetchGlobalMute])

  // Tick once per second while a mute is active so the countdown updates.
  useEffect(() => {
    if (!globalMuteUntil) return
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [globalMuteUntil])

  const muteMsRemaining = useMemo(() => {
    if (!globalMuteUntil) return 0
    return Math.max(0, new Date(globalMuteUntil).getTime() - nowTick)
  }, [globalMuteUntil, nowTick])

  const muteActive = muteMsRemaining > 0

  const clearGlobalMute = useCallback(async () => {
    setClearingMute(true)
    try {
      await request('/notifications/preferences', {
        method: 'PUT',
        body: { globalMuteUntil: null },
      })
      setGlobalMuteUntil(null)
      toast.success('Global Mute Cleared')
    } catch (err) {
      toast.error('Failed to Clear Mute', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setClearingMute(false)
    }
  }, [request])

  const setGlobalMute = useCallback(
    async (seconds: number) => {
      const expiresAt = new Date(Date.now() + seconds * 1000).toISOString()
      setClearingMute(true)
      try {
        const res = await request<{ data: ApiNotificationPreferences }>(
          '/notifications/preferences',
          { method: 'PUT', body: { globalMuteUntil: expiresAt } },
        )
        setGlobalMuteUntil(res.data.data?.globalMuteUntil ?? expiresAt)
        toast.success('Global Mute Enabled', {
          description: `All notifications paused for ${formatMuteRemaining(seconds * 1000)}`,
        })
      } catch (err) {
        toast.error('Failed to Enable Mute', {
          description: err instanceof Error ? err.message : undefined,
        })
      } finally {
        setClearingMute(false)
      }
    },
    [request],
  )

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

  // Only active endpoints count toward the global status pill — paused/archived
  // endpoints may hold a stale lastStatus that would otherwise skew "Degraded".
  const activeEndpoints = useMemo(
    () => endpoints.filter((ep) => ep.status === 'active'),
    [endpoints],
  )

  const statusCounts = useMemo(() => {
    const counts = { healthy: 0, degraded: 0, down: 0 }
    for (const ep of activeEndpoints) {
      if (ep.lastStatus) counts[ep.lastStatus]++
    }
    return counts
  }, [activeEndpoints])

  const activeIds = useMemo(
    () => new Set(activeEndpoints.map((ep) => ep._id)),
    [activeEndpoints],
  )

  const avgLatencyMs = useMemo(() => {
    const values: number[] = []
    for (const [id, ms] of responseTimes) {
      if (activeIds.has(id)) values.push(ms)
    }
    if (values.length === 0) return null
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }, [responseTimes, activeIds])

  const totalCount = activeEndpoints.length
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
                width={20}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isCompact ? 'Expand Sidebar' : 'Collapse Sidebar'}
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
                width={20}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            Search Endpoints
            <kbd className="ml-1.5 rounded border border-wd-border/50 bg-wd-surface-hover/50 px-1 py-0.5 text-[10px] text-wd-muted/60">⌘K</kbd>
          </TooltipContent>
        </Tooltip>

        <GlobalMuteButton
          muteActive={muteActive}
          muteMsRemaining={muteMsRemaining}
          clearing={clearingMute}
          onSetMute={setGlobalMute}
          onClearMute={clearGlobalMute}
        />

        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" onPress={toggleTheme}>
              <Icon
                className="text-wd-muted"
                icon={isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'}
                width={20}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isDark ? 'Light Mode' : 'Dark Mode'}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

function formatMuteRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  return `${seconds}s`
}

const MUTE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '15 min', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '4 hours', seconds: 4 * 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
]

interface GlobalMuteButtonProps {
  muteActive: boolean
  muteMsRemaining: number
  clearing: boolean
  onSetMute: (seconds: number) => Promise<void> | void
  onClearMute: () => Promise<void> | void
}

function GlobalMuteButton({
  muteActive,
  muteMsRemaining,
  clearing,
  onSetMute,
  onClearMute,
}: GlobalMuteButtonProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handlePreset = async (seconds: number) => {
    await onSetMute(seconds)
    setIsOpen(false)
  }

  const handleClear = async () => {
    await onClearMute()
    setIsOpen(false)
  }

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger className="!inline-flex">
        <Tooltip delay={300} closeDelay={0} isDisabled={isOpen}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" className="relative">
              <Icon
                className={cn(muteActive ? 'text-wd-warning' : 'text-wd-muted')}
                icon={muteActive ? 'solar:bell-off-bold' : 'solar:bell-outline'}
                width={20}
              />
              {muteActive && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-wd-warning shadow-[0_0_0_2px_var(--wd-surface)]" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {muteActive ? 'Notifications Muted' : 'Pause Notifications'}
          </TooltipContent>
        </Tooltip>
      </Popover.Trigger>

      <Popover.Content
        placement="bottom end"
        offset={8}
        className="!rounded-xl !border !border-wd-border !bg-wd-surface !shadow-lg"
      >
        <div className="w-[240px] p-3 space-y-3">
          {muteActive ? (
            <>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] font-medium font-mono uppercase tracking-wide text-wd-warning">
                  <Icon icon="solar:bell-off-bold" width={16} />
                  Muted
                </div>
                <div className="text-sm font-medium text-foreground">
                  All notifications paused
                </div>
                <div className="text-xs text-wd-muted font-mono">
                  {formatMuteRemaining(muteMsRemaining)} remaining
                </div>
              </div>

              <div className="border-t border-wd-border/50 pt-2 space-y-1.5">
                <div className="text-[11px] font-medium text-wd-muted">Extend By</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {MUTE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={clearing}
                      onClick={() => void handlePreset(preset.seconds)}
                      className="rounded-md border border-wd-border/60 bg-wd-surface-hover/30 px-2 py-1 text-xs text-foreground transition-colors hover:bg-wd-surface-hover/60 disabled:opacity-60"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                disabled={clearing}
                onClick={() => void handleClear()}
                className="w-full rounded-md bg-wd-warning/15 px-2 py-1.5 text-xs font-medium text-wd-warning transition-colors hover:bg-wd-warning/25 disabled:opacity-60"
              >
                Unmute Now
              </button>
            </>
          ) : (
            <>
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-foreground">
                  Pause All Notifications
                </div>
                <div className="text-xs text-wd-muted">
                  Silence every channel globally for a limited time.
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {MUTE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={clearing}
                    onClick={() => void handlePreset(preset.seconds)}
                    className="rounded-md border border-wd-border/60 bg-wd-surface-hover/30 px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-wd-surface-hover/60 disabled:opacity-60"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
