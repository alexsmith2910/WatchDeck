import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { Button, Spinner, cn } from '@heroui/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import {
  Heatmap,
  LineChart,
  Sparkline,
  StatusPill,
  Topology,
  WideSpark,
  topologyEdgeKey,
  type LineChartRow,
  type LineSeries,
} from '../components/health/HealthCharts'
import type {
  InternalIncident,
  ProbeStatus,
  SubsystemSnapshot,
  SystemHealthSnapshot,
} from '../types/systemHealth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBSYSTEM_LINE_COLORS: Record<string, string> = {
  db: 'var(--wd-primary)',
  scheduler: 'var(--wd-warning)',
  checkers: 'var(--wd-success)',
  buffer: '#a78bfa',
  sse: '#22d3ee',
  eventbus: '#f472b6',
  aggregator: '#fb923c',
  incidents: 'var(--wd-danger)',
  auth: '#14b8a6',
  notifications: '#34d399',
}

function colorForSubsystem(id: string): string {
  return SUBSYSTEM_LINE_COLORS[id] ?? 'var(--wd-primary)'
}

function sparkColor(status: ProbeStatus): string {
  if (status === 'down') return 'var(--wd-danger)'
  if (status === 'degraded') return 'var(--wd-warning)'
  if (status === 'standby') return 'var(--wd-primary)'
  if (status === 'disabled') return 'var(--wd-muted)'
  return 'var(--wd-success)'
}

function tileClasses(tile: 'primary' | 'success' | 'warning' | 'danger'): string {
  switch (tile) {
    case 'primary': return 'bg-wd-primary/15 text-wd-primary'
    case 'success': return 'bg-wd-success/15 text-wd-success'
    case 'warning': return 'bg-wd-warning/15 text-wd-warning'
    case 'danger':  return 'bg-wd-danger/15 text-wd-danger'
  }
}

