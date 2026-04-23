/**
 * Named presets for common dispatcher/incident/db events.
 *
 * Keep this file opinionated: these are the shapes the ToastBridge emits and
 * that user-action handlers can call without thinking about styling.
 */
import { toast } from './toast.js'
import type { ToastOptions } from './types.js'
import { formatTime } from '../../utils/time'

export interface NotificationFailedPayload {
  channelName?: string
  channelId: string
  reason: string
  logId?: string
  onRetry?: () => void
}

export interface IncidentPayload {
  incidentId: string
  endpointName?: string
  durationSeconds?: number
}

export const toastPresets = {
  notificationFailed(p: NotificationFailedPayload): string {
    const opts: ToastOptions = {
      kind: 'error',
      title: `Notification failed — ${p.channelName ?? 'channel'}`,
      description: p.reason,
      group: `notif-fail:${p.channelId}`,
      timeout: 9000,
    }
    if (p.onRetry) {
      opts.actions = [{ label: 'Retry', onPress: p.onRetry, variant: 'primary' }]
    }
    return toast.custom(opts)
  },

  notificationDispatched(channelName: string, kind: string): string {
    return toast.info(`Sent ${kind} via ${channelName}`, {
      group: 'notif-sent',
      timeout: 3500,
    })
  },

  dbDisconnected(reason?: string): string {
    return toast.error('Database disconnected', {
      description: reason ?? 'Attempting to reconnect…',
      id: 'db-connection',
      group: 'db',
      timeout: null,
    })
  },

  dbReconnected(): string {
    return toast.success('Database reconnected', {
      id: 'db-connection',
      group: 'db',
      timeout: 3500,
    })
  },

  incidentOpened(p: IncidentPayload): string {
    return toast.warning(`Incident opened — ${p.endpointName ?? 'endpoint'}`, {
      link: { label: 'View', href: `/incidents/${p.incidentId}` },
      group: `incident:${p.incidentId}`,
      timeout: 8000,
    })
  },

  incidentResolved(p: IncidentPayload): string {
    const mins = p.durationSeconds ? Math.max(1, Math.round(p.durationSeconds / 60)) : undefined
    return toast.success(`Incident resolved — ${p.endpointName ?? 'endpoint'}`, {
      description: mins ? `Down for ~${mins} min` : undefined,
      link: { label: 'View', href: `/incidents/${p.incidentId}` },
      group: `incident:${p.incidentId}`,
      timeout: 5000,
    })
  },

  maintenanceStarted(endpointName?: string, endsAt?: Date): string {
    const desc = endsAt
      ? `Ends ${formatTime(endsAt)}`
      : undefined
    return toast.info(`Maintenance started${endpointName ? ` — ${endpointName}` : ''}`, {
      description: desc,
      timeout: 5000,
    })
  },

  maintenanceEnded(endpointName?: string): string {
    return toast.info(`Maintenance ended${endpointName ? ` — ${endpointName}` : ''}`, {
      timeout: 4000,
    })
  },

  systemWarning(module: string, message: string): string {
    return toast.warning(`${module}: ${message}`, {
      group: `system:${module}`,
      timeout: 7000,
    })
  },

  systemCritical(module: string, message: string): string {
    return toast.error(`${module}: ${message}`, {
      group: `system:${module}`,
      timeout: null,
    })
  },
}
