import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  Button,
  Spinner,
  ToggleButton,
  ToggleButtonGroup,
  cn,
} from '@heroui/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'
import {
  Heatmap,
  LineChart,
  Sparkline,
  StatusPill,
  Topology,
  WideSpark,
} from '../components/health/HealthCharts'
import type {
  InternalIncident,
  OverallStateKey,
  SubsystemSnapshot,
  SubsystemStatus,
  SystemHealthSnapshot,
  TimeRangeKey,
} from '../types/systemHealth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIME_RANGES: Array<{ key: TimeRangeKey; label: string }> = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
]

function sparkColor(status: SubsystemStatus): string {
  if (status === 'down') return 'var(--wd-danger)'
  if (status === 'degraded') return 'var(--wd-warning)'
  return 'var(--wd-primary)'
}

function tileClasses(tile: 'primary' | 'success' | 'warning' | 'danger'): string {
  switch (tile) {
    case 'primary':
      return 'bg-wd-primary/15 text-wd-primary'
    case 'success':
      return 'bg-wd-success/15 text-wd-success'
    case 'warning':
      return 'bg-wd-warning/15 text-wd-warning'
    case 'danger':
      return 'bg-wd-danger/15 text-wd-danger'
  }
}

function formatElapsed(startedMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatStarted(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatUpdatedAgo(sec: number): string {
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
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
          label="Active incidents"
          value={String(overall.activeIncidents)}
          unit={overall.p1Count > 0 ? ` · ${overall.p1Count} P1` : ''}
        />
        <BannerMetric label="Error budget" value={String(overall.errorBudget)} unit="% left" />
        <BannerMetric label="Uptime (30d)" value={overall.uptime30d.toFixed(2)} unit="%" />
      </div>
      <div className="inline-flex items-center gap-2 rounded-full border border-wd-border/50 bg-wd-surface-hover/40 px-3 py-1.5 text-[11px] text-wd-muted font-mono tabular-nums">
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
      <span className="text-[15px] font-semibold font-mono tabular-nums text-foreground">
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
          <Icon icon={icon} width={14} />
        </div>
        <div className="text-xs font-medium text-wd-muted">{title}</div>
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold font-mono tabular-nums tracking-tight text-foreground">
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
        <div className="mt-auto">
          <WideSpark data={spark} color={sparkStroke ?? 'var(--wd-primary)'} height={46} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subsystem card
// ---------------------------------------------------------------------------

function SubsystemCard({
  sub,
  onRestart,
}: {
  sub: SubsystemSnapshot
  onRestart: (sub: SubsystemSnapshot) => void
}) {
  const totalWorkers = sub.workers.up + sub.workers.warn + sub.workers.down
  const iconBg =
    sub.status === 'healthy'
      ? 'bg-wd-surface-hover/70 text-foreground'
      : sub.status === 'degraded'
        ? 'bg-wd-warning/15 text-wd-warning'
        : 'bg-wd-danger/15 text-wd-danger'

  const cardBorder =
    sub.status === 'healthy'
      ? 'border-wd-border/50'
      : sub.status === 'degraded'
        ? 'border-wd-warning/30'
        : 'border-wd-danger/30'

  return (
    <div
      className={cn(
        'rounded-xl border bg-wd-surface p-4 flex flex-col gap-2.5 transition-colors hover:bg-wd-surface-hover/40',
        cardBorder,
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', iconBg)}>
          <Icon icon={sub.icon} width={16} />
        </div>
        <div className="text-sm font-semibold text-foreground truncate flex-1">{sub.title}</div>
        <StatusPill status={sub.status} />
      </div>
      <div className="text-[11px] text-wd-muted truncate">{sub.sub}</div>
      <div className="flex items-end gap-3">
        <div className="flex-1 grid grid-cols-2 gap-3">
          {sub.metrics.map((m, i) => (
            <div key={i} className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[10px] font-medium uppercase tracking-wider text-wd-muted/80 truncate">
                {m.lbl}
              </span>
              <span className="text-sm font-semibold font-mono tabular-nums text-foreground truncate">
                {m.val}
                {m.unit && <span className="ml-0.5 text-[10px] text-wd-muted font-medium">{m.unit}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="shrink-0">
          <Sparkline data={sub.sparkline} color={sparkColor(sub.status)} width={96} height={34} />
        </div>
      </div>
      <div className="flex items-center justify-between mt-1 pt-2.5 border-t border-wd-border/30">
        <div className="flex items-center gap-2 text-[11px] text-wd-muted">
          <span className="font-mono tabular-nums">
            {sub.workers.up}/{totalWorkers} workers
          </span>
          <span className="inline-flex items-center gap-0.5">
            {Array.from({ length: sub.workers.up }).map((_, i) => (
              <span key={`u${i}`} className="h-1.5 w-1.5 rounded-full bg-wd-success" />
            ))}
            {Array.from({ length: sub.workers.warn }).map((_, i) => (
              <span key={`w${i}`} className="h-1.5 w-1.5 rounded-full bg-wd-warning" />
            ))}
            {Array.from({ length: sub.workers.down }).map((_, i) => (
              <span key={`d${i}`} className="h-1.5 w-1.5 rounded-full bg-wd-danger" />
            ))}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => onRestart(sub)}
          className="!text-[11px] !h-6 !min-h-0 !px-2"
        >
          <Icon icon="solar:refresh-outline" width={12} />
          Restart
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Restart modal
// ---------------------------------------------------------------------------

function RestartModal({
  sub,
  onCancel,
  onConfirm,
}: {
  sub: SubsystemSnapshot
  onCancel: () => void
  onConfirm: () => void
}) {
  const [stage, setStage] = useState<'confirm' | 'running' | 'done'>('confirm')
  const totalWorkers = sub.workers.up + sub.workers.warn + sub.workers.down

  function go(): void {
    setStage('running')
    setTimeout(() => {
      setStage('done')
      setTimeout(onConfirm, 1100)
    }, 1600)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md mx-4 rounded-xl border border-wd-border bg-wd-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-wd-border/50">
          <h3 className="text-sm font-semibold text-foreground">
            Restart <span className="font-mono text-wd-muted font-normal">· {sub.title}</span>
          </h3>
          <button
            onClick={onCancel}
            className="text-wd-muted hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <Icon icon="solar:close-circle-outline" width={18} />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-foreground/90 space-y-3">
          {stage === 'confirm' && (
            <>
              <p>
                Rolling-restart the <strong>{sub.title}</strong> workers one at a time. Traffic is
                drained before each cycle — no user-visible impact expected.
              </p>
              <div className="flex gap-2 items-start rounded-lg border border-wd-warning/20 bg-wd-warning/5 px-3 py-2 text-[12px] text-foreground">
                <Icon
                  icon="solar:danger-triangle-outline"
                  width={14}
                  className="text-wd-warning mt-0.5 shrink-0"
                />
                <span>
                  This affects {totalWorkers} worker{totalWorkers === 1 ? '' : 's'}. Action is audited.
                </span>
              </div>
            </>
          )}
          {stage === 'running' && (
            <div className="flex items-center gap-3 py-2">
              <Spinner size="sm" />
              <span>Rolling-restart in progress…</span>
            </div>
          )}
          {stage === 'done' && (
            <div className="flex items-center gap-2 py-2 text-wd-success">
              <Icon icon="solar:check-circle-bold" width={16} />
              <span>
                <strong>Done.</strong> {sub.title} is back in rotation.
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-wd-border/50">
          {stage === 'confirm' ? (
            <>
              <Button variant="outline" size="sm" onPress={onCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={go}
                className="dark:!bg-wd-primary/50"
              >
                Rolling restart
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onPress={onCancel} isDisabled={stage === 'running'}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Incident row
// ---------------------------------------------------------------------------

function IncidentRow({
  inc,
  tick,
  onAck,
}: {
  inc: InternalIncident
  tick: number
  onAck: (inc: InternalIncident) => void
}) {
  void tick
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
      ? formatElapsed(Date.now() - inc.durationSeconds * 1000)
      : formatElapsed(inc.startedAt)

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
          'h-9 rounded-lg flex items-center justify-center text-[11px] font-semibold tracking-wider',
          severityColor,
        )}
      >
        {inc.status === 'resolved' ? (
          <Icon icon="solar:check-circle-bold" width={18} />
        ) : (
          inc.severity.toUpperCase()
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{inc.title}</span>
          {inc.status === 'active' && !inc.ack && (
            <span className="inline-flex items-center gap-1 rounded-full bg-wd-danger/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-wd-danger">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
              </span>
              Live
            </span>
          )}
          {inc.status === 'active' && inc.ack && (
            <span className="inline-flex rounded-full bg-wd-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-wd-warning">
              Ack · {inc.ack}
            </span>
          )}
          {inc.status === 'resolved' && (
            <span className="inline-flex rounded-full bg-wd-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-wd-success">
              Resolved
            </span>
          )}
        </div>
        <div className="mt-1 text-[12px] text-wd-muted truncate">{inc.cause}</div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-wd-muted font-mono tabular-nums">
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
            'text-xs font-mono tabular-nums whitespace-nowrap',
            inc.status === 'active' ? 'text-wd-danger' : 'text-wd-muted',
          )}
        >
          {duration}
        </span>
        {inc.status === 'active' && !inc.ack && (
          <Button variant="outline" size="sm" onPress={() => onAck(inc)}>
            Acknowledge
          </Button>
        )}
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

  const [range, setRange] = useState<TimeRangeKey>(
    () => (localStorage.getItem('wd-health-range') as TimeRangeKey) || '24h',
  )
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [restartTarget, setRestartTarget] = useState<SubsystemSnapshot | null>(null)
  const [runtimeTick, setRuntimeTick] = useState(0)

  useEffect(() => {
    localStorage.setItem('wd-health-range', range)
  }, [range])

  // ---- Fetch snapshot ----
  const fetchSnapshot = useCallback(
    async (opts: { showSpinner?: boolean } = {}) => {
      if (opts.showSpinner) setLoading(true)
      else setRefreshing(true)
      try {
        const res = await request<{ data: SystemHealthSnapshot }>(`/health/system?range=${range}`)
        if (res.data?.data) setSnapshot(res.data.data)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [request, range],
  )

  // Initial + range change fetch
  useEffect(() => {
    void fetchSnapshot({ showSpinner: true })
  }, [fetchSnapshot])

  // Poll every 5s for live updates
  useEffect(() => {
    const id = setInterval(() => {
      void fetchSnapshot()
    }, 5000)
    return () => clearInterval(id)
  }, [fetchSnapshot])

  // Live seconds tick for active incident durations + "updated Xs ago"
  useEffect(() => {
    const id = setInterval(() => setRuntimeTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Refresh on any incident state change
  useEffect(() => {
    const unsub1 = subscribe('incident:opened', () => void fetchSnapshot())
    const unsub2 = subscribe('incident:resolved', () => void fetchSnapshot())
    const unsub3 = subscribe('db:disconnected', () => void fetchSnapshot())
    const unsub4 = subscribe('db:reconnected', () => void fetchSnapshot())
    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
    }
  }, [subscribe, fetchSnapshot])

  async function acknowledge(inc: InternalIncident): Promise<void> {
    await request(`/health/system/incidents/${inc.id}/ack`, { method: 'POST', body: { by: 'you' } })
    void fetchSnapshot()
  }

  // Derived KPI sparks
  const sparkThroughput = useMemo(
    () => (snapshot ? snapshot.timeSeries.points.map((p) => p.throughput) : []),
    [snapshot],
  )
  const sparkLatency = useMemo(
    () => (snapshot ? snapshot.timeSeries.points.map((p) => p.latency) : []),
    [snapshot],
  )
  const sparkErrors = useMemo(
    () => (snapshot ? snapshot.timeSeries.points.map((p) => p.errors) : []),
    [snapshot],
  )

  const overallState: OverallStateKey = snapshot?.overall.state ?? 'operational'

  const activeIncs = useMemo(
    () => (snapshot ? snapshot.incidents.filter((i) => i.status === 'active') : []),
    [snapshot],
  )
  const resolvedIncs = useMemo(
    () => (snapshot ? snapshot.incidents.filter((i) => i.status === 'resolved') : []),
    [snapshot],
  )

  // Ensure live seconds tick re-reads
  void runtimeTick

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

  return (
    <div className="p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">System Health</h1>
          <div className="text-xs text-wd-muted mt-1">
            Uptime, throughput &amp; incidents across every piece of the WatchDeck pipeline.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ToggleButtonGroup
            selectionMode="single"
            selectedKeys={new Set([range])}
            onSelectionChange={(keys) => {
              const sel = [...keys][0] as TimeRangeKey | undefined
              if (sel) setRange(sel)
            }}
            size="sm"
          >
            {TIME_RANGES.map((r) => (
              <ToggleButton
                key={r.key}
                id={r.key}
                className={cn(
                  '!text-xs !px-3',
                  'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
                  'dark:data-[selected=true]:!bg-wd-primary/50',
                )}
              >
                {r.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Button
            variant="outline"
            size="sm"
            onPress={() => void fetchSnapshot({ showSpinner: false })}
            isDisabled={refreshing}
          >
            <Icon
              icon="solar:refresh-outline"
              width={14}
              className={refreshing ? 'animate-spin' : ''}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Overall banner */}
      <OverallBanner overall={snapshot.overall} lastUpdatedSeconds={snapshot.kpis.lastUpdatedSeconds} />

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon="solar:plug-circle-outline"
          tile="primary"
          title="Check throughput"
          value={snapshot.kpis.checksPerSec.toLocaleString()}
          unit="/sec"
          delta={
            overallState === 'operational'
              ? `${snapshot.kpis.checksPerSecDelta >= 0 ? '+' : ''}${snapshot.kpis.checksPerSecDelta}%`
              : `${snapshot.kpis.checksPerSecDelta >= 0 ? '+' : ''}${snapshot.kpis.checksPerSecDelta}%`
          }
          deltaTone={
            snapshot.kpis.checksPerSecDelta >= 0
              ? 'success'
              : snapshot.kpis.checksPerSecDelta > -10
                ? 'warning'
                : 'danger'
          }
          deltaLabel="vs previous minute"
          spark={sparkThroughput}
          sparkStroke="var(--wd-primary)"
        />
        <KpiCard
          icon="solar:clock-circle-outline"
          tile="warning"
          title="Scheduler queue lag"
          value={snapshot.kpis.queueLagMs}
          unit="ms"
          delta={snapshot.kpis.queueLagMs > 250 ? 'elevated' : 'steady'}
          deltaTone={snapshot.kpis.queueLagMs > 1000 ? 'danger' : snapshot.kpis.queueLagMs > 250 ? 'warning' : 'success'}
          deltaLabel="vs target ≤ 250ms"
          spark={sparkLatency}
          sparkStroke="var(--wd-warning)"
        />
        <KpiCard
          icon="solar:danger-triangle-outline"
          tile={activeIncs.length > 0 ? 'danger' : 'success'}
          title="Active incidents"
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
        <KpiCard
          icon="solar:graph-outline"
          tile={
            snapshot.kpis.errorRate > 0.5
              ? 'danger'
              : snapshot.kpis.errorRate > 0.2
                ? 'warning'
                : 'success'
          }
          title="Internal error rate"
          value={snapshot.kpis.errorRate.toFixed(2)}
          unit="%"
          delta={
            snapshot.kpis.errorRate > 0.5
              ? 'elevated'
              : snapshot.kpis.errorRate > 0.2
                ? 'mild elevation'
                : 'nominal'
          }
          deltaTone={
            snapshot.kpis.errorRate > 0.5
              ? 'danger'
              : snapshot.kpis.errorRate > 0.2
                ? 'warning'
                : 'success'
          }
          deltaLabel="over last minute"
          spark={sparkErrors}
          sparkStroke={
            snapshot.kpis.errorRate > 0.5
              ? 'var(--wd-danger)'
              : snapshot.kpis.errorRate > 0.2
                ? 'var(--wd-warning)'
                : 'var(--wd-success)'
          }
        />
      </div>

      {/* Charts */}
      <SectionHead title="Pipeline throughput" hint="Hover for exact values" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <LineChart
          title="Checks per second"
          subtitle="Aggregated across all checker runs"
          icon="solar:plug-circle-outline"
          series={[{ key: 'throughput', label: 'checks/sec', color: 'var(--wd-primary)' }]}
          data={snapshot.timeSeries.points}
          height={220}
        />
        <LineChart
          title="Internal latency"
          subtitle="p95 response time across checks"
          icon="solar:graph-outline"
          unit="ms"
          series={[{ key: 'latency', label: 'p95 (ms)', color: 'var(--wd-warning)' }]}
          data={snapshot.timeSeries.points}
          height={220}
        />
      </div>

      {/* Heatmap */}
      <SectionHead title="Error heatmap · by subsystem" hint="24 one-hour buckets" />
      <Heatmap rows={snapshot.heatmap.rows} labels={snapshot.heatmap.labels} />

      {/* Topology */}
      <SectionHead title="Data flow" hint="Topology · colors reflect current subsystem status" />
      <Topology nodes={snapshot.topology.nodes} edges={snapshot.topology.edges} />

      {/* Subsystem grid */}
      <SectionHead
        title={`Subsystems · ${snapshot.subsystems.length} components`}
        hint="Rolling restart · view"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {snapshot.subsystems.map((sub) => (
          <SubsystemCard key={sub.id} sub={sub} onRestart={(s) => setRestartTarget(s)} />
        ))}
      </div>

      {/* Active incidents */}
      <SectionHead
        title="Internal incidents · active"
        hint={`${activeIncs.length} open · ${snapshot.overall.p1Count} P1 · ${snapshot.overall.p2Count} P2 · ${snapshot.overall.p3Count} P3`}
      />
      <div className="flex flex-col gap-2.5">
        {activeIncs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-wd-border/60 py-6 text-center text-xs text-wd-muted">
            No active internal incidents. All clear.
          </div>
        ) : (
          activeIncs.map((inc) => (
            <IncidentRow key={inc.id} inc={inc} tick={runtimeTick} onAck={acknowledge} />
          ))
        )}
      </div>

      {/* Resolved */}
      {resolvedIncs.length > 0 && (
        <>
          <SectionHead title="Recently resolved" hint="last 24h" />
          <div className="flex flex-col gap-2.5">
            {resolvedIncs.map((inc) => (
              <IncidentRow key={inc.id} inc={inc} tick={runtimeTick} onAck={acknowledge} />
            ))}
          </div>
        </>
      )}

      <div className="h-6" />

      {/* Restart modal */}
      {restartTarget && (
        <RestartModal
          sub={restartTarget}
          onCancel={() => setRestartTarget(null)}
          onConfirm={() => setRestartTarget(null)}
        />
      )}
    </div>
  )
}
