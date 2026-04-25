/**
 * Slack provider — webhook only.
 *
 * Users paste an Incoming Webhook URL from Slack's app directory and we POST
 * JSON to it. Slack accepts either a plain `text` field (mrkdwn-escaped) or a
 * richer `blocks` array; we send both so modern workspaces get the formatted
 * block and fallback clients still see the text.
 *
 * Reference: https://api.slack.com/messaging/webhooks
 *
 * Success is a 200 with body `ok` (or an empty 2xx — Slack isn't strict).
 * Rate limits: Slack returns 429 with a `Retry-After` header. We surface that
 * in `providerMeta` so the dispatcher/UI can explain the delay.
 */

import { performance } from 'node:perf_hooks'
import { request as undiciRequest } from 'undici'
import type {
  NotificationChannelType,
  NotificationSeverity,
} from '../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../types.js'
import { redactHeaders, redactUrl, truncate as redactTruncate } from '../redact.js'
import { NotificationProvider } from './provider.js'

const SLACK_USER_AGENT = 'WatchDeck (https://github.com/watchdeck, 1.0)'
const REQUEST_TIMEOUT_MS = 10_000
const REQUEST_BODY_LIMIT = 4 * 1024
const RESPONSE_BODY_LIMIT = 2 * 1024

// https://api.slack.com/reference/surfaces/formatting#emoji — these keep the
// block kit header visually in sync with the Discord embed colour coding.
const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: ':rotating_light:',
  warning: ':warning:',
  success: ':white_check_mark:',
  info: ':information_source:',
}

const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/

function isValidSlackWebhookUrl(url: string): boolean {
  return SLACK_WEBHOOK_RE.test(url.trim())
}

export class SlackProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'slack'

  async send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult> {
    const url = target.slackWebhookUrl?.trim()
    if (!url) {
      return { status: 'failed', latencyMs: 0, failureReason: 'slackWebhookUrl is not set' }
    }
    if (!isValidSlackWebhookUrl(url)) {
      return {
        status: 'failed',
        latencyMs: 0,
        failureReason: 'slackWebhookUrl is not a recognised Slack Incoming Webhook URL',
      }
    }

    const payload = buildSlackPayload(msg)
    const body = JSON.stringify(payload)
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': SLACK_USER_AGENT,
    }
    const requestCapture = {
      method: 'POST',
      url: redactUrl(url),
      headers: redactHeaders(requestHeaders),
      body: redactTruncate(body, REQUEST_BODY_LIMIT),
    }
    const start = performance.now()

    try {
      const response = await undiciRequest(url, {
        method: 'POST',
        headers: requestHeaders,
        body,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      })
      const latencyMs = Math.round(performance.now() - start)
      const text = await response.body.text().catch(() => '')
      const responseCapture = {
        statusCode: response.statusCode,
        bodyExcerpt: redactTruncate(text, RESPONSE_BODY_LIMIT) || undefined,
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return {
          status: 'sent',
          latencyMs,
          providerMeta: { statusCode: response.statusCode, bytes: body.length },
          request: requestCapture,
          response: responseCapture,
        }
      }

      if (response.statusCode === 429) {
        const retryAfter = parseRetryAfter(response.headers)
        return {
          status: 'failed',
          latencyMs,
          failureReason: `Slack rate-limited the webhook (retry after ${retryAfter ?? '?'}s)`,
          providerMeta: { statusCode: 429, retryAfter },
          request: requestCapture,
          response: responseCapture,
        }
      }

      return {
        status: 'failed',
        latencyMs,
        failureReason: `Slack responded HTTP ${response.statusCode}${text ? ` · ${truncate(text, 160)}` : ''}`,
        providerMeta: { statusCode: response.statusCode },
        request: requestCapture,
        response: responseCapture,
      }
    } catch (err) {
      return {
        status: 'failed',
        latencyMs: Math.round(performance.now() - start),
        failureReason: err instanceof Error ? err.message : String(err),
        request: requestCapture,
      }
    }
  }

  async test(target: ChannelTarget): Promise<ProviderResult> {
    const now = new Date()
    const msg: NotificationMessage = {
      kind: 'channel_test',
      severity: 'info',
      title: `Test dispatch — ${target.name}`,
      summary: 'This is a test message from WatchDeck. If you see it in Slack, the wiring works.',
      link: '',
      idempotencyKey: `test:${target.id}:${now.getTime()}`,
      tags: ['test'],
    }
    return this.send(msg, target)
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'slack') {
      return { valid: false, error: `Expected channel type 'slack', got '${channel.type}'` }
    }
    const url = channel.slackWebhookUrl?.trim()
    if (!url) {
      return { valid: false, error: 'slackWebhookUrl is required' }
    }
    if (!isValidSlackWebhookUrl(url)) {
      return {
        valid: false,
        error: 'slackWebhookUrl must look like https://hooks.slack.com/services/T.../B.../...',
      }
    }
    return { valid: true }
  }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

interface SlackBlock {
  type: string
  text?: { type: 'mrkdwn' | 'plain_text'; text: string; emoji?: boolean }
  fields?: Array<{ type: 'mrkdwn'; text: string }>
}

interface SlackPayload {
  text: string
  blocks: SlackBlock[]
}

function buildSlackPayload(msg: NotificationMessage): SlackPayload {
  const emoji = SEVERITY_EMOJI[msg.severity]
  const header = `${emoji}  *${escapeMrkdwn(msg.title)}*`
  const summary = escapeMrkdwn(msg.summary)
  const fallback = `${msg.title} — ${msg.summary}`

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${header}\n${summary}` },
    },
  ]

  if (msg.fields && msg.fields.length > 0) {
    // Slack caps fields at 10 per section; anything beyond is dropped rather
    // than pushed into a second section so the block stays compact.
    const capped = msg.fields.slice(0, 10).map((f) => ({
      type: 'mrkdwn' as const,
      text: `*${escapeMrkdwn(f.label)}*\n${escapeMrkdwn(f.value)}`,
    }))
    blocks.push({ type: 'section', fields: capped })
  }

  if (msg.link) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${msg.link}|View in WatchDeck>` },
    })
  }

  return { text: fallback, blocks }
}

/**
 * Slack mrkdwn uses `&`, `<`, `>` as control characters. Anything else
 * (including asterisks, underscores) stays literal — so escape the three
 * structural characters and leave the rest alone for readability.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseRetryAfter(
  headers: Record<string, string | string[] | undefined>,
): number | undefined {
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