function formatHMS(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatUptime(seconds: number): { value: string; unit: string } {
  if (seconds < 60) return { value: String(Math.floor(seconds)), unit: 's' }
  if (seconds < 3600) return { value: (seconds / 60).toFixed(1), unit: 'm' }
  if (seconds < 86_400) return { value: (seconds / 3600).toFixed(1), unit: 'h' }
  return { value: (seconds / 86_400).toFixed(1), unit: 'd' }
}

function formatStarted(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatUpdatedAgo(sec: number): string {
  if (sec < 1) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function formatLastProbed(ts: number | null): string {
  if (ts === null) return 'never'
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function formatCadence(ms: number): string {
  if (ms === 0) return 'passive'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function bucketLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function bucketLabelWithSeconds(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Passive probes refresh at PASSIVE_REFRESH_MS on the backend; use the same
// step here when `cadenceMs` is 0 so spark hover labels stay roughly aligned.
const PASSIVE_REFRESH_MS = 30_000

function buildSparkLabels(
  length: number,
  lastProbedAt: number | null,
  cadenceMs: number,
): string[] {
  if (lastProbedAt === null || length === 0) return []
  const step = cadenceMs > 0 ? cadenceMs : PASSIVE_REFRESH_MS
  const labels: string[] = []
  for (let i = 0; i < length; i++) {
    const ts = lastProbedAt - (length - 1 - i) * step
    labels.push(bucketLabelWithSeconds(ts))
  }
  return labels
}

function formatLatency(n: number): string {
  return `${Math.round(n)}ms`
}

// ---------------------------------------------------------------------------
// Overall banner
// ---------------------------------------------------------------------------

function OverallBanner({
  overall,
  lastUpdatedSeconds,
}: {
  overall: SystemHealthSnapshot['overall']
  lastUpdatedSeconds: number
}) {
  const state = overall.state
  const iconName =
    state === 'operational'
      ? 'solar:shield-check-bold'
      : state === 'degraded'
        ? 'solar:danger-triangle-bold'
        : 'solar:bolt-circle-bold'

  const borderTint =
    state === 'operational'
      ? 'border-wd-border/50'
      : state === 'degraded'
        ? 'border-wd-warning/30'
        : 'border-wd-danger/30'
  const bgTint =
    state === 'operational'
      ? 'bg-wd-surface'
      : state === 'degraded'
        ? 'bg-wd-warning/5'
        : 'bg-wd-danger/5'
  const pulseColor =
    state === 'operational'
      ? 'bg-wd-success/15 text-wd-success'
      : state === 'degraded'
        ? 'bg-wd-warning/15 text-wd-warning'
        : 'bg-wd-danger/15 text-wd-danger'

  const uptime = formatUptime(overall.processUptimeSeconds)
  const slowest = overall.slowestProbe

  return (
    <div
      className={cn(
        'grid items-center gap-6 rounded-xl border px-5 py-4.5',
        'grid-cols-[auto_1fr_auto]',
        borderTint,
        bgTint,
      )}
    >
      <div className="flex items-center gap-4">
        <div className={cn('relative h-12 w-12 rounded-2xl flex items-center justify-center', pulseColor)}>
          <span className="absolute inset-[-4px] rounded-[18px] bg-current opacity-10 animate-ping" />
          <Icon icon={iconName} width={26} />
        </div>
        <div>
          <div className="text-[21px] font-semibold leading-tight tracking-tight text-foreground">
            {overall.label}
          </div>
          <div className="text-xs text-wd-muted mt-0.5">{overall.sub}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <BannerMetric
          label="Subsystems"
          value={String(overall.subsystemsHealthy)}
          unit={`/ ${overall.subsystemsTotal} healthy`}
        />
        <BannerMetric
          label="Active Incidents"
          value={String(overall.activeIncidents)}
          unit={overall.p1Count > 0 ? ` · ${overall.p1Count} P1` : ''}
        />
        <BannerMetric
          label="Slowest Probe"
          value={slowest ? String(Math.round(slowest.latencyMs)) : '—'}
          unit={slowest ? ` ms · ${slowest.title}` : ''}
        />
        <BannerMetric label="Uptime" value={uptime.value} unit={uptime.unit} />
      </div>
      <div className="inline-flex items-center gap-2 rounded-full border border-wd-border/50 bg-wd-surface-hover/40 px-3 py-1.5 text-[11px] text-wd-muted font-mono">
        <span className="h-1.5 w-1.5 rounded-full bg-wd-success animate-pulse" />
        Updated {formatUpdatedAgo(lastUpdatedSeconds)}
      </div>
    </div>
  )
}

function BannerMetric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80">
        {label}
      </span>
      <span className="text-[15px] font-semibold font-mono text-foreground">
        {value}
        {unit && <span className="ml-0.5 text-[11px] text-wd-muted font-medium">{unit}</span>}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function KpiCard({
  icon,
  tile = 'primary',
  title,
  value,
  unit,
  delta,
  deltaTone = 'muted',
  deltaLabel,
  spark,
  sparkStroke,
  sparkLabels,
  sparkFormat,
}: {
  icon: string
  tile?: 'primary' | 'success' | 'warning' | 'danger'
  title: string
  value: string | number
  unit?: string
  delta?: string
  deltaTone?: 'success' | 'warning' | 'danger' | 'muted'
  deltaLabel?: string
  spark?: number[] | null
  sparkStroke?: string
  sparkLabels?: string[]
  sparkFormat?: (n: number) => string
}) {
  const deltaColor =
    deltaTone === 'success'
      ? 'text-wd-success'
      : deltaTone === 'warning'
        ? 'text-wd-warning'
        : deltaTone === 'danger'
          ? 'text-wd-danger'
          : 'text-wd-muted'
  return (
    <div className="relative flex flex-col gap-2.5 rounded-xl border border-wd-border/50 bg-wd-surface px-4 py-3.5 min-h-[118px] overflow-hidden">
      <div className="flex items-center gap-2.5">
        <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center', tileClasses(tile))}>
          <Icon icon={icon} width={16} />
        </div>
        <div className="text-xs font-medium text-wd-muted">{title}</div>
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold font-mono tracking-tight text-foreground">
            {value}
          </span>
          {unit && <span className="text-[11px] text-wd-muted">{unit}</span>}
        </div>
        {delta && (
          <div className={cn('mt-1.5 text-[11px] font-medium', deltaColor)}>
            {delta}
            {deltaLabel && (
              <span className="ml-1 text-wd-muted/70 font-normal">{deltaLabel}</span>
            )}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-auto -mx-4">
          <WideSpark
            data={spark}
            color={sparkStroke ?? 'var(--wd-primary)'}
            height={46}
            labels={sparkLabels}
            formatValue={sparkFormat}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subsystem card — replaces the old worker-dot/restart card from the V0 spec
// ---------------------------------------------------------------------------

function SubsystemCard({
  sub,
  onRunProbe,
  isProbing,
}: {
  sub: SubsystemSnapshot
  onRunProbe: (sub: SubsystemSnapshot) => void
  isProbing: boolean
}) {
  const iconBg =
    sub.status === 'down'
      ? 'bg-wd-danger/15 text-wd-danger'
      : sub.status === 'degraded'
        ? 'bg-wd-warning/15 text-wd-warning'
        : sub.status === 'disabled'
          ? 'bg-wd-muted/15 text-wd-muted'
          : sub.status === 'standby'
            ? 'bg-wd-primary/15 text-wd-primary'
            : 'bg-wd-surface-hover/70 text-foreground'

  const cardBorder =
    sub.status === 'down'
      ? 'border-wd-danger/30'
      : sub.status === 'degraded'
        ? 'border-wd-warning/30'
        : 'border-wd-border/50'

  const groupLabel = sub.group === 'core' ? 'Core' : 'Non-core'

  return (
    <div
      className={cn(
        'rounded-xl border bg-wd-surface p-4 flex flex-col gap-2.5 transition-colors hover:bg-wd-surface-hover/40',
        cardBorder,
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', iconBg)}>
          <Icon icon={sub.icon} width={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground truncate">{sub.title}</div>
          <div className="text-[10.5px] text-wd-muted/80 mt-0.5">
            {groupLabel} · {sub.sub}
          </div>
        </div>
        <StatusPill status={sub.status} />
      </div>

      <div className="flex items-end gap-3">
        <div className="flex-1 grid grid-cols-3 gap-2">
          {sub.metrics.map((m, i) => (
            <div key={i} className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[10px] font-medium font-mono uppercase tracking-wider text-wd-muted/80 truncate">
                {m.lbl}
              </span>
              <span className="text-sm font-semibold font-mono text-foreground truncate">
                {m.val}
                {m.unit && <span className="ml-0.5 text-[10px] text-wd-muted font-medium">{m.unit}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="shrink-0">
          <Sparkline
            data={sub.sparkline}
            color={sparkColor(sub.status)}
            width={88}
            height={34}
            labels={buildSparkLabels(sub.sparkline.length, sub.lastProbedAt, sub.cadenceMs)}
            formatValue={formatLatency}
          />
        </div>
      </div>

      {sub.error && (
        <div className="text-[11px] text-wd-danger bg-wd-danger/5 border border-wd-danger/20 rounded-md px-2 py-1.5 truncate" title={sub.error}>
          {sub.error}
        </div>
      )}

      <div className="flex items-center justify-between mt-1 pt-2.5 border-t border-wd-border/30">
        <div className="flex items-center gap-3 text-[11px] text-wd-muted font-mono">
          <span>
            <span className="text-wd-muted/70">latency</span>{' '}
            {sub.latencyMs === null ? '—' : `${Math.round(sub.latencyMs)}ms`}
          </span>
          <span>
            <span className="text-wd-muted/70">cadence</span> {formatCadence(sub.cadenceMs)}
          </span>
          <span>
            <span className="text-wd-muted/70">last</span> {formatLastProbed(sub.lastProbedAt)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => onRunProbe(sub)}
          isDisabled={isProbing}
          className="!text-[11px] !h-6 !min-h-0 !px-2"
        >
          <Icon
            icon={isProbing ? 'solar:refresh-outline' : 'solar:play-circle-outline'}
            width={16}
            className={isProbing ? 'animate-spin' : ''}
          />
          {isProbing ? 'Running…' : 'Run Probe'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Incident row
// ---------------------------------------------------------------------------

function IncidentRow({ inc }: { inc: InternalIncident }) {
  // Active incidents re-tick their duration text every second; resolved ones
  // are static. Scoping the interval here keeps HealthPage's tree stable when
  // no active incidents exist.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (inc.status !== 'active') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [inc.status])

  const severityColor =
    inc.status === 'resolved'
      ? 'bg-wd-success/15 text-wd-success'
      : inc.severity === 'p1'
        ? 'bg-wd-danger/15 text-wd-danger'
        : inc.severity === 'p2'
          ? 'bg-wd-warning/15 text-wd-warning'
          : 'bg-wd-muted/15 text-wd-muted'
  const duration =
    inc.status === 'resolved' && inc.durationSeconds != null
      ? formatHMS(inc.durationSeconds)
      : formatHMS((now - inc.startedAt) / 1000)

  return (
    <div
      className={cn(
        'grid items-center gap-4 rounded-xl border px-4 py-3',
        'grid-cols-[52px_1fr_auto]',
        inc.status === 'resolved'
          ? 'border-wd-border/40 bg-wd-surface/60 opacity-90'
          : inc.severity === 'p1'
            ? 'border-wd-danger/30 bg-wd-danger/5'
            : inc.severity === 'p2'
              ? 'border-wd-warning/30 bg-wd-warning/5'
              : 'border-wd-border/50 bg-wd-surface',
      )}
    >
      <div
        className={cn(
          'h-9 rounded-lg flex items-center justify-center text-[11px] font-semibold font-mono tracking-wider',
          severityColor,
        )}
      >
        {inc.status === 'resolved' ? (
          <Icon icon="solar:check-circle-bold" width={20} />
        ) : (
          inc.severity.toUpperCase()
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{inc.title}</span>
          {inc.status === 'active' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-wd-danger/15 px-1.5 pt-[3px] pb-[2px] text-[10px] font-semibold uppercase tracking-wider text-wd-danger leading-none">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
              </span>
              Live
            </span>
          )}
          {inc.status === 'resolved' && (
            <span className="inline-flex items-center rounded-full bg-wd-success/15 px-1.5 pt-[3px] pb-[2px] text-[10px] font-semibold uppercase tracking-wider text-wd-success leading-none">
              Resolved
            </span>
          )}
        </div>
        <div className="mt-1 text-[12px] text-wd-muted truncate">{inc.cause}</div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-wd-muted font-mono">
          <span>
            <span className="text-wd-muted/70">Subsystem:</span> {inc.subsystem}
          </span>
          <span>
            <span className="text-wd-muted/70">Started:</span> {formatStarted(inc.startedAt)}
          </span>
          <span>
            <span className="text-wd-muted/70">Updates:</span> {inc.commits}
          </span>
          <span>
            <span className="text-wd-muted/70">ID:</span> {inc.id}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'text-xs font-mono whitespace-nowrap',
            inc.status === 'active' ? 'text-wd-danger' : 'text-wd-muted',
          )}
        >
          {duration}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2">
      <h2 className="text-[13px] font-semibold text-foreground uppercase tracking-wider">{title}</h2>
      {hint && <span className="text-[11px] text-wd-muted">{hint}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HealthPage() {
  const { request } = useApi()
  const { subscribe } = useSSE()
  const navigate = useNavigate()

  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [probingId, setProbingId] = useState<string | null>(null)
  // Map of topology edge key → expiry epoch ms. Drives the SVG pulse animation.
  const [edgePulses, setEdgePulses] = useState<Map<string, number>>(() => new Map())

  // Debounce SSE-driven refetches so a burst of probe events doesn't fire one
  // request per event.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- Fetch snapshot ----
  const fetchSnapshot = useCallback(
    async (opts: { showSpinner?: boolean } = {}) => {
      if (opts.showSpinner) setLoading(true)
      else setRefreshing(true)
      try {
        const res = await request<{ data: SystemHealthSnapshot }>(`/health`)
        if (res.data?.data) setSnapshot(res.data.data)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [request],
  )

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
    refetchTimerRef.current = setTimeout(() => {
      void fetchSnapshot()
    }, 250)
  }, [fetchSnapshot])

  // Initial fetch
  useEffect(() => {
    void fetchSnapshot({ showSpinner: true })
  }, [fetchSnapshot])

  // Background poll every 5s as a fallback when SSE is disconnected.
  useEffect(() => {
    const id = setInterval(() => {
      void fetchSnapshot()
    }, 5000)
    return () => clearInterval(id)
  }, [fetchSnapshot])

  // Probe-driven SSE refetch (debounced).
  useEffect(() => {
    const unsubs = [
      subscribe('probe:completed', scheduleRefetch),
      subscribe('probe:degraded', scheduleRefetch),
      subscribe('probe:recovered', scheduleRefetch),
      subscribe('aggregation:run', scheduleRefetch),
      subscribe('db:disconnected', scheduleRefetch),
      subscribe('db:reconnected', scheduleRefetch),
      subscribe('notification:dispatched', scheduleRefetch),
      subscribe('notification:failed', scheduleRefetch),
    ]
    return () => {
      for (const u of unsubs) u()
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
    }
  }, [subscribe, scheduleRefetch])

  // ---- Topology pulse animation driven by data-flow SSE events ----
  const triggerPulses = useCallback((keys: string[], durationMs = 1700) => {
    if (keys.length === 0) return
    const expiresAt = Date.now() + durationMs
    setEdgePulses((prev) => {
      const next = new Map(prev)
      for (const k of keys) next.set(k, expiresAt)
      return next
    })
  }, [])

  // Sweep expired pulses so the Set stays small and edges stop animating.
  useEffect(() => {
    const id = setInterval(() => {
      setEdgePulses((prev) => {
        if (prev.size === 0) return prev
        const now = Date.now()
        let changed = false
        const next = new Map(prev)
        for (const [k, exp] of prev) {
          if (exp <= now) {
            next.delete(k)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 200)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const unsubs = [
      subscribe('check:complete', () =>
        triggerPulses([
          topologyEdgeKey('scheduler', 'checkers'),
          topologyEdgeKey('checkers', 'buffer'),
          topologyEdgeKey('checkers', 'eventbus'),
          topologyEdgeKey('buffer', 'db'),
        ]),
      ),
      subscribe('incident:opened', () =>
        triggerPulses(
          [
            topologyEdgeKey('eventbus', 'incidents'),
            topologyEdgeKey('incidents', 'notifications'),
          ],
          2400,
        ),
      ),
      subscribe('incident:resolved', () =>
        triggerPulses([topologyEdgeKey('eventbus', 'incidents')], 2000),
      ),
      subscribe('aggregation:run', () =>
        triggerPulses([topologyEdgeKey('db', 'aggregator')], 2000),
      ),
      subscribe('db:disconnected', () =>
        triggerPulses([topologyEdgeKey('buffer', 'db')], 2200),
      ),
      subscribe('db:reconnected', () =>
        triggerPulses([topologyEdgeKey('buffer', 'db')], 2200),
      ),
      subscribe('notification:dispatched', () =>
        triggerPulses([topologyEdgeKey('incidents', 'notifications')], 1800),
      ),
      subscribe('notification:failed', () =>
        triggerPulses([topologyEdgeKey('incidents', 'notifications')], 1800),
      ),
    ]
    return () => {
      for (const u of unsubs) u()
    }
  }, [subscribe, triggerPulses])


  async function runProbe(sub: SubsystemSnapshot): Promise<void> {
    if (probingId) return
    setProbingId(sub.id)
    try {
      await request(`/health/${sub.id}`)
      await fetchSnapshot()
    } finally {
      setProbingId(null)
    }
  }

  // Probe-latency chart data: one row per minute, one column per subsystem.
  const probeLatencyData = useMemo<LineChartRow[]>(() => {
    if (!snapshot) return []
    return snapshot.probeHistory.points.map((p) => {
      const row: LineChartRow = { ts: p.ts, label: bucketLabel(p.ts) }
      for (const [id, v] of Object.entries(p.bySubsystem)) row[id] = v
      return row
    })
  }, [snapshot])

  const probeLatencySeries = useMemo<LineSeries[]>(() => {
    if (!snapshot) return []
    return snapshot.subsystems.map((s) => ({
      key: s.id,
      label: s.title,
      color: colorForSubsystem(s.id),
    }))
  }, [snapshot])

  // Activity (user-checks per second) — readout only, NOT a health signal.
  const activityData = useMemo<LineChartRow[]>(() => {
    if (!snapshot) return []
    return snapshot.activity.points.map((p) => ({
      ts: p.ts,
      label: bucketLabelWithSeconds(p.ts),
      checksPerSec: p.checksPerSec,
    }))
  }, [snapshot])

  const activeIncs = useMemo(
    () => (snapshot ? snapshot.incidents.filter((i) => i.status === 'active') : []),
    [snapshot],
  )
  const resolvedIncs = useMemo(
    () => (snapshot ? snapshot.incidents.filter((i) => i.status === 'resolved') : []),
    [snapshot],
  )

  if (loading && !snapshot) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-foreground">System Health</h1>
        <p className="mt-3 text-sm text-wd-muted">Unable to load system metrics.</p>
      </div>
    )
  }

  const dbPing = snapshot.kpis.dbPingMs
  const drift = snapshot.kpis.schedulerDriftMs
  const bufferLat = snapshot.kpis.bufferLatencyMs

  // Probe cadence lookup for the heatmap tooltip — used to approximate
  // degraded/down probe duration within each hourly bucket.
  const cadenceById: Record<string, number> = Object.fromEntries(
    snapshot.subsystems.map((s) => [s.id, s.cadenceMs]),
  )

  const subById: Record<string, SubsystemSnapshot> = Object.fromEntries(
    snapshot.subsystems.map((s) => [s.id, s]),
  )
  const dbSub = subById.db
  const schedSub = subById.scheduler
  const bufSub = subById.buffer
  const dbSparkLabels = buildSparkLabels(
    snapshot.kpis.dbPingSpark.length,
    dbSub?.lastProbedAt ?? null,
    dbSub?.cadenceMs ?? 0,
  )
  const schedSparkLabels = buildSparkLabels(
    snapshot.kpis.schedulerDriftSpark.length,
    schedSub?.lastProbedAt ?? null,
    schedSub?.cadenceMs ?? 0,
  )
  const bufSparkLabels = buildSparkLabels(
    snapshot.kpis.bufferLatencySpark.length,
    bufSub?.lastProbedAt ?? null,
    bufSub?.cadenceMs ?? 0,
  )

  return (
    <div className="p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">System Health</h1>
          <div className="text-xs text-wd-muted mt-1">
            Internal health of the WatchDeck process. Monitored endpoints are shown on the Endpoints page.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onPress={() => void fetchSnapshot({ showSpinner: false })}
            isDisabled={refreshing}
          >
            <Icon
              icon="solar:refresh-outline"
              width={16}
              className={refreshing ? 'animate-spin' : ''}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() => navigate('/settings')}
            aria-label="Open settings"
          >
            <Icon icon="solar:settings-outline" width={16} />
            Settings
          </Button>
        </div>
      </div>

      {/* Overall banner */}
      <OverallBanner overall={snapshot.overall} lastUpdatedSeconds={snapshot.kpis.lastUpdatedSeconds} />

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon="solar:database-outline"
          tile={dbPing === null ? 'danger' : dbPing > 500 ? 'danger' : dbPing > 100 ? 'warning' : 'success'}
          title="DB Ping Latency"
          value={dbPing === null ? '—' : Math.round(dbPing)}
          unit="ms"
          delta={
            dbPing === null
              ? 'no data'
              : dbPing > 500
                ? 'degraded'
                : dbPing > 100
                  ? 'mild elevation'
                  : 'nominal'
          }
          deltaTone={
            dbPing === null ? 'danger' : dbPing > 500 ? 'danger' : dbPing > 100 ? 'warning' : 'success'
          }
          deltaLabel="vs ≤ 100ms target"
          spark={snapshot.kpis.dbPingSpark}
          sparkStroke="var(--wd-primary)"
          sparkLabels={dbSparkLabels}
          sparkFormat={formatLatency}
        />
        <KpiCard
          icon="solar:clock-circle-outline"
          tile={drift === null ? 'success' : drift > 1000 ? 'danger' : drift > 100 ? 'warning' : 'success'}
          title="Scheduler Tick Drift"
          value={drift === null ? '—' : Math.round(drift)}
          unit="ms"
          delta={
            drift === null
              ? 'no samples'
              : drift > 1000
                ? 'severe'
                : drift > 100
                  ? 'elevated'
                  : 'steady'
          }
          deltaTone={
            drift === null ? 'muted' : drift > 1000 ? 'danger' : drift > 100 ? 'warning' : 'success'
          }
          deltaLabel="max over last 5 ticks"
          spark={snapshot.kpis.schedulerDriftSpark}
          sparkStroke="var(--wd-warning)"
          sparkLabels={schedSparkLabels}
          sparkFormat={formatLatency}
        />
        <KpiCard
          icon="solar:layers-outline"
          tile={bufferLat === null ? 'success' : bufferLat > 1000 ? 'danger' : bufferLat > 500 ? 'warning' : 'success'}
          title="Buffer Pipeline Latency"
          value={bufferLat === null ? '—' : Math.round(bufferLat)}
          unit="ms"
          delta={
            bufferLat === null
              ? 'no synthetic'
              : bufferLat > 1000
                ? 'slow path'
                : bufferLat > 500
                  ? 'elevated'
                  : 'live'
          }
          deltaTone={
            bufferLat === null ? 'muted' : bufferLat > 1000 ? 'danger' : bufferLat > 500 ? 'warning' : 'success'
          }
          deltaLabel="synthetic write 10s"
          spark={snapshot.kpis.bufferLatencySpark}
          sparkStroke="#a78bfa"
          sparkLabels={bufSparkLabels}
          sparkFormat={formatLatency}
        />
        <KpiCard
          icon="solar:danger-triangle-outline"
          tile={activeIncs.length > 0 ? 'danger' : 'success'}
          title="Active Incidents"
          value={activeIncs.length}
          delta={
            activeIncs.length === 0
              ? 'All clear'
              : `${snapshot.overall.p1Count} P1 · ${snapshot.overall.p2Count} P2 · ${snapshot.overall.p3Count} P3`
          }
          deltaTone={
            snapshot.overall.p1Count > 0 ? 'danger' : activeIncs.length > 0 ? 'warning' : 'success'
          }
          deltaLabel={activeIncs.length > 0 ? 'active now' : ''}
          spark={null}
        />
      </div>

      {/* Probe latency chart */}
      <SectionHead title="Probe latency" hint="Last 30 minutes" />
      <LineChart
        title="Per-Subsystem Probe Latency"
        icon="solar:graph-outline"
        unit="ms"
        series={probeLatencySeries}
        data={probeLatencyData}
        height={240}
      />

      {/* Endpoint check throughput — user-plane readout, not a health signal. */}
      <SectionHead title="Endpoint check throughput" hint="Last 60 seconds" />
      <LineChart
        title="Checks Per Second"
        icon="solar:plug-circle-outline"
        unit="/s"
        series={[{ key: 'checksPerSec', label: 'checks/sec', color: 'var(--wd-primary)' }]}
        data={activityData}
        height={180}
      />

      {/* Heatmap */}
      <SectionHead title="Activity heatmap" hint="Last 24 hours" />
      <Heatmap
        rows={snapshot.heatmap.rows}
        labels={snapshot.heatmap.labels}
        bucketMinutes={snapshot.heatmap.bucketMinutes}
        cadenceById={cadenceById}
      />

      {/* Topology */}
      <SectionHead title="Data flow" />
      <Topology
        nodes={snapshot.topology.nodes}
        edges={snapshot.topology.edges}
        pulsingEdges={edgePulses}
      />

      {/* Subsystem grid */}
      <SectionHead
        title="Subsystems"
        hint={`${snapshot.subsystems.length} components`}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {snapshot.subsystems.map((sub) => (
          <SubsystemCard
            key={sub.id}
            sub={sub}
            onRunProbe={(s) => void runProbe(s)}
            isProbing={probingId === sub.id}
          />
        ))}
      </div>

      {/* Active incidents */}
      <SectionHead
        title="Incidents · active"
        hint={`${activeIncs.length} open · ${snapshot.overall.p1Count} P1 · ${snapshot.overall.p2Count} P2 · ${snapshot.overall.p3Count} P3`}
      />
      <div className="flex flex-col gap-2.5">
        {activeIncs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-wd-border/60 py-6 text-center text-xs text-wd-muted">
            No active incidents. All clear.
          </div>
        ) : (
          activeIncs.map((inc) => <IncidentRow key={inc.id} inc={inc} />)
        )}
      </div>

      {/* Resolved */}
      {resolvedIncs.length > 0 && (
        <>
          <SectionHead title="Recently resolved" hint="last 24h" />
          <div className="flex flex-col gap-2.5">
            {resolvedIncs.map((inc) => (
              <IncidentRow key={inc.id} inc={inc} />
            ))}
          </div>
        </>
      )}

      <div className="h-6" />
    </div>
  )
}
