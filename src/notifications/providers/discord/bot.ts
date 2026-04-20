/**
 * Discord *bot* transport — not yet implemented.
 *
 * When we add it, this file owns the OAuth/token wiring and the
 * `POST /channels/{channel.id}/messages` call. The payload shape reuses
 * `buildDiscordPayload()` from `message.ts` so bot and webhook produce
 * identical embeds.
 *
 * Reference: https://discord.com/developers/docs/resources/channel#create-message
 */

import type { NotificationChannelDoc } from '../../../storage/types.js'
import type { NotificationMessage, ProviderResult } from '../../types.js'
import { notImplementedResult } from '../provider.js'

export async function sendViaBot(
  _msg: NotificationMessage,
  _channel: NotificationChannelDoc,
): Promise<ProviderResult> {
  return notImplementedResult('Discord bot')
}
