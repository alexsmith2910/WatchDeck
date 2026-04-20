/**
 * Discord notification provider.
 *
 * The `discord` channel type has two transports:
 *
 *   - `webhook`  (default) — the simplest path. User pastes a webhook URL
 *                            from Discord's Integrations UI; we POST to it.
 *   - `bot`      — future — uses a bot token + channel ID via the bot API.
 *
 * This class is just a router. The real work (HTTP + payload shape) lives
 * in `./webhook.ts`, `./bot.ts`, and `./message.ts`. If Discord changes
 * anything — rate limits, embed shape, endpoints — the fix lives in this
 * folder. No grep across the rest of the codebase required.
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
import { sendViaBot } from './bot.js'
import { sendViaWebhook } from './webhook.js'

export type DiscordTransport = 'webhook' | 'bot'

function resolveTransport(channel: ChannelTarget): DiscordTransport {
  return channel.discordTransport === 'bot' ? 'bot' : 'webhook'
}

export class DiscordProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'discord'

  async send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult> {
    return resolveTransport(target) === 'webhook'
      ? sendViaWebhook(msg, target)
      : sendViaBot(msg, target)
  }

  async test(target: ChannelTarget): Promise<ProviderResult> {
    const now = new Date()
    const testMsg: NotificationMessage = {
      kind: 'channel_test',
      severity: 'info',
      title: `Test dispatch — ${target.name}`,
      summary: 'This is a test message from WatchDeck. If you see it in Discord, the wiring works.',
      link: '',
      idempotencyKey: `test:${target._id.toHexString()}:${now.getTime()}`,
      tags: ['test'],
    }
    return this.send(testMsg, target)
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'discord') {
      return { valid: false, error: `Expected channel type 'discord', got '${channel.type}'` }
    }
    const transport = resolveTransport(channel)
    if (transport === 'webhook') {
      const url = channel.discordWebhookUrl?.trim()
      if (!url) {
        return { valid: false, error: 'discordWebhookUrl is required for the Discord webhook transport' }
      }
      if (!isValidWebhookUrl(url)) {
        return {
          valid: false,
          error: 'discordWebhookUrl must look like https://discord.com/api/webhooks/{id}/{token}',
        }
      }
      return { valid: true }
    }
    // Bot transport isn't live yet, but we still block saves that don't
    // provide the minimum we'll need (token lives in env; channel id is
    // per-channel). Until bot support ships, always fail-fast.
    return {
      valid: false,
      error: 'Discord bot transport is not implemented yet — switch to the Webhook transport for now',
    }
  }
}
