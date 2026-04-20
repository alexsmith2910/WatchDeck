/**
 * Builds a Discord webhook payload from a channel-agnostic
 * `NotificationMessage`. Transport modules (webhook/bot) consume the
 * output; if Discord's payload shape changes, edit this file only.
 *
 * Reference: https://discord.com/developers/docs/resources/channel#embed-object
 *
 * Design notes
 * ------------
 *  - The source `NotificationMessage.title`/`summary` are intentionally
 *    ignored for incident kinds. Those strings are shaped for generic /
 *    plain-text fallbacks and double up on information Discord embeds
 *    already present (e.g. the endpoint name in both title and body).
 *    We re-build the embed directly from the structured fields
 *    (`endpoint`, `incident`, `severity`) so it stays tight and scannable.
 *  - Plain-text `msg.title`/`msg.summary` are still used as-is for
 *    `channel_test` and `custom` kinds since those don't carry structured
 *    incident data.
 */

import type { NotificationChannelDoc } from '../../../storage/types.js'
import type { NotificationMessage, NotificationMessageField } from '../../types.js'
import { LIMITS, SEVERITY_COLORS, clip } from './api.js'

interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

interface DiscordEmbedFooter {
  text: string
}

interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color?: number
  timestamp?: string
  fields?: DiscordEmbedField[]
  footer?: DiscordEmbedFooter
}

export interface DiscordWebhookPayload {
  content?: string
  username?: string
  avatar_url?: string
  embeds?: DiscordEmbed[]
}

