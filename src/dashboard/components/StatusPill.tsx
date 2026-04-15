import { useRef, useCallback, useState } from 'react'
import { Chip, Separator, Popover } from '@heroui/react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import { useNavigate } from 'react-router-dom'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveIncident {
  name: string
  detail: string
  duration: string
}

interface StatusPillProps {
  healthyCount: number
  totalCount: number
  uptimePercent: number
  uptimeChange?: number
  avgLatencyMs: number
  latencyChange?: number
  incidentCount: number
  activeIncident?: ActiveIncident
  lastUpdated?: string
}

// ---------------------------------------------------------------------------
// Hover popup content
// ---------------------------------------------------------------------------

function StatusPopup({
  healthyCount,
  totalCount,
  uptimePercent,
  uptimeChange,
  avgLatencyMs,
  latencyChange,
  incidentCount,
  activeIncident,
  lastUpdated,
  onNavigate,
}: StatusPillProps & { onNavigate: (path: string) => void }) {
  const downCount = totalCount - healthyCount
  const allHealthy = downCount === 0
  const statusLabel = allHealthy ? 'Operational' : 'Degraded'
  const statusColor = allHealthy ? 'text-wd-success' : 'text-wd-warning'
  const dotColor = allHealthy ? 'bg-wd-success' : 'bg-wd-warning'

  return (
    <div className="w-72">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">System Status</span>
          <span className="text-[10px] text-wd-muted/50">24h</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} />
          <span className={cn('text-[11px] font-medium', statusColor)}>{statusLabel}</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div
          className="rounded-lg bg-wd-surface-hover/60 px-3 py-2 cursor-pointer hover:bg-wd-surface-hover transition-colors"
          onClick={() => onNavigate('/endpoints')}
        >
          <div className="text-[10px] text-wd-muted mb-0.5">Endpoints</div>
          <div className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground">
            {totalCount}
            <span className="text-[10px] font-medium text-wd-success">{healthyCount} up</span>
            {downCount > 0 && (
              <span className="text-[10px] font-medium text-wd-danger">{downCount} down</span>
            )}
          </div>
        </div>

        <div className="rounded-lg bg-wd-surface-hover/60 px-3 py-2">
          <div className="text-[10px] text-wd-muted mb-0.5">Uptime 24h</div>
          <div className="flex items-baseline gap-1.5 text-sm font-semibold">
            <span className={uptimePercent >= 99 ? 'text-wd-success' : uptimePercent >= 95 ? 'text-wd-warning' : 'text-wd-danger'}>
              {uptimePercent}%
            </span>
            {uptimeChange != null && (
              <span className={cn('text-[10px] font-medium', uptimeChange >= 0 ? 'text-wd-success' : 'text-wd-danger')}>
                {uptimeChange >= 0 ? '+' : ''}{uptimeChange}%
              </span>
            )}
          </div>
        </div>

        <div className="rounded-lg bg-wd-surface-hover/60 px-3 py-2">
          <div className="text-[10px] text-wd-muted mb-0.5">Avg response</div>
          <div className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground">
            {avgLatencyMs}
            <span className="text-[10px] font-normal text-wd-muted">ms</span>
            {latencyChange != null && (
              <span className={cn('text-[10px] font-medium', latencyChange <= 0 ? 'text-wd-success' : 'text-wd-danger')}>
                {latencyChange > 0 ? '+' : ''}{latencyChange}ms
              </span>
            )}
          </div>
        </div>

        <div
          className="rounded-lg bg-wd-surface-hover/60 px-3 py-2 cursor-pointer hover:bg-wd-surface-hover transition-colors"
          onClick={() => onNavigate('/incidents')}
        >
          <div className="text-[10px] text-wd-muted mb-0.5">Incidents</div>
          <div className="flex items-baseline gap-1.5 text-sm font-semibold">
            <span className={incidentCount > 0 ? 'text-wd-danger' : 'text-foreground'}>
              {incidentCount}
            </span>
            {activeIncident && (
              <span className="text-[10px] font-medium text-wd-danger">{activeIncident.name}</span>
            )}
          </div>
        </div>
      </div>

      {/* Active incident */}
      {activeIncident && (
        <div className="mb-3">
          <div className="text-[10px] text-wd-muted mb-1.5">Active incident</div>
          <div
            className="flex items-center gap-2.5 rounded-lg bg-wd-danger/5 border border-wd-danger/10 px-3 py-2 cursor-pointer hover:bg-wd-danger/8 transition-colors"
            onClick={() => onNavigate('/incidents')}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-wd-danger shrink-0 animate-pulse" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">{activeIncident.name}</div>
              <div className="text-[10px] text-wd-muted truncate">{activeIncident.detail}</div>
            </div>
            <span className="text-[10px] text-wd-muted shrink-0">{activeIncident.duration}</span>
          </div>
        </div>
      )}

      {/* Footer */}
      <Separator className="!bg-wd-border/50 mb-2" />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-wd-muted/60">
          {lastUpdated ?? 'Updated just now'}
        </span>
        <span
          className="text-[10px] text-wd-primary font-medium cursor-pointer hover:underline"
          onClick={() => onNavigate('/health')}
        >
          View details &rarr;
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatusPill
// ---------------------------------------------------------------------------

export default function StatusPill(props: StatusPillProps) {
  const {
    healthyCount,
    totalCount,
    uptimePercent,
    avgLatencyMs,
    incidentCount,
  } = props

  const navigate = useNavigate()
  const allHealthy = healthyCount === totalCount
  const uptimeColor = uptimePercent >= 99 ? 'text-wd-success' : uptimePercent >= 95 ? 'text-wd-warning' : 'text-wd-danger'

  // Hover state with close delay
  const [isOpen, setIsOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const open = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setIsOpen(true)
  }, [])

  const scheduleClose = useCallback(() => {
    closeTimer.current = setTimeout(() => setIsOpen(false), 300)
  }, [])

  return (
    <div onMouseEnter={open} onMouseLeave={scheduleClose}>
      <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger className="!inline-flex">
          <div className="flex items-center gap-1 rounded-full border border-wd-border/50 bg-wd-surface-hover/30 px-1.5 py-1 cursor-default">
            {/* Endpoint health */}
            <Chip
              size="sm"
              className={cn(
                '!h-auto !min-h-0 !rounded-full !px-2.5 !py-0.5 !text-[11px] border',
                allHealthy
                  ? '!bg-wd-success/10 !border-wd-success/15'
                  : '!bg-wd-warning/10 !border-wd-warning/15',
              )}
            >
              <Chip.Label className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'h-[5px] w-[5px] rounded-full shrink-0',
                    allHealthy ? 'bg-wd-success' : 'bg-wd-warning',
                  )}
                />
                <span>
                  <span className={cn('!font-medium', allHealthy ? '!text-wd-success' : '!text-wd-warning')}>
                    {healthyCount}
                  </span>
                  <span className="!text-wd-muted/40">/</span>
                  <span className="!text-wd-muted">{totalCount}</span>
                </span>
              </Chip.Label>
            </Chip>

            <div className="w-px self-stretch bg-wd-border/50 mx-0.5" />

            {/* Uptime */}
            <div className="flex items-center gap-1.5 px-2.5 py-0.5">
              <Icon icon="solar:clock-circle-outline" width={14} className="text-wd-muted" />
              <span className={cn('text-[11px] font-medium', uptimeColor)}>
                {uptimePercent}%
              </span>
            </div>

            <div className="w-px self-stretch bg-wd-border/50 mx-0.5" />

            {/* Avg latency */}
            <div className="flex items-center gap-1.5 px-2.5 py-0.5">
              <Icon icon="solar:graph-outline" width={14} className="text-wd-muted" />
              <span className="text-[11px] text-wd-muted">
                {avgLatencyMs}
                <span className="text-[9px] text-wd-muted/60">ms</span>
              </span>
            </div>

            {incidentCount > 0 && (
              <>
                <div className="w-px self-stretch bg-wd-border/50 mx-0.5" />

                {/* Incidents */}
                <Chip
                  size="sm"
                  className="!h-auto !min-h-0 !rounded-full !px-2.5 !py-0.5 !text-[11px] !bg-wd-danger/8 !border !border-wd-danger/12"
                >
                  <Chip.Label className="flex items-center gap-1.5">
                    <Icon icon="solar:danger-triangle-outline" width={14} className="!text-wd-danger" />
                    <span className="!text-wd-danger !font-medium">{incidentCount}</span>
                  </Chip.Label>
                </Chip>
              </>
            )}
          </div>
        </Popover.Trigger>

        <Popover.Content
          placement="bottom"
          offset={8}
          className="!rounded-xl !border !border-wd-border !bg-wd-surface !shadow-lg"
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
        >
          <Popover.Dialog className="!p-3 !outline-none">
            <StatusPopup {...props} onNavigate={(path) => { setIsOpen(false); navigate(path) }} />
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  )
}
