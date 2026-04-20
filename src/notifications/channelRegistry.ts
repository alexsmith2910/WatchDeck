/**
 * In-memory cache of notification channels + the provider instance assigned
 * to each channel type.
 *
 * The dispatcher asks the registry for a channel + its provider on every
 * dispatch, so the cache avoids a round-trip to Mongo per alert. CRUD events
 * on the bus are the single source of invalidation — external mutations
 * that skip the event bus (there shouldn't be any) would go stale.
 */

import { eventBus } from '../core/eventBus.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type {
  NotificationChannelDoc,
  NotificationChannelType,
} from '../storage/types.js'
import { DiscordProvider } from './providers/discord/index.js'
import { EmailProvider } from './providers/email.js'
import type { NotificationProvider } from './providers/provider.js'
import { SlackProvider } from './providers/slack.js'
import { WebhookProvider } from './providers/webhook.js'

export class ChannelRegistry {
  private readonly providers = new Map<NotificationChannelType, NotificationProvider>()
  private readonly channels = new Map<string, NotificationChannelDoc>()
  private unsubscribes: Array<() => void> = []

  constructor(private readonly adapter: StorageAdapter) {
    this.providers.set('discord', new DiscordProvider())
    this.providers.set('slack', new SlackProvider())
    this.providers.set('email', new EmailProvider())
    this.providers.set('webhook', new WebhookProvider())
  }

  async init(): Promise<void> {
    await this.refresh()
    this.subscribe()
  }

  stop(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
  }

  /** Full reload — called on init and any CRUD event. */
  async refresh(): Promise<void> {
    const rows = await this.adapter.listNotificationChannels()
    this.channels.clear()
    for (const row of rows) {
      this.channels.set(row._id.toHexString(), row)
    }
  }

  getChannel(id: string): NotificationChannelDoc | undefined {
    return this.channels.get(id)
  }

  getProvider(type: NotificationChannelType): NotificationProvider | undefined {
    return this.providers.get(type)
  }

  listChannels(): NotificationChannelDoc[] {
    return Array.from(this.channels.values())
  }

  listEnabledChannels(): NotificationChannelDoc[] {
    return this.listChannels().filter((c) => c.enabled !== false)
  }

  /** Distinct channel types currently in use — for health probe grouping. */
  typesInUse(): NotificationChannelType[] {
    return Array.from(new Set(this.listChannels().map((c) => c.type)))
  }

  size(): number {
    return this.channels.size
  }

  private subscribe(): void {
    const refresh = (): void => { void this.refresh() }
    this.unsubscribes.push(
      eventBus.subscribe('notification:channelCreated', refresh, 'standard'),
      eventBus.subscribe('notification:channelUpdated', refresh, 'standard'),
      eventBus.subscribe('notification:channelDeleted', refresh, 'standard'),
    )
  }
}
