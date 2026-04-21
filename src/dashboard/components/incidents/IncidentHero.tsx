/**
 * Active-incidents hero strip.
 *
 * Grid is a fixed 3-col (dropping to 2 then 1 at narrower widths) so cards
 * always occupy a single column — never stretch full-width — matching the
 * reference design. Each card is tinted by severity so users can spot the
 * critical incidents without reading the chip:
 *   • Critical → red
 *   • Major    → amber
 *   • Minor    → primary
 *
 * Layout per card:
 *   1. status dot + endpoint name + kind           |   "Down for" + live clock
 *   2. severity chip + cause label + cause detail
 *   3. meta items: Started · Last Check · Alerts
 *   4. notification channel icons (from endpoint config)
 *   5. response-time sparkline over the last 30 checks
 */
import { memo, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import type { ApiIncident } from '../../types/api'
import type { ApiChannel, ChannelType } from '../../types/notifications'
import { timeAgo } from '../../utils/format'
import { WideSpark } from '../health/HealthCharts'
import {
  endpointDisplay,
  metaFor,
  severityChipClass,
  severityDotClass,
  severityOf,
  type EndpointLite,
  type EndpointSparkline,
  type Severity,
} from './incidentHelpers'
import { LiveDuration, LiveUpdatedLabel } from './LiveTime'

export interface HeroEndpointState {
  lastStatus?: 'healthy' | 'degraded' | 'down'
  lastStatusCode?: number | null
  lastResponseTime?: number
  lastCheckAt?: string
  notificationChannelIds: string[]
}

interface Props {
  activeIncidents: ApiIncident[]
  endpointById: Map<string, EndpointLite>
  endpointStateById: Map<string, HeroEndpointState>
  channelById: Map<string, ApiChannel>
  sparklineByIncidentId: Map<string, EndpointSparkline>
  lastUpdatedAt: number
}

export function IncidentHero({
  activeIncidents,
  endpointById,
  endpointStateById,
  channelById,
  sparklineByIncidentId,
  lastUpdatedAt,
}: Props) {
  if (activeIncidents.length === 0) {
    return <AllClearBanner lastUpdatedAt={lastUpdatedAt} />
  }

  const critCount = activeIncidents.filter((i) => severityOf(i) === 'Critical').length

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-dashed border-wd-border/60">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wd-danger" />
          </span>
          <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-foreground">
            Active Incidents
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-wd-danger/15 text-wd-danger text-[11px] font-semibold font-mono">
              {activeIncidents.length}
            </span>
            {critCount > 0 && (
              <span className="text-[11px] text-wd-muted font-normal">
                · {critCount} critical
              </span>
            )}
          </span>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-wd-border/50 bg-wd-surface-hover/40 px-3 py-1 text-[11px] text-wd-muted font-mono">
          <span className="h-1.5 w-1.5 rounded-full bg-wd-success animate-pulse" />
          Live · updated <LiveUpdatedLabel lastUpdatedAt={lastUpdatedAt} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {activeIncidents.map((inc) => (
          <HeroCard
            key={inc._id}
            incident={inc}
            endpoint={endpointById.get(inc.endpointId)}
            endpointState={endpointStateById.get(inc.endpointId)}
            channelById={channelById}
            sparkline={sparklineByIncidentId.get(inc._id)}
          />
        ))}
      </div>
    </div>
  )
}

