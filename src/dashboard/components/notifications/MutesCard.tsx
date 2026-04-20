/**
 * Half-width "Active mutes" card. Groups mutes by scope (global → channel →
 * endpoint) and exposes unmute inline. All mutes expire automatically.
 */
import { useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button, cn } from '@heroui/react'
import { useApi } from '../../hooks/useApi'
import { toast } from '../../ui/toast'
import type {
  ApiChannel,
  ApiNotificationMute,
} from '../../types/notifications'
import { formatCountdown, formatRelative } from './notificationHelpers'

interface Props {
  mutes: ApiNotificationMute[]
  channels: ApiChannel[]
  endpointNameById: Map<string, string>
  onChanged: () => void
}

const CAP = 3

export function MutesCard({ mutes, channels, endpointNameById, onChanged }: Props) {
  const [showAll, setShowAll] = useState(false)
  const { request } = useApi()
  const [busyId, setBusyId] = useState<string | null>(null)

  const channelName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of channels) m.set(c._id, c.name)
    return m
  }, [channels])

  const sorted = useMemo(
    () => [...mutes].sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()),
    [mutes],
  )

  const visible = showAll ? sorted : sorted.slice(0, CAP)
  const hidden = sorted.length - visible.length

  const sub = sorted.length === 0
    ? 'No active mutes. Use mutes during maintenance or to silence noisy sources.'
    : `${sorted.length} ${sorted.length === 1 ? 'rule silencing alerts' : 'rules silencing alerts'} · all time-boxed.`

  async function unmute(mute: ApiNotificationMute) {
    setBusyId(mute._id)
    try {
      const res = await request(`/notifications/mutes/${mute._id}`, { method: 'DELETE' })
      if (res.status >= 400) toast.error('Unmute failed', { description: `HTTP ${res.status}` })
      else {
        toast.success('Unmuted')
        onChanged()
      }
    } finally {
      setBusyId(null)
    }
  }

  function scopeLabel(m: ApiNotificationMute): string {
    if (m.scope === 'global') return 'Global Mute'
    if (m.scope === 'channel') {
      const name = m.targetId ? channelName.get(m.targetId) : undefined
      return name ? `Channel · ${name}` : 'Channel'
    }
    const name = m.targetId ? endpointNameById.get(m.targetId) : undefined
    return name ? `Endpoint · ${name}` : 'Endpoint'
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-7 w-7 rounded-lg bg-wd-muted/15 text-wd-muted flex items-center justify-center shrink-0">
            <Icon icon="solar:bell-off-outline" width={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground leading-tight">Active Mutes</div>
            <div className="text-[11px] text-wd-muted mt-0.5">{sub}</div>
          </div>
        </div>
        <span className="text-[11px] text-wd-muted font-mono shrink-0">
          {sorted.length} total
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-[12px] text-wd-muted">
          Nothing silenced.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((m) => (
            <MuteRow
              key={m._id}
              mute={m}
              scopeLabel={scopeLabel(m)}
              busy={busyId === m._id}
              onUnmute={() => void unmute(m)}
            />
          ))}

          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-1 text-[11px] text-wd-primary hover:underline self-start"
            >
              Show {hidden} more
            </button>
          )}
          {showAll && sorted.length > CAP && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="mt-1 text-[11px] text-wd-muted hover:text-foreground self-start"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MuteRow({
  mute,
  scopeLabel,
  busy,
  onUnmute,
}: {
  mute: ApiNotificationMute
  scopeLabel: string
  busy: boolean
  onUnmute: () => void
}) {
  const scopeChipCls =
    mute.scope === 'global'
      ? 'bg-wd-danger/10 text-wd-danger border-wd-danger/20'
      : mute.scope === 'channel'
        ? 'bg-wd-primary/10 text-wd-primary border-wd-primary/20'
        : 'bg-wd-surface-hover text-wd-muted border-wd-border/40'

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-wd-border/30 bg-wd-surface-hover/30 px-3 py-2">
      <span className={cn('text-[10px] font-semibold uppercase tracking-wider rounded px-2 py-1 border font-mono', scopeChipCls)}>
        {mute.scope}
      </span>
      <div className="min-w-0">
        <div className="text-[12.5px] text-foreground truncate">{scopeLabel}</div>
        <div className="text-[11px] text-wd-muted truncate">
          {mute.reason || 'No reason given'}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0 text-[10.5px] text-wd-muted/80 font-mono">
          <span>by {mute.mutedBy}</span>
          <span>· since {formatRelative(mute.mutedAt)}</span>
          <span>· expires in {formatCountdown(mute.expiresAt)}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="!text-[11px] !h-7 !min-h-0 !px-2 !text-wd-primary"
        onPress={onUnmute}
        isDisabled={busy}
      >
        {busy ? 'Unmuting…' : 'Unmute'}
      </Button>
    </div>
  )
}
