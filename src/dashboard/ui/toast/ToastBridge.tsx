/**
 * ToastBridge — subscribes to SSE and emits house-style toasts.
 *
 * Mount once, inside <SSEProvider>. Users can later silence individual
 * event types via notification preferences (not wired here yet).
 */
import { useEffect } from 'react'
import { useSSE } from '../../hooks/useSSE.js'
import { toastPresets } from './presets.js'

interface NotificationFailedEvent {
  channelId: string
  channelName?: string
  reason: string
  logId?: string
}
interface DbDisconnectedEvent { error?: string; reason?: string }
interface IncidentOpenedEvent {
  incident?: { _id?: string; id?: string; endpointName?: string; endpointId?: string }
  incidentId?: string
  endpointName?: string
}
interface IncidentResolvedEvent {
  incidentId: string
  endpointName?: string
  durationSeconds?: number
}
interface MaintenanceEvent {
  endpointId?: string
  endpointName?: string
  endsAt?: string
}
interface SystemEvent { module: string; message: string }

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

export function ToastBridge() {
  const { subscribe } = useSSE()

  useEffect(() => {
    const offs: Array<() => void> = []

    offs.push(subscribe('notification:failed', (d) => {
      const ev = asObject(d) as NotificationFailedEvent | null
      if (!ev) return
      toastPresets.notificationFailed({
        channelId: ev.channelId,
        channelName: ev.channelName,
        reason: ev.reason,
        logId: ev.logId,
      })
    }))

    offs.push(subscribe('db:disconnected', (d) => {
      const ev = asObject(d) as DbDisconnectedEvent | null
      toastPresets.dbDisconnected(ev?.reason ?? (typeof ev?.error === 'string' ? ev.error : undefined))
    }))

    offs.push(subscribe('db:reconnected', () => {
      toastPresets.dbReconnected()
    }))

    offs.push(subscribe('incident:opened', (d) => {
      const ev = asObject(d) as IncidentOpenedEvent | null
      const inc = ev?.incident as Record<string, unknown> | undefined
      const id = (inc?._id ?? inc?.id ?? ev?.incidentId) as string | undefined
      if (!id) return
      toastPresets.incidentOpened({
        incidentId: id,
        endpointName: (inc?.endpointName as string | undefined) ?? ev?.endpointName,
      })
    }))

    offs.push(subscribe('incident:resolved', (d) => {
      const ev = asObject(d) as IncidentResolvedEvent | null
      if (!ev?.incidentId) return
      toastPresets.incidentResolved({
        incidentId: ev.incidentId,
        endpointName: ev.endpointName,
        durationSeconds: ev.durationSeconds,
      })
    }))

    offs.push(subscribe('maintenance:started', (d) => {
      const ev = asObject(d) as MaintenanceEvent | null
      toastPresets.maintenanceStarted(
        ev?.endpointName,
        ev?.endsAt ? new Date(ev.endsAt) : undefined,
      )
    }))

    offs.push(subscribe('maintenance:ended', (d) => {
      const ev = asObject(d) as MaintenanceEvent | null
      toastPresets.maintenanceEnded(ev?.endpointName)
    }))

    offs.push(subscribe('system:warning', (d) => {
      const ev = asObject(d) as SystemEvent | null
      if (ev?.module && ev.message) toastPresets.systemWarning(ev.module, ev.message)
    }))

    offs.push(subscribe('system:critical', (d) => {
      const ev = asObject(d) as SystemEvent | null
      if (ev?.module && ev.message) toastPresets.systemCritical(ev.module, ev.message)
    }))

    return () => {
      for (const off of offs) off()
      // Don't clear; user-initiated toasts may be present.
    }
  }, [subscribe])

  return null
}
