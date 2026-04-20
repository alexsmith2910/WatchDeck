/**
 * Discord *webhook* transport — the simplest way for a user to post to a
 * channel. They paste a webhook URL from Discord's "Integrations" UI and
 * we POST a JSON payload to it. No bot token, no OAuth.
 *
 * Reference: https://discord.com/developers/docs/resources/webhook#execute-webhook
 *
 * Success is either 204 (no body) or 200 (if `?wait=true`). Anything else
 * is reported as a failure — the dispatcher handles retry/backoff, so we
 * only need to surface a clear reason.
 *
 * Rate limits: Discord returns 429 with a JSON body `{ retry_after: seconds }`.
 * We capture that in `providerMeta` so the log shows *why* the dispatch
 * failed, but we don't sleep here (the dispatcher's retry schedule owns
 * the timing).
 */

import { performance } from 'node:perf_hooks'
import { request as undiciRequest } from 'undici'
import type { NotificationChannelDoc } from '../../../storage/types.js'
import type {
  NotificationMessage,
  ProviderResult,
} from '../../types.js'
import {
  DISCORD_USER_AGENT,
  REQUEST_TIMEOUT_MS,
  isValidWebhookUrl,
} from './api.js'
import { buildDiscordPayload } from './message.js'

export async function sendViaWebhook(
  msg: NotificationMessage,
  channel: NotificationChannelDoc,
): Promise<ProviderResult> {
  const url = channel.discordWebhookUrl?.trim()
  if (!url) {
    return {
      status: 'failed',
      latencyMs: 0,
      failureReason: 'discordWebhookUrl is not set',
    }
  }
  if (!isValidWebhookUrl(url)) {
    return {
      status: 'failed',
      latencyMs: 0,
      failureReason: 'discordWebhookUrl is not a recognised Discord webhook URL',
    }
  }

  const payload = buildDiscordPayload(msg, channel)
  const body = JSON.stringify(payload)
  const start = performance.now()

  try {
    const response = await undiciRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': DISCORD_USER_AGENT,
      },
      body,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    })
    const latencyMs = Math.round(performance.now() - start)
    const text = await response.body.text().catch(() => '')

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return {
        status: 'sent',
        latencyMs,
        providerMeta: { statusCode: response.statusCode, bytes: body.length },
      }
    }

    // Rate-limited — surface the retry hint so the dispatcher / UI can
    // explain the delay.
    if (response.statusCode === 429) {
      const retryAfter = parseRetryAfter(text, response.headers)
      return {
        status: 'failed',
        latencyMs,
        failureReason: `Discord rate-limited the webhook (retry after ${retryAfter ?? '?'}s)`,
        providerMeta: { statusCode: 429, retryAfter },
      }
    }

    return {
      status: 'failed',
      latencyMs,
      failureReason: `Discord responded HTTP ${response.statusCode}${text ? ` · ${truncate(text, 160)}` : ''}`,
      providerMeta: { statusCode: response.statusCode },
    }
  } catch (err) {
    return {
      status: 'failed',
      latencyMs: Math.round(performance.now() - start),
      failureReason: err instanceof Error ? err.message : String(err),
    }
  }
}

function parseRetryAfter(
  body: string,
  headers: Record<string, string | string[] | undefined>,
): number | undefined {
  try {
    const parsed = JSON.parse(body) as { retry_after?: number }
    if (typeof parsed.retry_after === 'number') return parsed.retry_after
  } catch {
    // fall through to header
  }
  const header = headers['retry-after']
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}…`
}
