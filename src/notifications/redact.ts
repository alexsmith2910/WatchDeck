/**
 * Redaction helpers for the notification log's `request` / `response` fields.
 *
 * Rule: providers call these BEFORE returning `request` on `ProviderResult`,
 * so secrets never reach Mongo. Once a token lands in a log doc it's on
 * backup tapes forever — redact at write time, not at render time.
 */

const PLACEHOLDER = '***'

const SENSITIVE_HEADER_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /-token$/i,
  /-key$/i,
  /-secret$/i,
  /^x-api-key$/i,
]

/**
 * Strip embedded credentials from a URL.
 *
 * Discord webhooks: `/api/webhooks/{id}/{token}` — token is the last path
 * segment. Slack webhooks: `/services/T.../B.../{token}` — same shape, three
 * segments deep. Generic webhooks: most embed secrets in the query string;
 * we mask every value there.
 *
 * If the URL is malformed we return the placeholder rather than the raw
 * string — better to lose debuggability than to leak a secret.
 */
export function redactUrl(raw: string | undefined | null): string {
  if (!raw) return ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return PLACEHOLDER
  }
  // userinfo (http://user:pass@host) — never preserve.
  if (u.username || u.password) {
    u.username = ''
    u.password = ''
  }

  const host = u.hostname.toLowerCase()

  // Discord webhook: last segment of /api/webhooks/{id}/{token}
  if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) {
    const parts = u.pathname.split('/')
    const whIdx = parts.findIndex((p) => p === 'webhooks')
    if (whIdx >= 0 && parts.length >= whIdx + 3) {
      // keep the id (whIdx+1), mask the token (whIdx+2)
      parts[whIdx + 2] = PLACEHOLDER
      u.pathname = parts.slice(0, whIdx + 3).join('/') +
        (parts.length > whIdx + 3 ? '/' + parts.slice(whIdx + 3).join('/') : '')
    }
  }

  // Slack webhook: /services/T.../B.../{token}
  if (host.endsWith('hooks.slack.com')) {
    const parts = u.pathname.split('/')
    const svcIdx = parts.findIndex((p) => p === 'services')
    if (svcIdx >= 0 && parts.length >= svcIdx + 4) {
      parts[svcIdx + 3] = PLACEHOLDER
      u.pathname = parts.slice(0, svcIdx + 4).join('/')
    }
  }

  // Query string — mask every value. Cheaper than guessing which params are
  // secrets; the user is just reading this to confirm the request shape.
  if (u.search) {
    const masked = new URLSearchParams()
    for (const [k] of u.searchParams) masked.set(k, PLACEHOLDER)
    u.search = masked.toString()
  }

  return u.toString()
}

/**
 * Return a copy of the header map with sensitive values replaced by `***`.
 * Header-name matching is case-insensitive; the original casing is kept in
 * the output so the log still resembles the real wire format.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    out[name] = isSensitiveHeader(name) ? PLACEHOLDER : value
  }
  return out
}

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((re) => re.test(name))
}

/**
 * Truncate a string to `maxBytes` UTF-8 bytes. Preserves short strings
 * untouched; clipped results end with `…` so the UI can tell what happened.
 * We measure bytes not chars so a 10KB JSON blob with multi-byte chars
 * doesn't blow past Mongo's 16MB doc cap when many rows land at once.
 */
export function truncate(value: string | undefined | null, maxBytes: number): string {
  if (!value) return ''
  const buf = Buffer.from(value, 'utf8')
  if (buf.byteLength <= maxBytes) return value
  // Slice, then decode — if the cut lands mid-codepoint, trim off the
  // trailing partial bytes by re-encoding and comparing lengths.
  let sliced = buf.subarray(0, maxBytes).toString('utf8')
  // The replacement char (U+FFFD) appears when the cut is mid-codepoint.
  // Drop the trailing replacement to avoid a visible 'garbage' char.
  while (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1)
  return `${sliced}…`
}
