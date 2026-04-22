/**
 * Shared channel-agnostic fallback formatter.
 *
 * Providers typically render their own rich payload from a
 * `NotificationMessage` (Discord embeds, Slack blocks, HTML email), but the
 * webhook provider and channel-test flows reuse the plain-text shape below.
 */

import type { NotificationLogPayload } from '../storage/types.js'
import type { NotificationMessage } from './types.js'
import { truncate } from './redact.js'

const PAYLOAD_MARKDOWN_LIMIT = 1024

/**
 * Channel-agnostic snapshot of what the dispatcher asked the provider to
 * render. Persisted on the notification-log row so the dashboard can show
 * what *was* sent even after templates change later. Kept ≤1KB for the
 * markdown slice; fields are deliberately bounded by input already.
 */
export function payloadSnapshot(msg: NotificationMessage): NotificationLogPayload {
  const snap: NotificationLogPayload = {
    title: msg.title,
    summary: msg.summary,
  }
  if (msg.detail) snap.markdown = truncate(msg.detail, PAYLOAD_MARKDOWN_LIMIT)
  if (msg.fields?.length) {
    snap.fields = msg.fields.map((f) => ({ label: f.label, value: f.value }))
  }
  return snap
}

export function formatAsPlainText(msg: NotificationMessage): string {
  const lines: string[] = []
  lines.push(`[${msg.severity.toUpperCase()}] ${msg.title}`)
  lines.push(msg.summary)
  if (msg.detail) {
    lines.push('')
    lines.push(msg.detail)
  }
  if (msg.fields?.length) {
    lines.push('')
    for (const f of msg.fields) lines.push(`• ${f.label}: ${f.value}`)
  }
  lines.push('')
  lines.push(`Link: ${msg.link}`)
  return lines.join('\n')
}

/** Apply Mustache-lite substitution for webhook body templates. */
export function renderTemplate(template: string, msg: NotificationMessage): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_match, path: string) => {
    const value = lookupPath(msg, path)
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value instanceof Date) return value.toISOString()
    return JSON.stringify(value)
  })
}

function lookupPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
