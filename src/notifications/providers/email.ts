/**
 * Email provider — SMTP via nodemailer.
 *
 * The user configures an `emailEndpoint` SMTP URL (e.g.
 * `smtp://user:pass@smtp.gmail.com:587`) plus one or more `emailRecipients`.
 * We build one transporter per channel target and reuse it across dispatches
 * to avoid TLS handshakes on every message.
 *
 * The From header uses the channel's name as the display part, and derives
 * the address part from either the SMTP username (when it looks like an
 * email) or a synthesised `notifications@{smtp-host}` fallback. That covers
 * the common cases (Gmail, self-hosted, Mailgun-postmaster) without adding a
 * per-channel `emailFrom` field. SES / SendGrid users who need a verified
 * sender can have that field added later as an override.
 */

import { performance } from 'node:perf_hooks'
import nodemailer, { type Transporter } from 'nodemailer'
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
import { redactUrl } from '../redact.js'
import { NotificationProvider } from './provider.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SOCKET_TIMEOUT_MS = 15_000

// Hex colours match the dashboard palette so alert emails feel at home next to
// the dashboard. Kept here rather than in a shared file because only this
// provider ever renders HTML.
const SEVERITY_COLOR: Record<NotificationSeverity, { bg: string; fg: string; label: string }> = {
  critical: { bg: '#fde4e1', fg: '#c0392b', label: 'Critical' },
  warning: { bg: '#fef3c7', fg: '#9a6b00', label: 'Warning' },
  success: { bg: '#dcf5e4', fg: '#1f8b4c', label: 'Recovered' },
  info: { bg: '#e1edfb', fg: '#1f5fb2', label: 'Info' },
}

