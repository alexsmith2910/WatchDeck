/**
 * Mute tracker — in-memory mirror of `mx_notification_mutes` so the dispatcher
 * can gate every dispatch without touching Mongo. The DB remains authoritative:
 * entries expire server-side via a TTL index; the tracker drops them lazily
 * at lookup time too.
 */

import { eventBus } from '../core/eventBus.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { NotificationMuteDoc } from '../storage/types.js'

export interface MuteLookup {
  endpointId?: string
  channelId?: string
}

export class MuteTracker {
  private readonly byEndpoint = new Map<string, Date>()
  private readonly byChannel = new Map<string, Date>()
  /** null = no active global mute; Date = mute expires at this instant. */
  private globalMuteUntil: Date | null = null

  private unsubscribes: Array<() => void> = []

  constructor(private readonly adapter: StorageAdapter) {}

  async init(): Promise<void> {
    await this.refresh()
    this.subscribe()
  }

  stop(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
  }

  /** Whether an alert targeting the given endpoint+channel should be muted. */
  isMuted(lookup: MuteLookup): { muted: boolean; scope?: 'global' | 'endpoint' | 'channel' } {
    const now = Date.now()

    if (this.globalMuteUntil && this.globalMuteUntil.getTime() > now) {
      return { muted: true, scope: 'global' }
    }

    if (lookup.endpointId) {
      const exp = this.byEndpoint.get(lookup.endpointId)
      if (exp && exp.getTime() > now) return { muted: true, scope: 'endpoint' }
      if (exp) this.byEndpoint.delete(lookup.endpointId)
    }

    if (lookup.channelId) {
      const exp = this.byChannel.get(lookup.channelId)
      if (exp && exp.getTime() > now) return { muted: true, scope: 'channel' }
      if (exp) this.byChannel.delete(lookup.channelId)
    }

    return { muted: false }
  }

  async refresh(): Promise<void> {
    const [rows, prefs] = await Promise.all([
      this.adapter.listActiveMutes(),
      this.adapter.getNotificationPreferences(),
    ])
    this.byEndpoint.clear()
    this.byChannel.clear()
    for (const row of rows) {
      this.apply(row)
    }
    // Preferences-level global mute takes precedence if present.
    if (prefs.globalMuteUntil && prefs.globalMuteUntil.getTime() > Date.now()) {
      this.globalMuteUntil = prefs.globalMuteUntil
    } else {
      this.globalMuteUntil = null
    }
  }

  private apply(row: NotificationMuteDoc): void {
    if (row.scope === 'global') {
      const current = this.globalMuteUntil?.getTime() ?? 0
      if (row.expiresAt.getTime() > current) this.globalMuteUntil = row.expiresAt
      return
    }
    const target = row.targetId?.toHexString()
    if (!target) return
    if (row.scope === 'endpoint') {
      const prev = this.byEndpoint.get(target)?.getTime() ?? 0
      if (row.expiresAt.getTime() > prev) this.byEndpoint.set(target, row.expiresAt)
    } else if (row.scope === 'channel') {
      const prev = this.byChannel.get(target)?.getTime() ?? 0
      if (row.expiresAt.getTime() > prev) this.byChannel.set(target, row.expiresAt)
    }
  }

  private subscribe(): void {
    const refresh = (): void => { void this.refresh() }
    this.unsubscribes.push(
      eventBus.subscribe('notification:muted', refresh, 'standard'),
      eventBus.subscribe('notification:unmuted', refresh, 'standard'),
    )
  }
}
