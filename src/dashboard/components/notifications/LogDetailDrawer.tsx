/**
 * Log row detail drawer — right-side panel showing the full dispatch
 * (channel, endpoint, message, attempt history, errors) with retry for
 * failed rows. The four rich cards (payload, response, retries, reproduce
 * cURL) come from the shared `LogExpansionCards` component so this drawer
 * and the endpoint-detail accordion render identically.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Drawer, Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi'
import { toast } from '../../ui/toast'
import type {
  ApiChannel,
  ApiNotificationLogRow,
} from '../../types/notifications'
import {
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
  KIND_COLOR,
  KIND_LABEL,
  SEVERITY_STYLE,
  STATUS_STYLE,
} from '../../types/notifications'
import { LogExpansionCards } from './LogExpansionCards'

interface Props {
  row: ApiNotificationLogRow | null
  onClose: () => void
  channels: ApiChannel[]
  endpointNameById: Map<string, string>
  onRetried?: () => void
}

export function LogDetailDrawer({ row, onClose, channels, endpointNameById, onRetried }: Props) {
  // Keep the last row around so the exit animation still has content to render.
  const [lastRow, setLastRow] = useState<ApiNotificationLogRow | null>(row)
  useEffect(() => { if (row) setLastRow(row) }, [row])

  return (
    <Drawer.Backdrop
      isOpen={row !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      variant="opaque"
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog
          aria-label="Delivery detail"
          className="!w-full sm:!w-[520px] !max-w-[92vw] !p-0"
        >
          {lastRow && (
            <LogDetailContent
              row={lastRow}
              channels={channels}
              endpointNameById={endpointNameById}
              onRetried={onRetried}
              onClose={onClose}
            />
          )}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )
}

function LogDetailContent({
  row,
  channels,
  endpointNameById,
  onRetried,
  onClose,
}: {
  row: ApiNotificationLogRow
  channels: ApiChannel[]
  endpointNameById: Map<string, string>
  onRetried?: () => void
  onClose: () => void
}) {
  const { request } = useApi()
  const [retrying, setRetrying] = useState(false)

  const channel = useMemo(
    () => channels.find((c) => c._id === row.channelId) ?? null,
    [channels, row.channelId],
  )
  const st = STATUS_STYLE[row.deliveryStatus]

  async function retry() {
    setRetrying(true)
    try {
      const res = await request(`/notifications/log/${row._id}/retry`, { method: 'POST' })
      if (res.status >= 400) {
        toast.error('Retry failed', { description: `HTTP ${res.status}` })
      } else {
        toast.success('Retry dispatched', { description: row.messageSummary })
        onRetried?.()
        onClose()
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-wd-surface">
      <Drawer.Header className="!px-5 !py-4 !border-b !border-wd-border/60 !flex !items-start !gap-3">
        <div className="flex-1 min-w-0">
          <Drawer.Heading className="!text-sm !font-semibold !text-foreground !leading-snug">
            {row.messageSummary}
          </Drawer.Heading>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
            <SeverityBadge severity={row.severity} />
            <span className={cn('inline-block text-[10px] font-medium rounded px-1.5 py-0.5', st.className)}>
              {st.label}
            </span>
            <span className={cn('text-[10px] font-semibold uppercase tracking-wider', KIND_COLOR[row.kind])}>
              {KIND_LABEL[row.kind]}
            </span>
            <span className="text-[11px] text-wd-muted/60">·</span>
            <span className="text-[11px] text-wd-muted font-mono">
              {new Date(row.sentAt).toLocaleString()}
            </span>
          </div>
        </div>
        <Drawer.CloseTrigger className="!h-7 !w-7 !rounded-md !text-wd-muted hover:!text-foreground hover:!bg-wd-surface-hover/60 !shrink-0">
          <Icon icon="solar:close-circle-linear" width={20} />
        </Drawer.CloseTrigger>
      </Drawer.Header>

      <Drawer.Body className="!flex-1 !overflow-y-auto !px-5 !py-4 !flex !flex-col !gap-4 wd-scroll-thin">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Field label="Channel">
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <Icon icon={CHANNEL_TYPE_ICON[row.channelType]} width={16} />
              <span className="truncate">
                {channel?.name ?? `${CHANNEL_TYPE_LABEL[row.channelType]} · ${row.channelTarget}`}
              </span>
            </span>
          </Field>
          <Field label="Endpoint">
            {row.endpointId ? (
              <Link to={`/endpoints/${row.endpointId}`} className="text-wd-primary hover:underline truncate">
                {endpointNameById.get(row.endpointId) ?? <span className="font-mono">{row.endpointId.slice(0, 6)}</span>}
              </Link>
            ) : (
              <span className="text-wd-muted">—</span>
            )}
          </Field>
          {row.incidentId && (
            <Field label="Incident">
              <Link to={`/incidents/${row.incidentId}`} className="text-wd-primary hover:underline truncate">
                View Incident
              </Link>
            </Field>
          )}
          {typeof row.latencyMs === 'number' && (
            <Field label="Latency">
              <span className="text-foreground font-mono">{row.latencyMs}ms</span>
            </Field>
          )}
        </div>

        {row.deliveryStatus === 'failed' && row.failureReason && (
          <Callout tone="danger" title="Provider error">
            <pre className="text-[11px] text-wd-danger/90 whitespace-pre-wrap break-words font-mono">
              {row.failureReason}
            </pre>
          </Callout>
        )}

        {row.deliveryStatus === 'suppressed' && row.suppressedReason && (
          <Callout tone="warning" title="Silenced by rule">
            <div className="text-[11px] text-wd-warning/90 capitalize">
              {row.suppressedReason.replace(/_/g, ' ')}
            </div>
          </Callout>
        )}

        {(row.coalescedCount ?? 0) > 1 && (
          <Callout tone="primary" title="Coalesced summary">
            <div className="text-[11px] text-wd-muted">
              Represents {row.coalescedCount} alerts
              {row.coalescedIncidentIds && ` across ${row.coalescedIncidentIds.length} incidents`}.
            </div>
          </Callout>
        )}

        <LogExpansionCards row={row} channel={channel} />
      </Drawer.Body>

      {row.deliveryStatus === 'failed' && (
        <Drawer.Footer className="!px-5 !py-3 !border-t !border-wd-border/60">
          <Button
            size="sm"
            className="!text-xs !bg-wd-primary !text-wd-primary-foreground !w-full"
            onPress={() => void retry()}
            isDisabled={retrying}
          >
            {retrying ? (
              <><Spinner size="sm" className="mr-1" /> Retrying…</>
            ) : (
              <><Icon icon="solar:refresh-linear" width={16} className="mr-1" /> Retry Dispatch</>
            )}
          </Button>
        </Drawer.Footer>
      )}
    </div>
  )
}

const SEVERITY_BADGE: Record<string, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-wd-danger/15 text-wd-danger ring-1 ring-wd-danger/30' },
  warning:  { label: 'Warning',  className: 'bg-wd-warning/15 text-wd-warning' },
  info:     { label: 'Info',     className: 'bg-wd-primary/15 text-wd-primary' },
  success:  { label: 'Success',  className: 'bg-wd-success/15 text-wd-success' },
}

function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.info!
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold rounded px-1.5 py-0.5 uppercase tracking-wider', s.className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_STYLE[severity as keyof typeof SEVERITY_STYLE])} />
      {s.label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-wd-muted">{label}</span>
      <div className="truncate">{children}</div>
    </div>
  )
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning' | 'primary'
  title: string
  children: React.ReactNode
}) {
  const cls =
    tone === 'danger'
      ? 'bg-wd-danger/10 border-wd-danger/40 text-wd-danger'
      : tone === 'warning'
        ? 'bg-wd-warning/10 border-wd-warning/40 text-wd-warning'
        : 'bg-wd-primary/5 border-wd-primary/30 text-wd-primary'
  return (
    <div className={cn('rounded-lg border p-3', cls)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider mb-1">{title}</div>
      {children}
    </div>
  )
}
