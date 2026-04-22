/**
 * Channels grid — one card per configured channel with a 24h sparkline and
 * inline Test / Pause-Resume / View-log actions.
 *
 * Wiring note: we reuse the existing ChannelEditModal for add + edit. The
 * card's primary icon slot navigates there; the action row covers everyday
 * operations (test / pause / filter log).
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Dropdown,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../../hooks/useApi'
import { toast } from '../../ui/toast'
import { WideSpark } from '../health/HealthCharts'
import type {
  ApiChannel,
  ApiNotificationLogRow,
  ApiNotificationStats,
  SeverityFilter,
} from '../../types/notifications'
import { CHANNEL_TYPE_ICON, CHANNEL_TYPE_LABEL } from '../../types/notifications'

const SEVERITY_FILTER_LABEL: Record<SeverityFilter, string> = {
  'info+':    'Info+',
  'warning+': 'Warning+',
  'critical': 'Critical',
}

const SEVERITY_FILTER_TONE: Record<SeverityFilter, ChipTone> = {
  'info+':    'primary',
  'warning+': 'warning',
  'critical': 'danger',
}
import {
  channelSparkline,
  channelTargetLabel,
  deriveChannelStatus,
  formatRelative,
  latencyP95ByChannel,
  statsByChannel,
  type ChannelUiStatus,
} from './notificationHelpers'
import { ChannelEditModal } from './ChannelEditModal'

interface Props {
  channels: ApiChannel[]
  stats: ApiNotificationStats | null
  recentLog: ApiNotificationLogRow[]
  onChanged: () => void
  onFilterByChannel: (channelId: string) => void
}

const STATUS_STYLE: Record<ChannelUiStatus, { label: string; chip: string; card: string; spark: string }> = {
  healthy: {
    label: 'Delivering',
    chip: 'bg-wd-success/15 text-wd-success',
    card: 'border-wd-border/50',
    spark: 'var(--wd-success)',
  },
  degraded: {
    label: 'Degraded',
    chip: 'bg-wd-warning/15 text-wd-warning',
    card: 'border-wd-warning/30',
    spark: 'var(--wd-warning)',
  },
  failing: {
    label: 'Failing',
    chip: 'bg-wd-danger/15 text-wd-danger',
    card: 'border-wd-danger/30',
    spark: 'var(--wd-danger)',
  },
  paused: {
    label: 'Paused',
    chip: 'bg-wd-paused/15 text-wd-paused',
    card: 'border-wd-border/40 bg-wd-surface/70',
    spark: 'var(--wd-paused)',
  },
}

export function ChannelsGrid({ channels, stats, recentLog, onChanged, onFilterByChannel }: Props) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApiChannel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ApiChannel | null>(null)

  const byChannel = useMemo(() => statsByChannel(stats), [stats])
  const p95ByChannel = useMemo(() => latencyP95ByChannel(recentLog), [recentLog])
  const lastByChannel = useMemo(() => {
    const m = new Map<string, ApiNotificationLogRow>()
    for (const r of recentLog) {
      const existing = m.get(r.channelId)
      if (!existing || new Date(r.sentAt) > new Date(existing.sentAt)) m.set(r.channelId, r)
    }
    return m
  }, [recentLog])

  // Shared 24h × 24-bucket time labels for every channel sparkline tooltip.
  const sparkLabels = useMemo(() => {
    const windowMs = 24 * 60 * 60 * 1000
    const bucketCount = 24
    const step = windowMs / bucketCount
    const start = Date.now() - windowMs
    return Array.from({ length: bucketCount }, (_, i) =>
      new Date(start + i * step).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    )
  }, [recentLog])

  if (channels.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-wd-border/60 bg-wd-surface p-8 text-center">
        <Icon icon="solar:bell-off-linear" width={28} className="mx-auto text-wd-muted mb-2" />
        <p className="text-sm text-foreground font-medium mb-1">No channels configured</p>
        <p className="text-xs text-wd-muted mb-4">Set up your first one to start receiving alerts.</p>
        <Button
          size="sm"
          className="!text-xs !bg-wd-primary !text-white"
          onPress={() => { setEditing(null); setModalOpen(true) }}
        >
          <Icon icon="solar:add-square-linear" width={16} /> Create Channel
        </Button>
        <ChannelEditModal
          open={modalOpen}
          channel={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => onChanged()}
          onDeleted={() => onChanged()}
        />
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {channels.map((ch) => {
          const chStats = byChannel.get(ch._id)
          const status = deriveChannelStatus(ch, chStats, p95ByChannel.get(ch._id))
          const lastLog = lastByChannel.get(ch._id) ?? null
          const spark = channelSparkline(recentLog, ch._id, 24 * 60 * 60 * 1000, 24)
          return (
            <ChannelCard
              key={ch._id}
              channel={ch}
              status={status}
              sent24h={chStats?.sent ?? 0}
              failed24h={chStats?.failed ?? 0}
              suppressed24h={chStats?.suppressed ?? 0}
              lastLog={lastLog}
              sparkData={spark}
              sparkLabels={sparkLabels}
              onEdit={() => { setEditing(ch); setModalOpen(true) }}
              onDelete={() => setDeleteTarget(ch)}
              onChanged={onChanged}
              onFilterByChannel={onFilterByChannel}
            />
          )
        })}
      </div>

      <ChannelEditModal
        open={modalOpen}
        channel={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => { onChanged(); setModalOpen(false) }}
        onDeleted={() => { onChanged(); setModalOpen(false) }}
      />

      <DeleteChannelModal
        channel={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => { onChanged(); setDeleteTarget(null) }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation modal
// ---------------------------------------------------------------------------

function DeleteChannelModal({
  channel,
  onClose,
  onDeleted,
}: {
  channel: ApiChannel | null
  onClose: () => void
  onDeleted: () => void
}) {
  const { request } = useApi()
  const [deleting, setDeleting] = useState(false)

  if (!channel) return null

  async function confirm() {
    if (!channel) return
    setDeleting(true)
    try {
      const res = await request(`/notifications/channels/${channel._id}`, { method: 'DELETE' })
      if (res.status >= 400) {
        toast.error('Delete failed', { description: `HTTP ${res.status}` })
        return
      }
      toast.success('Channel deleted', { description: channel.name })
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-wd-surface border border-wd-border rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-wd-danger/10 p-2">
            <Icon icon="solar:trash-bin-minimalistic-linear" width={24} className="text-wd-danger" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Delete Channel</h3>
            <p className="text-xs text-wd-muted">This action cannot be undone</p>
          </div>
        </div>

        <p className="text-sm text-wd-muted mb-1">
          Delete <span className="font-medium text-foreground">{channel.name}</span>?
        </p>
        <p className="text-xs text-wd-muted/60 mb-6">
          Future alerts routed to this channel will be dropped. Past delivery-log entries are preserved.
        </p>

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="bordered" className="!text-xs" onPress={onClose} isDisabled={deleting}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="!text-xs !bg-wd-danger !text-white"
            onPress={() => void confirm()}
            isDisabled={deleting}
          >
            {deleting ? (
              <Spinner size="sm" />
            ) : (
              <>
                <Icon icon="solar:trash-bin-minimalistic-linear" width={16} />
                Delete Channel
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChannelCard({
  channel,
  status,
  sent24h,
  failed24h,
  suppressed24h,
  lastLog,
  sparkData,
  sparkLabels,
  onEdit,
  onDelete,
  onChanged,
  onFilterByChannel,
}: {
  channel: ApiChannel
  status: ChannelUiStatus
  sent24h: number
  failed24h: number
  suppressed24h: number
  lastLog: ApiNotificationLogRow | null
  sparkData: number[]
  sparkLabels: string[]
  onEdit: () => void
  onDelete: () => void
  onChanged: () => void
  onFilterByChannel: (id: string) => void
}) {
  const { request } = useApi()
  const [busy, setBusy] = useState<'test' | 'pause' | null>(null)
  const style = STATUS_STYLE[status]

  async function sendTest() {
    setBusy('test')
    try {
      const res = await request<{ data: { ok: boolean; reason?: string } }>(
        `/notifications/channels/${channel._id}/test`,
        { method: 'POST' },
      )
      if (res.data?.data?.ok) toast.success('Test dispatched', { description: channel.name })
      else toast.error('Test failed', { description: res.data?.data?.reason ?? `HTTP ${res.status}` })
    } catch (e) {
      toast.error('Test failed', { description: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setBusy(null)
    }
  }

  async function togglePause() {
    setBusy('pause')
    try {
      await request(`/notifications/channels/${channel._id}`, {
        method: 'PUT',
        body: { enabled: !channel.enabled },
      })
      toast.success(channel.enabled ? 'Channel paused' : 'Channel resumed', { description: channel.name })
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const dispatchedWhen = lastLog ? formatRelative(lastLog.sentAt) : 'never'
  const targetLabel = channelTargetLabel(channel)

  return (
    <div
      className={cn(
        'rounded-xl border bg-wd-surface p-4 flex flex-col gap-3 min-w-0 transition-colors hover:bg-wd-surface-hover/30',
        style.card,
      )}
    >
      {/* Header — logo, name+target, status chip, overflow menu */}
      <div className="flex items-start gap-3 min-w-0">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-wd-surface-hover text-foreground hover:bg-wd-surface-hover/80 transition-colors"
          aria-label={`Edit ${channel.name}`}
        >
          <Icon icon={CHANNEL_TYPE_ICON[channel.type]} width={20} />
        </button>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onEdit}
            className="text-sm font-semibold text-foreground truncate hover:text-wd-primary transition-colors block w-full text-left"
          >
            {channel.name}
          </button>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-wd-muted min-w-0">
            <span>{CHANNEL_TYPE_LABEL[channel.type]}</span>
            <span className="w-1 h-1 rounded-full bg-wd-muted/40 shrink-0" />
            <span className="truncate font-mono">{targetLabel}</span>
          </div>
        </div>
        <span className={cn('text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 self-start mt-0.5', style.chip)}>
          {style.label}
        </span>
        <Dropdown>
          <Dropdown.Trigger>
            <div
              role="button"
              aria-label="Channel menu"
              tabIndex={0}
              className="h-7 w-7 rounded-md flex items-center justify-center text-wd-muted hover:text-foreground hover:bg-wd-surface-hover/60 shrink-0 transition-colors cursor-pointer"
            >
              <Icon icon="solar:menu-dots-bold" width={16} />
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end" className="!min-w-[160px]">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === 'edit') onEdit()
                else if (key === 'delete') onDelete()
              }}
            >
              <Dropdown.Item id="edit" className="!text-xs">
                <Icon icon="solar:pen-linear" width={16} className="mr-1.5" />
                Edit Channel
              </Dropdown.Item>
              <Dropdown.Item id="delete" className="!text-xs !text-wd-danger">
                <Icon icon="solar:trash-bin-minimalistic-linear" width={16} className="mr-1.5" />
                Delete Channel
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-2">
        <Metric label="Sent · 24h" value={sent24h.toLocaleString()} />
        <Metric
          label="Failed"
          value={String(failed24h)}
          tone={failed24h > 5 ? 'danger' : failed24h > 0 ? 'warning' : 'default'}
        />
        <Metric label="Suppressed" value={String(suppressed24h)} tone="muted" />
        <Metric label="Last" value={dispatchedWhen} tone="muted" />
      </div>

      {/* Sparkline */}
      {sparkData.some((v) => v > 0) ? (
        <WideSpark
          data={sparkData}
          color={style.spark}
          height={32}
          labels={sparkLabels}
          formatValue={(n) => `${n} ${n === 1 ? 'event' : 'events'}`}
        />
      ) : (
        <div className="h-8 rounded-md bg-wd-surface-hover/40 flex items-center justify-center text-[10px] text-wd-muted">
          No traffic in 24h
        </div>
      )}

      {/* Rules + actions */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-wd-border/30">
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <Chip
            icon="solar:tuning-2-outline"
            tone={SEVERITY_FILTER_TONE[channel.severityFilter]}
          >
            {SEVERITY_FILTER_LABEL[channel.severityFilter]}
          </Chip>
          <Chip
            icon={channel.deliveryPriority === 'critical' ? 'solar:danger-circle-bold' : 'solar:flag-outline'}
            tone={channel.deliveryPriority === 'critical' ? 'danger' : 'muted'}
          >
            {channel.deliveryPriority === 'critical' ? 'Critical' : 'Standard'}
          </Chip>
          {channel.rateLimit && (
            <Chip icon="solar:bolt-outline" tone="muted"><span className="font-mono">{channel.rateLimit.maxPerMinute}/min</span></Chip>
          )}
          {channel.quietHours && (
            <Chip icon="solar:moon-outline" tone="muted">
              <span className="font-mono">{channel.quietHours.start}–{channel.quietHours.end}</span>
            </Chip>
          )}
          {!channel.retryOnFailure && (
            <Chip icon="solar:refresh-circle-outline" tone="warning">No retry</Chip>
          )}
          <EventFilterChip channel={channel} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconAction
            icon={busy === 'test' ? 'solar:refresh-outline' : 'solar:play-circle-outline'}
            title="Send test notification"
            onClick={sendTest}
            disabled={busy !== null}
            spinning={busy === 'test'}
          />
          <IconAction
            icon={channel.enabled ? 'solar:pause-circle-outline' : 'solar:play-circle-bold'}
            title={channel.enabled ? 'Pause channel' : 'Resume channel'}
            onClick={togglePause}
            disabled={busy !== null}
            spinning={busy === 'pause'}
          />
          <IconAction
            icon="solar:clipboard-text-outline"
            title="Filter delivery log by this channel"
            onClick={() => onFilterByChannel(channel._id)}
          />
        </div>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'muted' | 'warning' | 'danger'
}) {
  const color =
    tone === 'danger'
      ? 'text-wd-danger'
      : tone === 'warning'
        ? 'text-wd-warning'
        : tone === 'muted'
          ? 'text-wd-muted'
          : 'text-foreground'
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-medium uppercase tracking-wider text-wd-muted/80 truncate">
        {label}
      </span>
      <span className={cn('text-sm font-semibold font-mono truncate', color)}>
        {value}
      </span>
    </div>
  )
}

