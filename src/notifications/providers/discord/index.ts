/**
 * Discord notification provider — webhook-only.
 *
 * V1 only supports the webhook transport (user pastes an Incoming Webhook URL
 * from Discord's "Integrations" UI and we POST to it). A bot transport might
 * come back later; when it does it slots in beside `./webhook.ts` and this
 * file goes back to routing by `channel.discordTransport`.
 */

import type { NotificationChannelType } from '../../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../../types.js'
import { NotificationProvider } from '../provider.js'
import { isValidWebhookUrl } from './api.js'
import { sendViaWebhook } from './webhook.js'

export class DiscordProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'discord'

  async send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult> {
    return sendViaWebhook(msg, target)
  }

  async test(target: ChannelTarget): Promise<ProviderResult> {
    const now = new Date()
    const testMsg: NotificationMessage = {
      kind: 'channel_test',
      severity: 'info',
      title: `Test dispatch — ${target.name}`,
      summary: 'This is a test message from WatchDeck. If you see it in Discord, the wiring works.',
      link: '',
      idempotencyKey: `test:${target.id}:${now.getTime()}`,
      tags: ['test'],
    }
    return this.send(testMsg, target)
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'discord') {
      return { valid: false, error: `Expected channel type 'discord', got '${channel.type}'` }
    }
    const url = channel.discordWebhookUrl?.trim()
    if (!url) {
      return { valid: false, error: 'discordWebhookUrl is required' }
    }
    if (!isValidWebhookUrl(url)) {
      return {
        valid: false,
        error: 'discordWebhookUrl must look like https://discord.com/api/webhooks/{id}/{token}',
      }
    }
    return { valid: true }
  }
}
