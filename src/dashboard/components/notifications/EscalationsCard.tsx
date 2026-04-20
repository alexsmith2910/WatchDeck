/**
 * Half-width "Upcoming escalations" card.
 *
 * Lists pending escalations sorted by fire time with a live-updating countdown.
 * Clicking the card row navigates to the incident. A small countdown ticker
 * re-renders every second so the text stays accurate without re-fetching.
 */
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { Link } from 'react-router-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from '@heroui/react'
import type { ApiChannel, ApiScheduledEscalation } from '../../types/notifications'
import { formatCountdown } from './notificationHelpers'

interface Props {
  escalations: ApiScheduledEscalation[]
  channels: ApiChannel[]
  endpointNameById: Map<string, string>
}

const CAP = 3

export function EscalationsCard({ escalations, channels, endpointNameById }: Props) {
  const [, tick] = useState(0)
  const [showAll, setShowAll] = useState(false)

  // Live countdown — re-render once a second.
  useEffect(() => {
    if (escalations.length === 0) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [escalations.length])

  const channelName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of channels) m.set(c._id, c.name)
    return m
  }, [channels])

  const sorted = useMemo(
    () => [...escalations].sort((a, b) => new Date(a.firesAt).getTime() - new Date(b.firesAt).getTime()),
    [escalations],
  )

  const visible = showAll ? sorted : sorted.slice(0, CAP)
  const hidden = sorted.length - visible.length
  const next = sorted[0]

  const sub = sorted.length === 0
    ? 'No escalations scheduled. Unacknowledged incidents will appear here.'
    : `Next fires in ${formatCountdown(next.firesAt)}. Acknowledge the incident to cancel.`

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-7 w-7 rounded-lg bg-wd-warning/15 text-wd-warning flex items-center justify-center shrink-0">
            <Icon icon="solar:alarm-outline" width={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground leading-tight">
              Upcoming Escalations
            </div>
            <div className="text-[11px] text-wd-muted mt-0.5">{sub}</div>
          </div>
        </div>
        <span className="text-[11px] text-wd-muted font-mono shrink-0">
          {sorted.length} pending
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-[12px] text-wd-muted">
          All clear.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((e) => (
            <EscalationRow
              key={`${e.incidentId}:${e.channelId}`}
              escalation={e}
              channelLabel={channelName.get(e.channelId) ?? e.channelId.slice(0, 6)}
              endpointLabel={endpointNameById.get(e.endpointId) ?? e.endpointId.slice(0, 6)}
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

function EscalationRow({
  escalation,
  channelLabel,
  endpointLabel,
}: {
  escalation: ApiScheduledEscalation
  channelLabel: string
  endpointLabel: string
}) {
  return (
    <Link
      to={`/incidents/${escalation.incidentId}`}
      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-wd-border/30 bg-wd-surface-hover/30 hover:bg-wd-surface-hover/60 px-3 py-2 transition-colors"
    >
      <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-wd-warning bg-wd-warning/10 border border-wd-warning/20 rounded-md px-2 py-1 font-mono">
        <Icon icon="solar:alarm-outline" width={16} />
        {formatCountdown(escalation.firesAt)}
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] text-foreground truncate">{endpointLabel}</div>
        <div className="text-[11px] text-wd-muted truncate">
          will ping <code className="font-mono">{channelLabel}</code>
        </div>
      </div>
      <Tooltip delay={200} closeDelay={0}>
        <TooltipTrigger>
          <span className="text-wd-muted">
            <Icon icon="solar:alt-arrow-right-outline" width={16} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-[11px] px-2 py-1">
          Fires {new Date(escalation.firesAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>
    </Link>
  )
}