function AllClearBanner({ lastUpdatedAt }: { lastUpdatedAt: number }) {
  return (
    <div className="grid items-center gap-6 rounded-xl border border-wd-border/50 bg-wd-surface px-5 py-4.5 grid-cols-[auto_1fr_auto]">
      <div className="relative h-12 w-12 rounded-2xl flex items-center justify-center bg-wd-success/15 text-wd-success">
        <span className="absolute inset-[-4px] rounded-[18px] bg-current opacity-10 animate-ping" />
        <Icon icon="solar:shield-check-bold" width={26} />
      </div>
      <div>
        <div className="text-[21px] font-semibold leading-tight tracking-tight text-foreground">
          All systems operational
        </div>
        <div className="text-xs text-wd-muted mt-0.5">
          No active incidents. Endpoints are running clean.
        </div>
      </div>
      <div className="inline-flex items-center gap-2 rounded-full border border-wd-border/50 bg-wd-surface-hover/40 px-3 py-1.5 text-[11px] text-wd-muted font-mono">
        <span className="h-1.5 w-1.5 rounded-full bg-wd-success animate-pulse" />
        Updated <LiveUpdatedLabel lastUpdatedAt={lastUpdatedAt} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Severity → card tint helpers
// ---------------------------------------------------------------------------

function severityTintClasses(sev: Severity): string {
  switch (sev) {
    case 'Critical': return 'bg-wd-danger/[0.05] hover:bg-wd-danger/[0.09]'
    case 'Major':    return 'bg-wd-warning/[0.05] hover:bg-wd-warning/[0.09]'
    case 'Minor':    return 'bg-wd-primary/[0.04] hover:bg-wd-primary/[0.08]'
  }
}

function durationTone(sev: Severity): string {
  if (sev === 'Critical') return 'text-wd-danger'
  if (sev === 'Major') return 'text-wd-warning'
  return 'text-wd-primary'
}

function sparkStroke(sev: Severity): string {
  if (sev === 'Critical') return 'var(--wd-danger)'
  if (sev === 'Major') return 'var(--wd-warning)'
  return 'var(--wd-primary)'
}

// ---------------------------------------------------------------------------
// Channel chip
// ---------------------------------------------------------------------------

const CHANNEL_ICON: Record<ChannelType, string> = {
  discord:  'ic:baseline-discord',
  slack:    'logos:slack-icon',
  email:    'solar:letter-outline',
  webhook:  'solar:code-square-outline',
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
      className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-wd-border/50 bg-wd-surface-hover/60 text-wd-muted"
    >
      <Icon icon={CHANNEL_ICON[channel.type]} width={16} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Hero card
// ---------------------------------------------------------------------------

const HeroCard = memo(function HeroCard({
  incident,
  endpoint,
  endpointState,
  channelById,
  sparkline,
}: {
  incident: ApiIncident
  endpoint: EndpointLite | undefined
  endpointState: HeroEndpointState | undefined
  channelById: Map<string, ApiChannel>
  sparkline: EndpointSparkline | undefined
}) {
  const navigate = useNavigate()
  const ep = endpointDisplay(endpoint)
  const sev = severityOf(incident)
  const meta = metaFor(incident.cause)

  const lastCheckLabel = formatLastCheck(endpointState)
  const lastCheckTone =
    endpointState?.lastStatus === 'down'
      ? 'text-wd-danger'
      : endpointState?.lastStatus === 'degraded'
        ? 'text-wd-warning'
        : 'text-foreground'

  const channels =
    endpointState?.notificationChannelIds
      ?.map((id) => channelById.get(id))
      .filter((c): c is ApiChannel => !!c) ?? []

  const sparkValues = sparkline?.values ?? []
  // Memoize the labels array so WideSpark's React.memo can short-circuit on
  // re-renders (otherwise a fresh array every render busts the memo).
  const sparkLabels = useMemo(
    () => sparkline?.timestamps.map(formatCheckTime) ?? [],
    [sparkline],
  )
  const peak = sparkValues.length > 0 ? Math.max(...sparkValues) : 0

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/incidents/${incident._id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/incidents/${incident._id}`)
      }}
      className={cn(
        'flex flex-col gap-2.5 px-5 py-4 border-r border-b border-wd-border/40 cursor-pointer transition-colors',
        'last:border-r-0',
        'lg:[&:nth-child(3n)]:border-r-0',
        'sm:max-lg:[&:nth-child(2n)]:border-r-0',
        'max-sm:border-r-0',
        severityTintClasses(sev),
      )}
    >
      {/* Row 1 — status dot + name + type | duration */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className={cn('h-2 w-2 rounded-full shrink-0', severityDotClass(sev))} />
          <span className="text-sm font-semibold text-foreground truncate tracking-tight">
            {ep.name}
          </span>
          {ep.kind && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9.5px] font-medium font-mono uppercase tracking-[0.08em] text-wd-muted/80 bg-wd-surface-hover/60 border border-wd-border/50">
              {ep.kind}
            </span>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-wd-muted/80 leading-none">
            Down for
          </div>
          <LiveDuration
            startedAt={incident.startedAt}
            className={cn('mt-0.5 text-[13px] font-semibold font-mono tracking-tight block', durationTone(sev))}
          />
        </div>
      </div>

      {/* Row 2 — severity + cause label + cause detail */}
      <div className="text-[12px] leading-snug text-wd-muted">
        <span className="inline-flex items-center gap-1.5 mr-1.5 font-semibold text-foreground">
          <span
            className={cn(
              'px-1.5 py-[1px] rounded text-[9.5px] font-semibold font-mono uppercase tracking-[0.08em]',
              severityChipClass(sev),
            )}
          >
            {sev}
          </span>
          {meta.label}
        </span>
        {incident.causeDetail}
      </div>

      {/* Row 3/4 — meta grid: Started · Last check · Alerts */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-dashed border-wd-border/60 text-[11px] text-wd-muted font-mono">
        <span className="inline-flex items-center gap-1.5">
          <Icon icon="solar:clock-circle-linear" width={16} />
          Started <span className="text-foreground font-medium">{timeAgo(incident.startedAt)}</span>
        </span>
        {lastCheckLabel && (
          <span className="inline-flex items-center gap-1.5">
            <Icon icon="solar:pulse-linear" width={16} />
            Last check: <span className={cn('font-medium', lastCheckTone)}>{lastCheckLabel}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <Icon icon="solar:bell-outline" width={16} />
          Alerts: <span className="text-foreground font-medium">{incident.notificationsSent}</span>
        </span>
      </div>

      {/* Row 5 — channel icons */}
      <div className="flex items-center pt-1 gap-1 min-w-0 flex-wrap">
        {channels.length > 0 ? (
          channels.slice(0, 6).map((c) => <ChannelChip key={c._id} channel={c} />)
        ) : (
          <span className="text-[10.5px] text-wd-muted/70 italic">No channels configured</span>
        )}
      </div>

      {/* Row 6 — response-time sparkline */}
      {sparkValues.length > 1 && (
        <div className="pt-2 border-t border-dashed border-wd-border/60">
          <div className="flex items-center justify-between text-[10px] text-wd-muted/80 font-mono mb-1">
            <span>Response time · {sparkValues.length} checks during incident</span>
            <span>
              peak <span className="text-foreground font-medium">{peak.toLocaleString()}ms</span>
            </span>
          </div>
          <WideSpark
            data={sparkValues}
            labels={sparkLabels}
            formatValue={(n) => `${Math.round(n).toLocaleString()} ms`}
            color={sparkStroke(sev)}
            height={48}
          />
        </div>
      )}
    </div>
  )
})

function formatCheckTime(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${date} · ${time}`
}

function formatLastCheck(st: HeroEndpointState | undefined): string | null {
  if (!st || !st.lastCheckAt) return null
  const code = st.lastStatusCode != null ? String(st.lastStatusCode) : '—'
  const rt = st.lastResponseTime != null ? `${Math.round(st.lastResponseTime)}ms` : '—'
  return `${code} · ${rt} · ${timeAgo(st.lastCheckAt)}`
}