type ChipTone = 'muted' | 'primary' | 'warning' | 'danger' | 'success'

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  muted:   'bg-wd-surface-hover/50 text-wd-muted border-wd-border/40',
  primary: 'bg-wd-primary/10 text-wd-primary border-wd-primary/25',
  warning: 'bg-wd-warning/10 text-wd-warning border-wd-warning/25',
  danger:  'bg-wd-danger/10 text-wd-danger border-wd-danger/25',
  success: 'bg-wd-success/10 text-wd-success border-wd-success/25',
}

function Chip({
  icon,
  tone = 'muted',
  children,
}: {
  icon: string
  tone?: ChipTone
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium',
        CHIP_TONE_CLASS[tone],
      )}
    >
      <Icon icon={icon} width={16} />
      {children}
    </span>
  )
}

function EventFilterChip({ channel }: { channel: ApiChannel }) {
  const f = channel.eventFilters
  const all = f.sendOpen && f.sendResolved && f.sendEscalation
  if (all) return null
  const parts: string[] = []
  if (f.sendOpen) parts.push('Open')
  if (f.sendResolved) parts.push('Resolved')
  if (f.sendEscalation) parts.push('Escalation')
  if (parts.length === 0) {
    return <Chip icon="solar:bell-off-outline" tone="warning">No events</Chip>
  }
  return (
    <Chip icon="solar:filter-outline" tone="muted">
      Only {parts.join(' · ')}
    </Chip>
  )
}

function IconAction({
  icon,
  title,
  onClick,
  disabled,
  spinning,
}: {
  icon: string
  title: string
  onClick: () => void | Promise<void>
  disabled?: boolean
  spinning?: boolean
}) {
  return (
    <Tooltip delay={200} closeDelay={0}>
      <TooltipTrigger>
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={disabled}
          aria-label={title}
          className="h-7 w-7 rounded-md flex items-center justify-center text-wd-muted hover:text-foreground hover:bg-wd-surface-hover/60 disabled:opacity-50 transition-colors"
        >
          <Icon icon={icon} width={16} className={spinning ? 'animate-spin' : ''} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-[11px] px-2 py-1">{title}</TooltipContent>
    </Tooltip>
  )
}
