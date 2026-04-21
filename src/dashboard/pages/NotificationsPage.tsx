/**
 * NotificationsPage — delivery health, channel grid, suppression breakdown,
 * on-call routing, and the delivery log.
 *
 * Layout:
 *   1. Page header (title + Add-channel button)
 *   2. Overall delivery banner
 *   3. KPI row (dispatched · success · latency · queued)
 *   4. Charts row: dispatch-by-channel + latency p50/p95
 *   5. Channels grid (cards)
 *   6. Suppression panel (donut + breakdown)
 *   7. On-call routing: escalations + mutes side by side
 *   8. Delivery log with filters
 *
 * Data loading fires in parallel. SSE bumps a `refreshKey` that makes the log
 * re-fetch, and re-pulls the stats/channels/mutes/escalations endpoints.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import { Segmented } from '../components/endpoint-detail/primitives'
import { NotificationKpis } from '../components/notifications/NotificationKpis'
import { DeliveryBanner } from '../components/notifications/DeliveryBanner'
import { ChannelsGrid } from '../components/notifications/ChannelsGrid'
import { SuppressionPanel } from '../components/notifications/SuppressionPanel'
import { EscalationsCard } from '../components/notifications/EscalationsCard'
import { MutesCard } from '../components/notifications/MutesCard'
import { DeliveryLog, type LogFilters } from '../components/notifications/DeliveryLog'
import { LogDetailDrawer } from '../components/notifications/LogDetailDrawer'
import { DispatchChart, LatencyChart } from '../components/notifications/NotificationCharts'
import { ChannelEditModal } from '../components/notifications/ChannelEditModal'
import {
  bucketLog,
  deriveChannelStatus,
  deriveOverallState,
  statsByChannel,
} from '../components/notifications/notificationHelpers'
import type {
  ApiChannel,
  ApiNotificationLogRow,
  ApiNotificationMute,
  ApiNotificationPreferences,
  ApiNotificationStats,
  ApiScheduledEscalation,
} from '../types/notifications'
import type { ApiEndpoint } from '../types/api'

type TimeRange = '1h' | '24h' | '7d' | '30d'
const TIME_RANGES: { key: TimeRange; label: string }[] = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
]
const RANGE_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}
const RANGE_BUCKETS: Record<TimeRange, number> = {
  '1h': 30,
  '24h': 24,
  '7d': 28,
  '30d': 30,
}

function formatUpdatedAgo(sec: number): string {
  if (sec < 2) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

export default function NotificationsPage() {
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [channels, setChannels] = useState<ApiChannel[]>([])
  const [stats, setStats] = useState<ApiNotificationStats | null>(null)
  const [recentLog, setRecentLog] = useState<ApiNotificationLogRow[]>([])
  const [mutes, setMutes] = useState<ApiNotificationMute[]>([])
  const [prefs, setPrefs] = useState<ApiNotificationPreferences | null>(null)
  const [escalations, setEscalations] = useState<ApiScheduledEscalation[]>([])
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([])
  const [filters, setFilters] = useState<LogFilters>(() => ({
    from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
  }))
  const [openRow, setOpenRow] = useState<ApiNotificationLogRow | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [addChannelOpen, setAddChannelOpen] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(() => Date.now())
  const [, setNow] = useState<number>(() => Date.now())

  const endpointNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of endpoints) m.set(e._id, e.name)
    return m
  }, [endpoints])

  // ── Loaders ─────────────────────────────────────────────────────────────
  const loadChannels = useCallback(async () => {
    const res = await request<{ data: ApiChannel[] }>('/notifications/channels')
    setChannels(res.data?.data ?? [])
  }, [request])

  const loadStats = useCallback(async () => {
    const res = await request<{ data: ApiNotificationStats }>('/notifications/stats')
    setStats(res.data?.data ?? null)
    setLastUpdatedAt(Date.now())
  }, [request])

  const loadRecentLog = useCallback(async () => {
    // The log endpoint caps limit at 100. We pull the full page for richer
    // charts and per-channel sparklines. That's sufficient for small-team
    // dispatch volumes — if a user overflows the window, charts degrade
    // gracefully (fewer buckets have data), they don't lie.
    const res = await request<{ data: ApiNotificationLogRow[] }>('/notifications/log?limit=100')
    setRecentLog(res.data?.data ?? [])
  }, [request])

  const loadMutes = useCallback(async () => {
    const res = await request<{ data: ApiNotificationMute[] }>('/notifications/mutes')
    setMutes(res.data?.data ?? [])
  }, [request])

  const loadPrefs = useCallback(async () => {
    const res = await request<{ data: ApiNotificationPreferences }>('/notifications/preferences')
    setPrefs(res.data?.data ?? null)
  }, [request])

  const loadEscalations = useCallback(async () => {
    const res = await request<{ data: ApiScheduledEscalation[] }>('/notifications/escalations')
    setEscalations(res.data?.data ?? [])
  }, [request])

  const loadEndpoints = useCallback(async () => {
    const res = await request<{ data: ApiEndpoint[] }>('/endpoints?limit=200')
    setEndpoints(res.data?.data ?? [])
  }, [request])

  useEffect(() => {
    void Promise.all([
      loadChannels(),
      loadStats(),
      loadRecentLog(),
      loadMutes(),
      loadPrefs(),
      loadEscalations(),
      loadEndpoints(),
    ])
  }, [loadChannels, loadStats, loadRecentLog, loadMutes, loadPrefs, loadEscalations, loadEndpoints])

  // Banner "Updated Xs ago" needs to tick even when nothing updates state.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // ── SSE ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const bumpLog = () => {
      setRefreshKey((k) => k + 1)
      void loadStats()
      void loadRecentLog()
    }
    const bumpChannels = () => void loadChannels()
    const bumpMutes = () => void loadMutes()
    const bumpEsc = () => void loadEscalations()

    const offs = [
      subscribe('notification:dispatched', bumpLog),
      subscribe('notification:failed', bumpLog),
      subscribe('notification:suppressed', bumpLog),
      subscribe('notification:channelCreated', bumpChannels),
      subscribe('notification:channelUpdated', bumpChannels),
      subscribe('notification:channelDeleted', bumpChannels),
      subscribe('notification:muted', bumpMutes),
      subscribe('notification:unmuted', bumpMutes),
      subscribe('notification:escalationScheduled', bumpEsc),
      subscribe('notification:escalationCancelled', bumpEsc),
      subscribe('notification:escalationFired', bumpEsc),
    ]
    return () => { for (const off of offs) off() }
  }, [subscribe, loadStats, loadRecentLog, loadChannels, loadMutes, loadEscalations])

  const handleFilterChange = useCallback((patch: Partial<LogFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
  }, [])

  // ── Derived data ───────────────────────────────────────────────────────
  const byChannelStats = useMemo(() => statsByChannel(stats), [stats])
  const overallState = useMemo(
    () => deriveOverallState(channels, stats, byChannelStats),
    [channels, stats, byChannelStats],
  )
  const healthyChannels = useMemo(
    () => channels.filter((c) => c.enabled && deriveChannelStatus(c, byChannelStats.get(c._id)) === 'healthy').length,
    [channels, byChannelStats],
  )
  const chartBuckets = useMemo(
    () => bucketLog(recentLog, RANGE_MS[timeRange], RANGE_BUCKETS[timeRange]),
    [recentLog, timeRange],
  )

  const lastUpdatedLabel = formatUpdatedAgo(Math.round((Date.now() - lastUpdatedAt) / 1000))

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 min-w-0 max-w-[1440px] mx-auto">
      {/* Header */}
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Notifications</h1>
          <p className="text-xs text-wd-muted mt-1">
            Delivery health, routing rules, and a full audit trail of every alert.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Segmented<TimeRange>
            ariaLabel="Time range"
            options={TIME_RANGES}
            value={timeRange}
            onChange={setTimeRange}
            mono
          />
          <Button
            size="sm"
            variant="outline"
            onPress={() => setAddChannelOpen(true)}
          >
            <Icon icon="solar:add-circle-outline" width={16} />
            Add Channel
          </Button>
        </div>
      </header>

      {/* Banner */}
      <DeliveryBanner
        state={overallState}
        stats={stats}
        channels={channels}
        healthyChannels={healthyChannels}
        lastUpdatedLabel={lastUpdatedLabel}
      />

      {/* KPIs */}
      <NotificationKpis
        stats={stats}
        channels={channels}
        recentLog={recentLog}
        escalations={escalations}
      />

      {/* Charts */}
      <SectionHead
        title="Throughput & latency"
        hint={`Last ${timeRange} of dispatch volume and delivery times`}
      />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 min-w-0">
        <DispatchChart data={chartBuckets} />
        <LatencyChart data={chartBuckets} />
      </div>

      {/* Channels */}
      <SectionHead
        title={`Channels · ${channels.length} configured`}
        hint={channels.length === 0
          ? 'Add a Slack, Discord, email, or webhook destination'
          : `${channels.filter((c) => c.enabled).length} active · ${channels.filter((c) => !c.enabled).length} paused`}
      />
      <ChannelsGrid
        channels={channels}
        stats={stats}
        recentLog={recentLog}
        onChanged={() => {
          void loadChannels()
          void loadStats()
        }}
        onFilterByChannel={(channelId) => handleFilterChange({ channelId })}
      />

      {/* Suppression */}
      <SectionHead
        title="Why notifications didn't fire"
        hint="Rules that silenced alerts over the last 24 hours"
      />
      <SuppressionPanel
        stats={stats}
        onFilterReason={(reason) =>
          handleFilterChange({ status: 'suppressed', suppressedReason: reason })
        }
      />

      {/* Routing row */}
      <SectionHead
        title="On-call routing"
        hint={`${escalations.length} ${escalations.length === 1 ? 'escalation' : 'escalations'} pending · ${mutes.length} active ${mutes.length === 1 ? 'mute' : 'mutes'}`}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-w-0">
        <EscalationsCard
          escalations={escalations}
          channels={channels}
          endpointNameById={endpointNameById}
        />
        <MutesCard
          mutes={mutes}
          channels={channels}
          endpointNameById={endpointNameById}
          onChanged={() => void loadMutes()}
        />
      </div>

      {/* Delivery log */}
      <SectionHead
        title="Delivery log"
        hint="Every dispatch with retries, failures, and payloads"
      />
      <DeliveryLog
        channels={channels}
        filters={filters}
        onFilterChange={handleFilterChange}
        onOpenRow={setOpenRow}
        refreshKey={refreshKey}
        endpointNameById={endpointNameById}
      />

      <LogDetailDrawer
        row={openRow}
        onClose={() => setOpenRow(null)}
        channels={channels}
        endpointNameById={endpointNameById}
        onRetried={() => {
          setRefreshKey((k) => k + 1)
          void loadStats()
          void loadRecentLog()
        }}
      />

      <ChannelEditModal
        open={addChannelOpen}
        channel={null}
        onClose={() => setAddChannelOpen(false)}
        onSaved={() => { void loadChannels(); void loadStats(); setAddChannelOpen(false) }}
        onDeleted={() => { void loadChannels(); setAddChannelOpen(false) }}
      />

      <div className="h-6" />

      {/* quiet hours hint at the bottom if configured */}
      {prefs?.globalQuietHours && (
        <div className="sr-only">
          Quiet hours configured: {prefs.globalQuietHours.start} – {prefs.globalQuietHours.end} ({prefs.globalQuietHours.tz})
        </div>
      )}
    </div>
  )
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2">
      <h2 className="text-[13px] font-semibold text-foreground uppercase tracking-wider">{title}</h2>
      {hint && <span className="text-[11px] text-wd-muted">{hint}</span>}
    </div>
  )
}
