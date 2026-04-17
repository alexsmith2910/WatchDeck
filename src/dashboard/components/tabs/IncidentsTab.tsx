import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Spinner, Separator, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../../hooks/useApi'
import { useSSE } from '../../hooks/useSSE'
import type { ApiIncident, ApiPagination } from '../../types/api'
import { formatDateTime, formatDuration, timeAgo, statusColors } from '../../utils/format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IncidentsTabProps {
  endpointId: string
  initialExpandedId?: string | null
}

// ---------------------------------------------------------------------------
// IncidentsTab
// ---------------------------------------------------------------------------

export default function IncidentsTab({ endpointId, initialExpandedId }: IncidentsTabProps) {
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [activeIncident, setActiveIncident] = useState<ApiIncident | null>(null)
  const [incidents, setIncidents] = useState<ApiIncident[]>([])
  const [pagination, setPagination] = useState<ApiPagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null)
  const [runtimeTick, setRuntimeTick] = useState(0)
  const expandedRef = useRef<HTMLDivElement>(null)

  // Sync expandedId when parent changes initialExpandedId (e.g. clicking an incident on overview tab)
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

  // Tick every second for active incident duration
  useEffect(() => {
    const interval = setInterval(() => setRuntimeTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Fetch incidents
  const fetchIncidents = useCallback(
    async (cursor?: string) => {
      if (!cursor) setLoading(true)
      else setLoadingMore(true)

      // Fetch active incident
      if (!cursor) {
        const activeRes = await request<{ data: ApiIncident[] }>(
          `/incidents?endpointId=${endpointId}&status=active&limit=1`,
        )
        if (activeRes.status < 400) {
          const actives = activeRes.data.data ?? []
          setActiveIncident(actives.length > 0 ? actives[0] : null)
        }
      }

      // Fetch history (all incidents, most recent first)
      let url = `/incidents?endpointId=${endpointId}&limit=20`
      if (cursor) url += `&cursor=${cursor}`

      const res = await request<{ data: ApiIncident[]; pagination: ApiPagination }>(url)
      if (res.status < 400) {
        const items = res.data.data ?? []
        if (cursor) setIncidents((prev) => [...prev, ...items])
        else setIncidents(items)
        setPagination(res.data.pagination ?? null)
      }

      setLoading(false)
      setLoadingMore(false)
    },
    [endpointId, request],
  )

  useEffect(() => {
    fetchIncidents()
  }, [fetchIncidents])

  // SSE: real-time incident updates
  useEffect(() => {
    const unsubOpen = subscribe('incident:opened', (data: unknown) => {
      const payload = data as { endpointId: string; incidentId: string; cause: string; startedAt: string }
      if (payload.endpointId !== endpointId) return
      const newInc: ApiIncident = {
        _id: payload.incidentId,
        endpointId: payload.endpointId,
        status: 'active',
        cause: payload.cause,
        startedAt: payload.startedAt,
        notificationsSent: 0,
      }
      setActiveIncident(newInc)
      setIncidents((prev) => [newInc, ...prev])
    })

    const unsubResolve = subscribe('incident:resolved', (data: unknown) => {
      const payload = data as { endpointId: string; incidentId: string; durationSeconds: number; resolvedAt: string }
      if (payload.endpointId !== endpointId) return
      setActiveIncident(null)
      setIncidents((prev) =>
        prev.map((inc) =>
          inc._id === payload.incidentId
            ? { ...inc, status: 'resolved' as const, resolvedAt: payload.resolvedAt, durationSeconds: payload.durationSeconds }
            : inc,
        ),
      )
    })

    return () => {
      unsubOpen()
      unsubResolve()
    }
  }, [endpointId, subscribe])

  // Active incident duration
  const activeDuration = activeIncident
    ? (() => {
        void runtimeTick
        return Math.floor((Date.now() - new Date(activeIncident.startedAt).getTime()) / 1000)
      })()
    : 0

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner size="md" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── Active Incident Banner ────────────────────────────────── */}
      {activeIncident ? (
        <div className="bg-wd-danger/5 border border-wd-danger/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="relative flex items-center justify-center mt-0.5">
              <span className="h-3 w-3 rounded-full bg-wd-danger" />
              <span className="absolute h-3 w-3 rounded-full bg-wd-danger animate-ping opacity-40" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-semibold text-wd-danger">Active Incident</h3>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-wd-danger/10 text-wd-danger">
                  Ongoing
                </span>
              </div>
              <p className="text-xs font-medium text-foreground">
                {activeIncident.cause}
                {activeIncident.causeDetail && (
                  <span className="text-wd-muted font-normal"> — {activeIncident.causeDetail}</span>
                )}
              </p>
              <div className="flex items-center gap-4 mt-2 text-[11px] text-wd-muted">
                <span>
                  <Icon icon="solar:clock-circle-linear" width={12} className="inline mr-1" />
                  Started {timeAgo(activeIncident.startedAt)}
                </span>
                <span>
                  <Icon icon="solar:stopwatch-linear" width={12} className="inline mr-1" />
                  Duration: {formatDuration(activeDuration)}
                </span>
                <span>
                  <Icon icon="solar:bell-linear" width={12} className="inline mr-1" />
                  {activeIncident.notificationsSent} notification{activeIncident.notificationsSent !== 1 ? 's' : ''} sent
                </span>
                {activeIncident.acknowledgedAt && (
                  <span>
                    <Icon icon="solar:check-read-linear" width={12} className="inline mr-1" />
                    Acknowledged by {activeIncident.acknowledgedBy ?? 'someone'} {timeAgo(activeIncident.acknowledgedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-wd-success/5 border border-wd-success/20 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-wd-success/10 p-2">
              <Icon icon="solar:shield-check-bold" width={20} className="text-wd-success" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-wd-success">All Clear</h3>
              <p className="text-xs text-wd-muted">No active incidents for this endpoint</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Incident History ──────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Icon icon="solar:history-linear" width={14} className="text-wd-muted" />
          <h3 className="text-sm font-semibold text-foreground">Incident History</h3>
          <span className="text-[10px] text-wd-muted">
            ({pagination?.total ?? incidents.length} total)
          </span>
        </div>

        {incidents.length === 0 ? (
          <div className="text-center py-8 text-wd-muted">
            <Icon icon="solar:shield-check-linear" width={36} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">No incidents recorded</p>
            <p className="text-xs text-wd-muted/60 mt-1">This endpoint has been running clean</p>
          </div>
        ) : (
          <div className="bg-wd-surface border border-wd-border/50 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[32px_80px_1fr_120px_100px_80px] gap-2 px-4 py-2.5 border-b border-wd-border/50 bg-wd-surface-hover/30">
              <span />
              <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">Status</span>
              <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">Cause</span>
              <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">Started</span>
              <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider text-right">Duration</span>
              <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider text-right">Alerts</span>
            </div>

            {/* Rows */}
            {incidents.map((inc) => {
              const isExpanded = expandedId === inc._id
              const isActive = inc.status === 'active'

              return (
                <div key={inc._id} ref={isExpanded ? expandedRef : undefined}>
                  <button
                    type="button"
                    onClick={() => toggleExpand(inc._id)}
                    className={cn(
                      'w-full grid grid-cols-[32px_80px_1fr_120px_100px_80px] gap-2 px-4 py-2.5 text-left transition-colors cursor-pointer',
                      'hover:bg-wd-surface-hover/50',
                      isExpanded && 'bg-wd-surface-hover/30',
                    )}
                  >
                    {/* Arrow */}
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

                    {/* Status */}
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full shrink-0',
                          isActive ? 'bg-wd-danger animate-pulse' : 'bg-wd-muted',
                        )}
                      />
                      <span
                        className={cn(
                          'text-xs font-medium',
                          isActive ? 'text-wd-danger' : 'text-wd-muted',
                        )}
                      >
                        {isActive ? 'Active' : 'Resolved'}
                      </span>
                    </div>

                    {/* Cause */}
                    <div className="min-w-0">
                      <span className="text-xs font-medium text-foreground truncate block">
                        {inc.cause}
                      </span>
                      {inc.causeDetail && (
                        <span className="text-[10px] text-wd-muted truncate block">{inc.causeDetail}</span>
                      )}
                    </div>

                    {/* Started */}
                    <span className="text-xs text-wd-muted">{timeAgo(inc.startedAt)}</span>

                    {/* Duration */}
                    <span className="text-xs text-foreground text-right">
                      {isActive
                        ? formatDuration(Math.floor((Date.now() - new Date(inc.startedAt).getTime()) / 1000))
                        : inc.durationSeconds
                          ? formatDuration(inc.durationSeconds)
                          : '—'}
                    </span>

                    {/* Notifications */}
                    <span className="text-xs text-wd-muted text-right">{inc.notificationsSent}</span>
                  </button>

                  {/* Expanded: Timeline */}
                  {isExpanded && (
                    <div className="border-t border-wd-border/30 bg-wd-surface-hover/20 px-4 py-4 pl-12">
                      {/* Incident details */}
                      <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-8 gap-y-3 mb-4">
                        <div>
                          <span className="text-[10px] text-wd-muted uppercase tracking-wider block">Started</span>
                          <span className="text-xs font-medium text-foreground">{formatDateTime(inc.startedAt)}</span>
                        </div>
                        {inc.resolvedAt && (
                          <div>
                            <span className="text-[10px] text-wd-muted uppercase tracking-wider block">Resolved</span>
                            <span className="text-xs font-medium text-foreground">{formatDateTime(inc.resolvedAt)}</span>
                          </div>
                        )}
                        {inc.durationSeconds != null && (
                          <div>
                            <span className="text-[10px] text-wd-muted uppercase tracking-wider block">Duration</span>
                            <span className="text-xs font-medium text-foreground">{formatDuration(inc.durationSeconds)}</span>
                          </div>
                        )}
                        <div>
                          <span className="text-[10px] text-wd-muted uppercase tracking-wider block">Notifications</span>
                          <span className="text-xs font-medium text-foreground">{inc.notificationsSent}</span>
                        </div>
                        {inc.acknowledgedAt && (
                          <div>
                            <span className="text-[10px] text-wd-muted uppercase tracking-wider block">Acknowledged</span>
                            <span className="text-xs font-medium text-foreground">
                              {inc.acknowledgedBy ?? 'Someone'} — {formatDateTime(inc.acknowledgedAt)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Timeline */}
                      {inc.timeline && inc.timeline.length > 0 && (
                        <>
                          <Separator className="!bg-wd-border/30 mb-3" />
                          <div className="flex items-center gap-2 mb-3">
                            <Icon icon="solar:timeline-up-linear" width={13} className="text-wd-muted" />
                            <span className="text-[11px] font-medium text-wd-muted uppercase tracking-wider">
                              Timeline
                            </span>
                          </div>
                          <div className="relative pl-4">
                            {/* Vertical line */}
                            <div className="absolute left-[7px] top-1 bottom-1 w-px bg-wd-border/50" />

                            <div className="space-y-3">
                              {inc.timeline.map((evt, i) => {
                                const evtColor = getTimelineEventColor(evt.event)
                                return (
                                  <div key={i} className="relative flex gap-3">
                                    {/* Dot */}
                                    <span
                                      className={cn(
                                        'absolute -left-[9.5px] top-0.5 h-2.5 w-2.5 rounded-full border-2 border-wd-surface z-10',
                                        evtColor,
                                      )}
                                    />
                                    <div className="ml-3 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-medium text-foreground">
                                          {formatTimelineEvent(evt.event)}
                                        </span>
                                        <span className="text-[10px] text-wd-muted">
                                          {new Date(evt.at).toLocaleTimeString(undefined, {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                          })}
                                        </span>
                                      </div>
                                      {evt.detail && (
                                        <p className="text-[11px] text-wd-muted mt-0.5">{evt.detail}</p>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Load More ─────────────────────────────────────────────── */}
      {pagination?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="bordered"
            className="!text-xs"
            onPress={() => {
              if (pagination.nextCursor) fetchIncidents(pagination.nextCursor)
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
                Load More
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTimelineEventColor(event: string): string {
  if (event.includes('opened')) return 'bg-wd-danger'
  if (event.includes('resolved')) return 'bg-wd-success'
  if (event.includes('notification')) return 'bg-wd-warning'
  if (event.includes('escalat')) return 'bg-wd-warning'
  if (event.includes('acknowledged')) return 'bg-wd-primary'
  return 'bg-wd-muted'
}

function formatTimelineEvent(event: string): string {
  return event
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
