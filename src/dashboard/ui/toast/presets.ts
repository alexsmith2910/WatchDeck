/**
 * Named presets for common dispatcher/incident/db events.
 *
 * Keep this file opinionated: these are the shapes the ToastBridge emits and
 * that user-action handlers can call without thinking about styling.
 */
import { toast } from './toast.js'
import type { ToastOptions } from './types.js'
import { formatTime } from '../../utils/time'
import { formatDuration } from '../../utils/format'

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
    const desc = p.durationSeconds
      ? `Down for ${formatDuration(Math.max(1, Math.round(p.durationSeconds)))}`
      : undefined
    return toast.success(`Incident resolved — ${p.endpointName ?? 'endpoint'}`, {
      description: desc,
      link: { label: 'View', href: `/incidents/${p.incidentId}` },
      group: `incident:${p.incidentId}`,
      timeout: 5000,
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
