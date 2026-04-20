/**
 * Discord API constants — the single source of truth for anything Discord
 * might change. If Discord deprecates an endpoint, bumps the API version,
 * swaps rate-limit semantics, or changes their embed shape, this is the
 * file to edit.
 *
 * Reference: https://discord.com/developers/docs/resources/webhook
 */

import type { NotificationSeverity } from '../../../storage/types.js'

/** Our User-Agent — Discord asks bots/webhooks to identify themselves. */
export const DISCORD_USER_AGENT = 'WatchDeck (https://github.com/watchdeck, 1.0)'

/** How long we wait for Discord to respond before giving up. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Discord colors are 24-bit integers (red << 16 | green << 8 | blue).
 * These match the palette used across the dashboard so embeds feel
 * visually consistent.
 */
export const SEVERITY_COLORS: Record<NotificationSeverity, number> = {
  critical: 0xe74c3c, // wd-danger
  warning:  0xf1c40f, // wd-warning
  success:  0x2ecc71, // wd-success
  info:     0x3498db, // wd-primary
}

/**
 * Discord webhook URLs look like:
 *   https://discord.com/api/webhooks/{id}/{token}
 *   https://discordapp.com/api/webhooks/{id}/{token}  (legacy host, still valid)
 *   https://canary.discord.com/api/webhooks/…          (Canary client)
 *   https://ptb.discord.com/api/webhooks/…             (PTB client)
 */
const WEBHOOK_HOST_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/

export function isValidWebhookUrl(url: string): boolean {
  return WEBHOOK_HOST_RE.test(url.trim())
}

/**
 * Discord enforces field length caps — over-long values get rejected with a
 * 400. Truncating on our side keeps one bad payload from blocking all
 * dispatches for a channel. Limits pulled from the official docs.
 */
export const LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooterText: 2048,
  embedAuthorName: 256,
  username: 80,
  totalEmbedChars: 6000,
  maxEmbeds: 10,
  maxFields: 25,
} as const

export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}