export function buildDiscordPayload(
  msg: NotificationMessage,
  channel: Pick<NotificationChannelDoc, 'discordUsername' | 'discordAvatarUrl'>,
): DiscordWebhookPayload {
  const embed: DiscordEmbed = {
    title: clip(buildTitle(msg), LIMITS.embedTitle),
    description: buildDescription(msg),
    color: SEVERITY_COLORS[msg.severity],
    timestamp: new Date().toISOString(),
    footer: { text: buildFooter(msg) },
  }
  const fields = buildFields(msg)
  if (fields.length > 0) embed.fields = fields
  // Only set embed.url when we don't have a markdown link in the
  // description — otherwise the title becomes a second clickable link
  // pointing at the same dashboard page, which looks noisy.

  const payload: DiscordWebhookPayload = {
    embeds: [embed],
  }
  const username = channel.discordUsername?.trim()
  if (username) {
    payload.username = clip(username, LIMITS.username)
  }
  const avatarUrl = channel.discordAvatarUrl?.trim()
  if (avatarUrl && isHttpUrl(avatarUrl)) {
    payload.avatar_url = avatarUrl
  }
  return payload
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

const EMOJI = {
  down:       '🔴',
  degraded:   '🟡',
  recovered:  '✅',
  escalated:  '🚨',
  test:       '🧪',
  info:       'ℹ️',
} as const

function buildTitle(msg: NotificationMessage): string {
  const name = msg.endpoint?.name?.trim() ?? 'WatchDeck'
  switch (msg.kind) {
    case 'incident_opened':
      return msg.severity === 'critical'
        ? `${EMOJI.down} ${name} — DOWN`
        : `${EMOJI.degraded} ${name} — Degraded`
    case 'incident_resolved':
      return `${EMOJI.recovered} ${name} — Recovered`
    case 'incident_escalated':
      return `${EMOJI.escalated} ${name} — ESCALATED`
    case 'channel_test':
      return `${EMOJI.test} ${msg.title}`
    default:
      return `${EMOJI.info} ${msg.title}`
  }
}

// ---------------------------------------------------------------------------
// Description — markdown links for incident kinds, plain fallback for the rest
// ---------------------------------------------------------------------------

function buildDescription(msg: NotificationMessage): string {
  if (msg.kind === 'incident_opened' || msg.kind === 'incident_resolved' || msg.kind === 'incident_escalated') {
    const lines: string[] = []
    const links = buildLinks(msg)
    if (links) lines.push(links)
    if (msg.detail) lines.push(msg.detail)
    return clip(lines.join('\n\n'), LIMITS.embedDescription)
  }
  // channel_test / custom — keep the generic summary/detail
  const parts: string[] = []
  if (msg.summary) parts.push(msg.summary)
  if (msg.detail) parts.push(msg.detail)
  return clip(parts.join('\n\n'), LIMITS.embedDescription)
}

function buildLinks(msg: NotificationMessage): string | null {
  const pieces: string[] = []
  if (msg.endpoint?.name && msg.link && isHttpUrl(msg.link)) {
    // `Example Endpoint` → clickable, points at the dashboard incident view.
    pieces.push(`[**${escapeMarkdown(msg.endpoint.name)}**](${msg.link})`)
  }
  if (msg.endpoint?.url && isHttpUrl(msg.endpoint.url)) {
    // `Open endpoint ↗` → clickable, points at the monitored URL.
    pieces.push(`[Open endpoint ↗](${msg.endpoint.url})`)
  }
  return pieces.length ? pieces.join(' · ') : null
}

// ---------------------------------------------------------------------------
// Fields — Duration / Cause / Started (inline, side-by-side)
// ---------------------------------------------------------------------------

function buildFields(msg: NotificationMessage): DiscordEmbedField[] {
  if (msg.kind === 'channel_test' || msg.kind === 'custom') {
    // Surface whatever custom fields were attached, unchanged.
    return (msg.fields ?? []).slice(0, LIMITS.maxFields).map((f) => ({
      name: clip(f.label, LIMITS.embedFieldName),
      value: clip(f.value || '—', LIMITS.embedFieldValue),
      inline: true,
    }))
  }

  const fields: DiscordEmbedField[] = []

  // Duration — only on resolved (templates.ts puts it in fields).
  if (msg.kind === 'incident_resolved') {
    const dur = findField(msg.fields, 'Duration')
    if (dur) fields.push({ name: 'Duration', value: clip(dur, LIMITS.embedFieldValue), inline: true })
  }

  // Cause — pulled from fields[], humanised, with any causeDetail preserved.
  const cause = findField(msg.fields, 'Cause')
  if (cause) fields.push({ name: 'Cause', value: clip(humanCause(cause), LIMITS.embedFieldValue), inline: true })

  // Started — derived from incident.startedAt so it's always present and
  // consistent, regardless of what the template put in fields[].
  if (msg.incident?.startedAt instanceof Date) {
    fields.push({
      name: 'Started',
      value: clip(formatUtc(msg.incident.startedAt), LIMITS.embedFieldValue),
      inline: true,
    })
  }

  return fields
}

function findField(list: NotificationMessageField[] | undefined, label: string): string | null {
  if (!list) return null
  const f = list.find((x) => x.label === label)
  return f?.value ?? null
}

// ---------------------------------------------------------------------------
// Footer — "WatchDeck · #abcdef7 · by {actor}"
// ---------------------------------------------------------------------------

function buildFooter(msg: NotificationMessage): string {
  const bits: string[] = ['WatchDeck']
  if (msg.incident?.id) bits.push(shortIncidentId(msg.incident.id))
  if (msg.actor) bits.push(`by ${msg.actor}`)
  return clip(bits.join(' · '), LIMITS.embedFooterText)
}

function shortIncidentId(id: string): string {
  // Last 7 chars is unique enough for humans scanning channels and much
  // less visually heavy than the full 24-char ObjectId hex.
  return id.length > 7 ? `#${id.slice(-7)}` : `#${id}`
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const CAUSE_LABELS: Record<string, string> = {
  endpoint_down:     'Endpoint down',
  endpoint_degraded: 'Endpoint degraded',
}

/**
 * Turn internal cause codes (`endpoint_down`) into human-facing labels
 * (`Endpoint down`). Preserves any ` · detail` suffix that
 * `templates.ts` may append, so channel admins still see the provider's
 * error string alongside the humanised cause.
 */
function humanCause(raw: string): string {
  const [code, ...rest] = raw.split(' · ')
  const key = (code ?? '').trim()
  const label =
    CAUSE_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return rest.length ? `${label} · ${rest.join(' · ')}` : label
}

/**
 * `YYYY-MM-DD HH:MM UTC` — chosen over the native Discord `<t:…>`
 * relative-time widget because (a) the footer already shows relative
 * time, (b) a stable absolute timestamp is the piece humans need to
 * correlate the alert with external logs/dashboards.
 */
function formatUtc(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

/**
 * Escape the markdown characters Discord interprets inside a link label.
 * Endpoint names are free-form user input, so a name like `"Prod *live*"`
 * would otherwise break the link rendering.
 */
function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_{}\[\]()~>#+\-=|!])/g, '\\$1')
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
