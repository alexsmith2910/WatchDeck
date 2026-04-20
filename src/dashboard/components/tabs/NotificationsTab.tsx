/**
 * EndpointDetailPage → Notifications tab (§7).
 *
 * Scope of this tab is the *notification plane* for a single endpoint:
 *   - Header: linked channels, mute status, last dispatch summary
 *   - Stats: 24h sent / failed / last open / last resolved
 *   - Timeline: recent deliveries grouped by incident
 *   - Suppressions: last 24h suppressed dispatches, grouped by reason
 *   - Footer: settings quick link (jump to the Settings tab)
 *
 * Live updates: SSE bumps refresh the log + stats without full refetches of
 * endpoint config. Muting this endpoint uses `/endpoints/:id/notifications/mute`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Spinner } from '@heroui/react'
import { Icon } from '@iconify/react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi'
import { useSSE } from '../../hooks/useSSE'
import { toast } from '../../ui/toast'
import { timeAgo } from '../../utils/format'
import type { ApiEndpoint } from '../../types/api'
import type {
  ApiChannel,
  ApiNotificationLogRow,
  ApiNotificationMute,
} from '../../types/notifications'
import {
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
  KIND_LABEL,
  SEVERITY_STYLE,
  STATUS_STYLE,
} from '../../types/notifications'
import { LogDetailDrawer } from '../notifications/LogDetailDrawer'

interface Props {
  endpoint: ApiEndpoint
  onJumpToSettings: () => void
}

interface EndpointStats {
  total: number
  sent: number
  failed: number
  suppressed: number
  lastDispatchAt: string | null
  lastFailureAt: string | null
  endpointTotal: number
}

const MUTE_PRESETS: Array<{ id: string; label: string; seconds: number | null }> = [
  { id: '15m', label: '15 minutes', seconds: 15 * 60 },
  { id: '1h', label: '1 hour', seconds: 60 * 60 },
  { id: '4h', label: '4 hours', seconds: 4 * 60 * 60 },
  { id: 'resolve', label: 'Until Resolved', seconds: null },
]

export default function NotificationsTab({ endpoint, onJumpToSettings }: Props) {
  const { request } = useApi()
  const { subscribe } = useSSE()

  const [channels, setChannels] = useState<ApiChannel[]>([])
  const [log, setLog] = useState<ApiNotificationLogRow[]>([])
  const [stats, setStats] = useState<EndpointStats | null>(null)
  const [mutes, setMutes] = useState<ApiNotificationMute[]>([])
  const [loading, setLoading] = useState(true)
  const [openRow, setOpenRow] = useState<ApiNotificationLogRow | null>(null)
  const [showMuteModal, setShowMuteModal] = useState(false)

  const endpointId = endpoint._id

  // ── Loaders ────────────────────────────────────────────────────────────
  const loadChannels = useCallback(async () => {
    const res = await request<{ data: ApiChannel[] }>('/notifications/channels')
    setChannels(res.data?.data ?? [])
  }, [request])

  const loadLog = useCallback(async () => {
    const res = await request<{ data: ApiNotificationLogRow[] }>(
      `/endpoints/${endpointId}/notifications/log?limit=100`,
    )
    setLog(res.data?.data ?? [])
  }, [endpointId, request])

  const loadStats = useCallback(async () => {
    const res = await request<{ data: EndpointStats }>(
      `/endpoints/${endpointId}/notifications/stats`,
    )
    setStats(res.data?.data ?? null)
  }, [endpointId, request])

  const loadMutes = useCallback(async () => {
    const res = await request<{ data: ApiNotificationMute[] }>('/notifications/mutes')
    setMutes(res.data?.data ?? [])
  }, [request])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([loadChannels(), loadLog(), loadStats(), loadMutes()]).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [loadChannels, loadLog, loadStats, loadMutes])

  // ── SSE wiring ─────────────────────────────────────────────────────────
  useEffect(() => {
    const bumpLog = () => { void loadLog(); void loadStats() }
    const bumpMutes = () => { void loadMutes() }
    const offs = [
      subscribe('notification:dispatched', bumpLog),
      subscribe('notification:failed', bumpLog),
      subscribe('notification:suppressed', bumpLog),
      subscribe('notification:muted', bumpMutes),
      subscribe('notification:unmuted', bumpMutes),
    ]
    return () => { for (const off of offs) off() }
  }, [subscribe, loadLog, loadStats, loadMutes])

  // ── Derived ────────────────────────────────────────────────────────────
  const linkedChannels = useMemo(() => {
    const set = new Set(endpoint.notificationChannelIds)
    return channels.filter((c) => set.has(c._id))
  }, [channels, endpoint.notificationChannelIds])

  const activeEndpointMute = useMemo(() => {
    const now = Date.now()
    return mutes.find(
      (m) =>
        m.scope === 'endpoint' &&
        m.targetId === endpointId &&
        new Date(m.expiresAt).getTime() > now,
    )
  }, [mutes, endpointId])

  const globalMute = useMemo(() => {
    const now = Date.now()
    return mutes.find((m) => m.scope === 'global' && new Date(m.expiresAt).getTime() > now)
  }, [mutes])

  const endpointStats = useMemo(() => {
    const now = Date.now()
    const cutoff = now - 24 * 60 * 60 * 1000
    const within24h = log.filter((r) => new Date(r.sentAt).getTime() >= cutoff)
    const sent = within24h.filter((r) => r.deliveryStatus === 'sent').length
    const failed = within24h.filter((r) => r.deliveryStatus === 'failed').length
    const suppressed = within24h.filter((r) => r.deliveryStatus === 'suppressed').length
    const lastOpen = log.find(
      (r) => r.kind === 'incident_opened' && r.deliveryStatus === 'sent',
    )?.sentAt
    const lastResolved = log.find(
      (r) => r.kind === 'incident_resolved' && r.deliveryStatus === 'sent',
    )?.sentAt
    const lastFailure = log.find((r) => r.deliveryStatus === 'failed')?.sentAt
    return { sent, failed, suppressed, lastOpen, lastResolved, lastFailure }
  }, [log])

  // Group recent delivery rows by incident — most recent incident first.
  const timeline = useMemo(() => {
    type Group = {
      key: string
      incidentId: string | null
      rows: ApiNotificationLogRow[]
      latest: number
    }
    const groups = new Map<string, Group>()
    for (const row of log) {
      if (row.deliveryStatus === 'suppressed') continue
      const key = row.incidentId ?? `${row.kind}:${row.channelId}:${row._id}`
      const existing = groups.get(key)
      const ts = new Date(row.sentAt).getTime()
      if (existing) {
        existing.rows.push(row)
        existing.latest = Math.max(existing.latest, ts)
      } else {
        groups.set(key, { key, incidentId: row.incidentId ?? null, rows: [row], latest: ts })
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        ...g,
        rows: [...g.rows].sort(
          (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
        ),
      }))
      .sort((a, b) => b.latest - a.latest)
      .slice(0, 6)
  }, [log])

  const suppressions = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const recent = log.filter(
      (r) => r.deliveryStatus === 'suppressed' && new Date(r.sentAt).getTime() >= cutoff,
    )
    const byReason = new Map<string, { count: number; rows: ApiNotificationLogRow[] }>()
    for (const row of recent) {
      const reason = row.suppressedReason ?? 'unknown'
      const entry = byReason.get(reason) ?? { count: 0, rows: [] }
      entry.count += 1
      if (entry.rows.length < 5) entry.rows.push(row)
      byReason.set(reason, entry)
    }
    return Array.from(byReason.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [log])

  // ── Actions ────────────────────────────────────────────────────────────
  const unmute = useCallback(async () => {
    if (!activeEndpointMute) return
    const res = await request(`/notifications/mutes/${activeEndpointMute._id}`, {
      method: 'DELETE',
    })
    if (res.status >= 400) {
      toast.error('Unmute failed', { description: `HTTP ${res.status}` })
    } else {
      toast.success('Endpoint unmuted')
      void loadMutes()
    }
  }, [activeEndpointMute, request, loadMutes])

  const mute = useCallback(
    async (presetId: string) => {
      const preset = MUTE_PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      // "Until resolved" → pick a large upper bound (24h); the alerts pipeline
      // clears the mute when the incident resolves in later revisions. For V1
      // we approximate with a 24h window.
      const seconds = preset.seconds ?? 24 * 60 * 60
      const expiresAt = new Date(Date.now() + seconds * 1000).toISOString()
      const res = await request(`/endpoints/${endpointId}/notifications/mute`, {
        method: 'POST',
        body: { expiresAt, reason: `Muted via detail page (${preset.label})` },
      })
      setShowMuteModal(false)
      if (res.status >= 400) {
        toast.error('Mute failed', { description: `HTTP ${res.status}` })
      } else {
        toast.success('Endpoint muted', { description: `Until ${new Date(expiresAt).toLocaleTimeString()}` })
        void loadMutes()
      }
    },
    [endpointId, request, loadMutes],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner size="md" />
      </div>
    )
  }

  const hasChannels = linkedChannels.length > 0
  const effectiveMute = activeEndpointMute ?? globalMute ?? null

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* ── Left column (2/3) ──────────────────────────────────────────── */}
      <div className="col-span-2 space-y-6">
        {/* Header: channels + mute */}
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs font-semibold text-foreground">Notification Delivery</div>
              <div className="text-[11px] text-wd-muted mt-0.5">
                {hasChannels
                  ? `Routed to ${linkedChannels.length} channel${linkedChannels.length === 1 ? '' : 's'}.`
                  : 'No channels linked — incidents won\u2019t reach anyone.'}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {effectiveMute ? (
                <Button
                  size="sm"
                  variant="bordered"
                  className="!text-[11px] !border-wd-warning/50 !text-wd-warning"
                  onPress={() => { if (activeEndpointMute) void unmute() }}
                  isDisabled={!activeEndpointMute}
                >
                  <Icon icon="solar:bell-off-linear" width={16} />
                  {activeEndpointMute
                    ? <>Muted · until <span className="font-mono">{new Date(activeEndpointMute.expiresAt).toLocaleTimeString()}</span></>
                    : <>Global mute active · until <span className="font-mono">{new Date(effectiveMute.expiresAt).toLocaleTimeString()}</span></>}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="bordered"
                  className="!text-[11px]"
                  onPress={() => setShowMuteModal(true)}
                >
                  <Icon icon="solar:bell-off-linear" width={16} />
                  Mute
                </Button>
              )}
              <Button
                size="sm"
                variant="bordered"
                className="!text-[11px]"
                onPress={onJumpToSettings}
              >
                <Icon icon="solar:settings-linear" width={16} />
                Configure
              </Button>
            </div>
          </div>

          {/* Channel pills */}
          {hasChannels ? (
            <div className="flex flex-wrap gap-1.5">
              {linkedChannels.map((c) => (
                <Link
                  key={c._id}
                  to={`/notifications?channelId=${c._id}`}
                  className="flex items-center gap-1.5 rounded-full bg-wd-surface-hover hover:bg-wd-surface-hover/80 border border-wd-border/50 px-2 py-0.5 text-[11px]"
                >
                  <Icon icon={CHANNEL_TYPE_ICON[c.type]} width={16} />
                  <span className="text-foreground">{c.name}</span>
                  {!c.enabled && (
                    <span className="text-[10px] text-wd-muted">(disabled)</span>
                  )}
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-wd-muted">
              Link channels from the <button type="button" className="underline" onClick={onJumpToSettings}>Settings</button> tab.
            </div>
          )}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <StatTile
            label="Sent (24h)"
            value={endpointStats.sent}
            icon="solar:check-circle-bold"
            accent="success"
          />
          <StatTile
            label="Failed (24h)"
            value={endpointStats.failed}
            icon="solar:close-circle-bold"
            accent={endpointStats.failed > 0 ? 'danger' : 'muted'}
          />
          <StatTile
            label="Last Open"
            value={endpointStats.lastOpen ? timeAgo(endpointStats.lastOpen) : '—'}
            icon="solar:danger-triangle-bold"
            accent="warning"
            valueClass="!text-xs"
          />
          <StatTile
            label="Last Resolved"
            value={endpointStats.lastResolved ? timeAgo(endpointStats.lastResolved) : '—'}
            icon="solar:shield-check-bold"
            accent="primary"
            valueClass="!text-xs"
          />
        </div>

        {/* Timeline grouped by incident */}
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl">
          <div className="px-4 py-2.5 border-b border-wd-border/50 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">Recent Deliveries</h3>
            <Link
              to={`/notifications?endpointId=${endpointId}`}
              className="text-[11px] text-wd-primary hover:underline"
            >
              View all →
            </Link>
          </div>
          {timeline.length === 0 ? (
            <div className="p-8 text-center">
              <Icon icon="solar:bell-linear" width={28} className="mx-auto text-wd-muted/40 mb-2" />
              <p className="text-xs text-wd-muted">No deliveries yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-wd-border/40">
              {timeline.map((group) => (
                <div key={group.key} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {group.incidentId ? (
                        <Link
                          to={`/incidents/${group.incidentId}`}
                          className="text-[11px] font-medium text-foreground hover:text-wd-primary"
                        >
                          Incident · <span className="font-mono">{group.incidentId.slice(0, 6)}</span>
                        </Link>
                      ) : (
                        <span className="text-[11px] font-medium text-foreground">Standalone</span>
                      )}
                      <span className="text-[10px] text-wd-muted">
                        {group.rows.length} dispatch{group.rows.length === 1 ? '' : 'es'}
                      </span>
                    </div>
                    <span className="text-[10px] text-wd-muted font-mono">
                      {timeAgo(new Date(group.latest).toISOString())}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {group.rows.map((row) => (
                      <button
                        key={row._id}
                        type="button"
                        onClick={() => setOpenRow(row)}
                        className="w-full flex items-center gap-2 text-left rounded-md px-2 py-1.5 hover:bg-wd-surface-hover transition-colors"
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_STYLE[row.severity]}`}
                        />
                        <Icon
                          icon={CHANNEL_TYPE_ICON[row.channelType]}
                          width={16}
                          className="shrink-0"
                        />
                        <span className="text-[11px] text-foreground truncate flex-1 min-w-0">
                          {KIND_LABEL[row.kind]} · <span className="font-mono">{row.channelTarget}</span>
                        </span>
                        {typeof row.latencyMs === 'number' && (
                          <span className="text-[10px] text-wd-muted font-mono shrink-0">
                            {row.latencyMs}ms
                          </span>
                        )}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_STYLE[row.deliveryStatus].className}`}
                        >
                          {STATUS_STYLE[row.deliveryStatus].label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right column (1/3) — suppressions + health summary ─────────── */}
      <div className="space-y-4">
        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2.5">
            <Icon icon="solar:shield-warning-linear" width={16} className="text-wd-warning" />
            <h3 className="text-xs font-semibold text-foreground">Suppressions (24h)</h3>
            {stats && (
              <span className="text-[10px] text-wd-muted ml-auto">
                {endpointStats.suppressed} total
              </span>
            )}
          </div>
          {suppressions.length === 0 ? (
            <div className="py-3 text-center">
              <p className="text-[11px] text-wd-muted">Nothing suppressed.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {suppressions.map(([reason, info]) => (
                <div key={reason} className="rounded-lg bg-wd-surface-hover/40 px-2.5 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-foreground">
                      {prettyReason(reason)}
                    </span>
                    <span className="text-[10px] text-wd-muted font-mono">{info.count}</span>
                  </div>
                  <div className="text-[10px] text-wd-muted">
                    Most recent <span className="font-mono">{timeAgo(info.rows[0].sentAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2.5">
            <Icon icon="solar:clock-circle-linear" width={16} className="text-wd-primary" />
            <h3 className="text-xs font-semibold text-foreground">Routing Summary</h3>
          </div>
          <div className="space-y-1.5 text-[11px]">
            <KV label="Cooldown" value={`${endpoint.alertCooldown}s`} />
            <KV
              label="Recovery Alert"
              value={endpoint.recoveryAlert ? 'Enabled' : 'Disabled'}
            />
            <KV
              label="Escalation"
              value={
                endpoint.escalationDelay > 0
                  ? `after ${endpoint.escalationDelay}s`
                  : 'Off'
              }
            />
            <KV label="Linked Channels" value={String(endpoint.notificationChannelIds.length)} />
          </div>
        </div>
      </div>

      {/* Mute modal */}
      {showMuteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowMuteModal(false)} />
          <div className="relative bg-wd-surface border border-wd-border rounded-xl p-5 w-full max-w-sm shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <Icon icon="solar:bell-off-linear" width={20} className="text-wd-warning" />
              <h3 className="text-sm font-semibold text-foreground">Mute {endpoint.name}</h3>
            </div>
            <p className="text-xs text-wd-muted mb-4">
              Incidents for this endpoint won&rsquo;t dispatch while muted. Critical events still fire.
            </p>
            <div className="space-y-1.5">
              {MUTE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void mute(p.id)}
                  className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-xs text-foreground hover:bg-wd-surface-hover transition-colors"
                >
                  <span>{p.label}</span>
                  <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-wd-muted" />
                </button>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <Button
                size="sm"
                variant="bordered"
                className="!text-xs"
                onPress={() => setShowMuteModal(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      <LogDetailDrawer
        row={openRow}
        onClose={() => setOpenRow(null)}
        channels={channels}
        endpointNameById={new Map([[endpointId, endpoint.name]])}
        onRetried={() => {
          void loadLog()
          void loadStats()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  icon,
  accent,
  valueClass,
}: {
  label: string
  value: string | number
  icon: string
  accent: 'primary' | 'success' | 'warning' | 'danger' | 'muted'
  valueClass?: string
}) {
  const accents = {
    primary: 'bg-wd-primary/10 text-wd-primary',
    success: 'bg-wd-success/10 text-wd-success',
    warning: 'bg-wd-warning/10 text-wd-warning',
    danger: 'bg-wd-danger/10 text-wd-danger',
    muted: 'bg-wd-surface-hover text-wd-muted',
  }
  return (
    <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-3 flex items-center gap-3">
      <div className={`rounded-lg p-2 ${accents[accent]}`}>
        <Icon icon={icon} width={20} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] text-wd-muted uppercase tracking-wide">{label}</div>
        <div className={`text-sm font-semibold font-mono text-foreground ${valueClass ?? ''}`}>
          {value}
        </div>
      </div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-wd-muted">{label}</span>
      <span className="text-foreground font-medium font-mono">{value}</span>
    </div>
  )
}

function prettyReason(reason: string): string {
  switch (reason) {
    case 'cooldown': return 'Cooldown'
    case 'quiet_hours': return 'Quiet Hours'
    case 'maintenance': return 'Maintenance Window'
    case 'severity_filter': return 'Severity Filter'
    case 'event_filter': return 'Event Filter'
    case 'rate_limit': return 'Rate Limited'
    case 'module_disabled': return 'Module Disabled'
    case 'coalesced': return 'Coalesced (Duplicate)'
    case 'muted': return 'Muted'
    case 'channel_disabled': return 'Channel Disabled'
    default: return reason
  }
}