export class EmailProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'email'

  // Transporters are keyed by channel id — if the user edits the SMTP URL we
  // drop the cached transporter so the next dispatch picks up the new config.
  private readonly transporters = new Map<string, { url: string; transporter: Transporter }>()

  async send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult> {
    const endpoint = target.emailEndpoint?.trim()
    const recipients = target.emailRecipients?.filter((r) => EMAIL_RE.test(r)) ?? []
    if (!endpoint) {
      return { status: 'failed', latencyMs: 0, failureReason: 'emailEndpoint is not set' }
    }
    if (recipients.length === 0) {
      return { status: 'failed', latencyMs: 0, failureReason: 'emailRecipients is empty' }
    }

    let transporter: Transporter
    let smtpUrl: URL
    try {
      smtpUrl = new URL(endpoint)
      transporter = this.transporterFor(target.id, endpoint)
    } catch (err) {
      return {
        status: 'failed',
        latencyMs: 0,
        failureReason: err instanceof Error ? err.message : 'Invalid SMTP endpoint',
      }
    }

    const from = buildFrom(target.name, smtpUrl)
    const subject = `${msg.title} — ${target.name}`
    const html = renderHtml(msg, target.name)
    const text = renderText(msg, target.name)

    const requestCapture = {
      method: 'SMTP',
      url: redactUrl(endpoint),
      headers: { From: from, To: recipients.join(', '), Subject: subject },
      body: text,
    }

    const start = performance.now()
    try {
      const info = await transporter.sendMail({
        from,
        to: recipients,
        subject,
        html,
        text,
      })
      const latencyMs = Math.round(performance.now() - start)
      return {
        status: 'sent',
        latencyMs,
        deliveryId: info.messageId,
        providerMeta: {
          messageId: info.messageId,
          accepted: info.accepted?.length ?? 0,
          rejected: info.rejected?.length ?? 0,
        },
        request: requestCapture,
        response: {
          providerId: info.messageId,
          bodyExcerpt: info.response ? info.response.slice(0, 2048) : undefined,
        },
      }
    } catch (err) {
      // nodemailer throws on SMTP-level failure (bad auth, connection refused,
      // all recipients rejected). Surface the message for the delivery log.
      // Drop the cached transporter so a retry with a fixed config doesn't
      // reuse a broken connection pool.
      this.transporters.delete(target.id)
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
    const testMsg: NotificationMessage = {
      kind: 'channel_test',
      severity: 'info',
      title: 'Test dispatch',
      summary: 'This is a test message from WatchDeck. If you see it in your inbox, the wiring works.',
      link: '',
      idempotencyKey: `test:${target.id}:${now.getTime()}`,
      tags: ['test'],
    }
    return this.send(testMsg, target)
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'email') {
      return { valid: false, error: `Expected channel type 'email', got '${channel.type}'` }
    }
    if (!channel.emailEndpoint) {
      return { valid: false, error: 'emailEndpoint is required (e.g. smtp://user:pass@host:587)' }
    }
    try {
      const url = new URL(channel.emailEndpoint)
      if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
        return { valid: false, error: 'emailEndpoint must use smtp:// or smtps://' }
      }
    } catch {
      return { valid: false, error: 'emailEndpoint is not a valid URL' }
    }
    if (!channel.emailRecipients || channel.emailRecipients.length === 0) {
      return { valid: false, error: 'At least one recipient is required' }
    }
    const bad = channel.emailRecipients.find((addr) => !EMAIL_RE.test(addr))
    if (bad) return { valid: false, error: `Invalid recipient address: ${bad}` }
    return { valid: true }
  }

  // -------------------------------------------------------------------------
  // Transporter cache
  // -------------------------------------------------------------------------

  private transporterFor(channelId: string, url: string): Transporter {
    const cached = this.transporters.get(channelId)
    if (cached && cached.url === url) return cached.transporter
    const transporter = nodemailer.createTransport(url, {
      connectionTimeout: SOCKET_TIMEOUT_MS,
      greetingTimeout: SOCKET_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    })
    this.transporters.set(channelId, { url, transporter })
    return transporter
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildFrom(channelName: string, smtpUrl: URL): string {
  // SMTP URLs decode the username already. If it's email-shaped we use it
  // as the sender address (works for Gmail / self-hosted / Mailgun-postmaster).
  // Otherwise fall back to notifications@{host} so the header is still valid.
  const decodedUser = smtpUrl.username ? decodeURIComponent(smtpUrl.username) : ''
  const host = smtpUrl.hostname || 'localhost'
  const addr = EMAIL_RE.test(decodedUser) ? decodedUser : `notifications@${host}`
  const displayName = sanitizeDisplayName(channelName) || 'WatchDeck'
  return `"${displayName}" <${addr}>`
}

/**
 * Strip characters that would break the quoted-display-name production in an
 * RFC 5322 From header. We only need to handle the ones that land in user
 * input — control chars, double quotes, newlines.
 */
function sanitizeDisplayName(name: string): string {
  return name.replace(/[\r\n"\\]/g, '').trim()
}

function renderHtml(msg: NotificationMessage, channelName: string): string {
  const palette = SEVERITY_COLOR[msg.severity]
  const title = escapeHtml(msg.title)
  const summary = escapeHtml(msg.summary)
  const detail = msg.detail ? `<p style="margin:0 0 16px 0;color:#475569">${escapeHtml(msg.detail)}</p>` : ''
  const fieldsHtml = renderFieldsHtml(msg)
  const linkHtml = msg.link
    ? `<p style="margin:24px 0 0 0"><a href="${escapeAttr(msg.link)}" style="display:inline-block;padding:10px 18px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">View in WatchDeck</a></p>`
    : ''
  const footer = `<p style="margin:32px 0 0 0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">Sent by WatchDeck · ${escapeHtml(channelName)}</p>`

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
          <tr><td style="padding:20px 24px;background:${palette.bg};color:${palette.fg};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em">
            ${palette.label} · ${escapeHtml(channelName)}
          </td></tr>
          <tr><td style="padding:24px">
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#0f172a">${title}</h1>
            <p style="margin:0 0 16px 0;color:#334155;font-size:14px;line-height:1.5">${summary}</p>
            ${detail}
            ${fieldsHtml}
            ${linkHtml}
            ${footer}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

function renderFieldsHtml(msg: NotificationMessage): string {
  if (!msg.fields || msg.fields.length === 0) return ''
  const rows = msg.fields
    .map(
      (f) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;vertical-align:top;white-space:nowrap">${escapeHtml(
          f.label,
        )}</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(
          f.value,
        )}</td></tr>`,
    )
    .join('')
  return `<table cellpadding="0" cellspacing="0" style="margin:16px 0 0 0;width:100%;border-collapse:collapse">${rows}</table>`
}

function renderText(msg: NotificationMessage, channelName: string): string {
  const lines: string[] = []
  lines.push(msg.title)
  lines.push('='.repeat(Math.min(msg.title.length, 72)))
  lines.push('')
  lines.push(msg.summary)
  if (msg.detail) {
    lines.push('')
    lines.push(msg.detail)
  }
  if (msg.fields && msg.fields.length > 0) {
    lines.push('')
    for (const f of msg.fields) lines.push(`${f.label}: ${f.value}`)
  }
  if (msg.link) {
    lines.push('')
    lines.push(`View in WatchDeck: ${msg.link}`)
  }
  lines.push('')
  lines.push('--')
  lines.push(`Sent by WatchDeck · ${channelName}`)
  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}
