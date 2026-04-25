/**
 * Generic outbound-webhook provider.
 *
 * POSTs (or PUT/PATCH) a JSON body to `channel.webhookUrl`. Two body modes:
 *
 *   1. No template — we send a default JSON envelope containing the full
 *      NotificationMessage shape. Consumers get structured fields and can
 *      process them however they like. This is the safe default.
 *
 *   2. `webhookBodyTemplate` set — we treat it as a handlebars-ish string
 *      with `{{path.to.value}}` placeholders. The result is sent verbatim
 *      as the body; if it parses as JSON we keep the `application/json`
 *      content-type, otherwise we downgrade to `text/plain`.
 *
 * Validation is strict: `webhookUrl` must be http(s) and the method must be
 * POST / PUT / PATCH. Custom headers are merged on top of defaults so a
 * template author can override `Content-Type` if they need to.
 */

import { performance } from 'node:perf_hooks'
import { request as undiciRequest } from 'undici'
import type { NotificationChannelType } from '../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../types.js'
import { redactHeaders, redactUrl, truncate as redactTruncate } from '../redact.js'
import { NotificationProvider } from './provider.js'

const ALLOWED_METHODS: ReadonlyArray<'POST' | 'PUT' | 'PATCH'> = ['POST', 'PUT', 'PATCH']
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_USER_AGENT = 'WatchDeck-Webhook/1.0'
const REQUEST_BODY_LIMIT = 4 * 1024
const RESPONSE_BODY_LIMIT = 2 * 1024

export class WebhookProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'webhook'

  async send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult> {
    return this.post(target, msg)
  }

  async test(target: ChannelTarget): Promise<ProviderResult> {
    const now = new Date()
    const testMsg: NotificationMessage = {
      kind: 'channel_test',
      severity: 'info',
      title: `Test dispatch — ${target.name}`,
      summary: 'This is a test message from WatchDeck — the webhook is wired correctly.',
      link: '',
      idempotencyKey: `test:${target.id}:${now.getTime()}`,
      tags: ['test'],
    }
    return this.post(target, testMsg)
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'webhook') {
      return { valid: false, error: `Expected channel type 'webhook', got '${channel.type}'` }
    }
    if (!channel.webhookUrl) {
      return { valid: false, error: 'webhookUrl is required' }
    }
    let parsed: URL
    try {
      parsed = new URL(channel.webhookUrl)
    } catch {
      return { valid: false, error: 'webhookUrl is not a valid URL' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'webhookUrl must use http(s)://' }
    }
    if (channel.webhookMethod && !ALLOWED_METHODS.includes(channel.webhookMethod)) {
      return {
        valid: false,
        error: `webhookMethod must be one of [${ALLOWED_METHODS.join(', ')}]`,
      }
    }
    if (channel.webhookBodyTemplate && channel.webhookBodyTemplate.length > 16_000) {
      return { valid: false, error: 'webhookBodyTemplate is too large (max 16KB)' }
    }
    return { valid: true }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async post(target: ChannelTarget, msg: NotificationMessage): Promise<ProviderResult> {
    if (!target.webhookUrl) {
      return { status: 'failed', latencyMs: 0, failureReason: 'webhookUrl is not set' }
    }
    const method = target.webhookMethod ?? 'POST'
    const rendered = renderBody(msg, target.webhookBodyTemplate)
    const headers = buildHeaders(target.webhookHeaders, rendered.contentType)
    const requestCapture = {
      method,
      url: redactUrl(target.webhookUrl),
      headers: redactHeaders(headers),
      body: redactTruncate(rendered.body, REQUEST_BODY_LIMIT),
    }
    const start = performance.now()
    try {
      const response = await undiciRequest(target.webhookUrl, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: method as any,
        headers,
        body: rendered.body,
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      })
      const latencyMs = Math.round(performance.now() - start)
      // Consume the body to free the connection; we don't surface it.
      const responseText = await response.body.text().catch(() => '')
      const responseCapture = {
        statusCode: response.statusCode,
        bodyExcerpt: redactTruncate(responseText, RESPONSE_BODY_LIMIT) || undefined,
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return {
          status: 'sent',
          latencyMs,
          providerMeta: { statusCode: response.statusCode, bytes: rendered.body.length },
          request: requestCapture,
          response: responseCapture,
        }
      }
      return {
        status: 'failed',
        latencyMs,
        failureReason: `HTTP ${response.statusCode}${responseText ? ` · ${truncate(responseText, 160)}` : ''}`,
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
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

interface RenderedBody {
  body: string
  contentType: string
}

function renderBody(msg: NotificationMessage, template: string | undefined): RenderedBody {
  if (!template || template.trim() === '') {
    return {
      body: JSON.stringify(defaultEnvelope(msg)),
      contentType: 'application/json',
    }
  }
  const substituted = substitute(template, msg)
  // If the substituted result parses as JSON, keep application/json. Otherwise
  // fall back to text/plain so relay services that strictly type-check bodies
  // don't reject.
  try {
    JSON.parse(substituted)
    return { body: substituted, contentType: 'application/json' }
  } catch {
    return { body: substituted, contentType: 'text/plain; charset=utf-8' }
  }
}

/**
 * Default envelope when no template is configured. Mirrors the
 * NotificationMessage shape but with ISO strings for dates so consumers can
 * round-trip it without special parsing.
 */
function defaultEnvelope(msg: NotificationMessage): Record<string, unknown> {
  return {
    event: msg.kind,
    severity: msg.severity,
    title: msg.title,
    summary: msg.summary,
    detail: msg.detail,
    link: msg.link,
    endpoint: msg.endpoint
      ? { id: msg.endpoint.id, name: msg.endpoint.name, url: msg.endpoint.url }
      : null,
    incident: msg.incident
      ? {
          id: msg.incident.id,
          startedAt: msg.incident.startedAt.toISOString(),
          status: msg.incident.status,
        }
      : null,
    fields: msg.fields ?? [],
    tags: msg.tags ?? [],
    actor: msg.actor,
    idempotencyKey: msg.idempotencyKey,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Minimal `{{path.to.value}}` substitution. Missing paths render as empty
 * string to keep templates forgiving. Supports three control helpers:
 *
 *   {{#if key}}…{{/if}}   — render block only when the key resolves truthy.
 *   {{json key}}          — JSON-stringify the value (lets templates embed
 *                            arbitrary fields in a JSON body safely).
 *   {{isoNow}}            — current timestamp, ISO string.
 */
function substitute(template: string, msg: NotificationMessage): string {
  const ctx = substitutionContext(msg)

  // Handle {{#if x}}…{{/if}} first so inner placeholders render correctly.
  let out = template.replace(
    /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, inner: string) => {
      const v = resolvePath(ctx, key)
      return truthy(v) ? inner : ''
    },
  )

  out = out.replace(/\{\{\s*json\s+([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const v = resolvePath(ctx, key)
    return JSON.stringify(v ?? null)
  })

  out = out.replace(/\{\{\s*isoNow\s*\}\}/g, () => new Date().toISOString())

  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const v = resolvePath(ctx, key)
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(v)
  })

  return out
}

function substitutionContext(msg: NotificationMessage): Record<string, unknown> {
  return {
    kind: msg.kind,
    event: msg.kind,
    severity: msg.severity,
    title: msg.title,
    summary: msg.summary,
    detail: msg.detail ?? '',
    link: msg.link,
    actor: msg.actor ?? '',
    idempotencyKey: msg.idempotencyKey,
    endpoint: msg.endpoint
      ? { id: msg.endpoint.id, name: msg.endpoint.name, url: msg.endpoint.url ?? '' }
      : { id: '', name: '', url: '' },
    incident: msg.incident
      ? {
          id: msg.incident.id,
          startedAt: msg.incident.startedAt.toISOString(),
          status: msg.incident.status,
        }
      : { id: '', startedAt: '', status: '' },
    fields: msg.fields ?? [],
    tags: msg.tags ?? [],
  }
}

function resolvePath(ctx: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function truthy(v: unknown): boolean {
  if (v == null) return false
  if (v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return Boolean(v)
}

function buildHeaders(
  custom: Record<string, string> | undefined,
  contentType: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'User-Agent': DEFAULT_USER_AGENT,
  }
  if (custom) {
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v !== 'string') continue
      headers[k] = v
    }
  }
  return headers
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}…`
}
