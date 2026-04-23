/**
 * HTTP check using undici.
 *
 * One request captures: status code, actual elapsed time, response body,
 * and (when captureSsl is true) TLS certificate expiry days.
 *
 * Response time is always the real wall-clock elapsed time — never null,
 * never zero-filled. Failed requests record the time until the error.
 */

import { performance } from 'node:perf_hooks'
import * as tls from 'node:tls'
import { Client, request as undiciRequest } from 'undici'

export interface SslIssuer {
  o?: string
  cn?: string
}

export interface HttpCheckResult {
  statusCode: number | null
  responseTime: number
  body: string | null
  /** Bytes counted from the response body (or trusted Content-Length). Null when not captured. */
  bodyBytes: number | null
  /** True when the body read was cut off at `maxBodyBytesToRead`. */
  bodyBytesTruncated: boolean
  /**
   * Response headers with lowercase keys. Multi-value headers are joined with
   * `, ` (HTTP multi-header semantics). Null when the request never completed.
   */
  headers: Record<string, string> | null
  sslDaysRemaining: number | null
  sslIssuer: SslIssuer | null
  errorMessage: string | null
}

const DEFAULT_USER_AGENT = 'WatchDeck/1.0'

export async function runHttpCheck(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  timeout?: number
  /** When true, opens a TLS socket to capture the certificate expiry. */
  captureSsl?: boolean
  /** When true, records the byte length of the response body. */
  captureBodySize?: boolean
  /** Cap on bytes read when no trusted Content-Length is present. */
  maxBodyBytesToRead?: number
}): Promise<HttpCheckResult> {
  const {
    url,
    method = 'GET',
    headers: rawHeaders = {},
    timeout = 10_000,
    captureSsl = false,
    captureBodySize = false,
    maxBodyBytesToRead = 1_048_576,
  } = params

  // Ensure a User-Agent is always sent — many sites block bare requests.
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT, ...rawHeaders }

  const start = performance.now()

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      statusCode: null,
      responseTime: Math.round(performance.now() - start),
      body: null,
      bodyBytes: null,
      bodyBytesTruncated: false,
      headers: null,
      sslDaysRemaining: null,
      sslIssuer: null,
      errorMessage: `Invalid URL: ${url}`,
    }
  }

  const isHttps = parsed.protocol === 'https:'

  // ── HTTPS with SSL capture: use a per-request Client with TLS interception ──

  if (isHttps && captureSsl) {
    let sslDaysRemaining: number | null = null
    let sslIssuer: SslIssuer | null = null

    const client = new Client(parsed.origin, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connect(opts: any, callback: (err: Error | null, socket: any) => void) {
        // undici passes port as '' when the URL uses the default port — fall back to 443
        // only when the value is unparseable (NaN), not merely falsy (port 0 is valid).
        const rawPort = (opts as { port: number | string }).port
        let port: number
        if (typeof rawPort === 'number') {
          port = rawPort
        } else {
          const parsed = parseInt(String(rawPort), 10)
          port = Number.isNaN(parsed) ? 443 : parsed
        }
        const tlsSocket = tls.connect({
          host: (opts as { hostname: string }).hostname,
          port,
          servername: (opts as { servername?: string; hostname: string }).servername
            ?? (opts as { hostname: string }).hostname,
          // Capture cert regardless of chain validity — sslEval can decide.
          rejectUnauthorized: false,
        })
        // Guard the callback against the secureConnect/error race where both
        // could fire for the same socket (e.g. handshake error after partial
        // establishment). Without this, undici's consumer sees two results.
        let called = false
        const once = (err: Error | null, sock: typeof tlsSocket | null) => {
          if (called) return
          called = true
          callback(err, sock)
        }
        tlsSocket.once('secureConnect', () => {
          const cert = tlsSocket.getPeerCertificate()
          if (cert?.valid_to) {
            sslDaysRemaining = Math.floor(
              (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000,
            )
          }
          if (cert?.issuer) {
            const o = typeof cert.issuer.O === 'string' ? cert.issuer.O : undefined
            const cn = typeof cert.issuer.CN === 'string' ? cert.issuer.CN : undefined
            if (o || cn) sslIssuer = { ...(o ? { o } : {}), ...(cn ? { cn } : {}) }
          }
          once(null, tlsSocket)
        })
        tlsSocket.once('error', (err: Error) => { once(err, null) })
      },
    })

    try {
      const response = await client.request({
        path: parsed.pathname + parsed.search,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: method as any,
        headers,
        headersTimeout: timeout,
        bodyTimeout: timeout,
      })

      const responseTime = Math.round(performance.now() - start)
      const read = await readBodyWithMeta(response.body, response.headers, {
        captureBodySize,
        maxBodyBytesToRead,
        isHead: method.toUpperCase() === 'HEAD',
      })

      return {
        statusCode: response.statusCode,
        responseTime,
        body: read.body,
        bodyBytes: read.bodyBytes,
        bodyBytesTruncated: read.truncated,
        headers: normalizeHeaders(response.headers),
        sslDaysRemaining,
        sslIssuer,
        errorMessage: null,
      }
    } catch (err: unknown) {
      const responseTime = Math.round(performance.now() - start)
      return {
        statusCode: null,
        responseTime,
        body: null,
        bodyBytes: null,
        bodyBytesTruncated: false,
        headers: null,
        sslDaysRemaining,
        sslIssuer,
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    } finally {
      await client.close().catch(() => { /* ignore close errors */ })
    }
  }

  // ── Default path: global pool via undici.request ──────────────────────────

  try {
    const response = await undiciRequest(url, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: method as any,
      headers,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    })

    const responseTime = Math.round(performance.now() - start)
    const read = await readBodyWithMeta(response.body, response.headers, {
      captureBodySize,
      maxBodyBytesToRead,
      isHead: method.toUpperCase() === 'HEAD',
    })

    return {
      statusCode: response.statusCode,
      responseTime,
      body: read.body,
      bodyBytes: read.bodyBytes,
      bodyBytesTruncated: read.truncated,
      headers: normalizeHeaders(response.headers),
      sslDaysRemaining: null,
      sslIssuer: null,
      errorMessage: null,
    }
  } catch (err: unknown) {
    const responseTime = Math.round(performance.now() - start)
    return {
      statusCode: null,
      responseTime,
      body: null,
      bodyBytes: null,
      bodyBytesTruncated: false,
      headers: null,
      sslDaysRemaining: null,
      sslIssuer: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ReadResult {
  body: string | null
  bodyBytes: number | null
  truncated: boolean
}

/**
 * Read the response body into a string and count bytes as we go.
 *
 * Always streams the body (up to `maxBodyBytesToRead`) rather than short-
 * circuiting on Content-Length, because assertion rules need the decoded
 * text — skipping the read would make body / json / header assertions fail
 * with "Response body not captured" on any well-behaved server that sends
 * Content-Length.
 *
 * HEAD is the one case where there's genuinely no body; we return early.
 */
async function readBodyWithMeta(
  stream: AsyncIterable<Uint8Array>,
  _headers: Record<string, string | string[] | undefined>,
  opts: { captureBodySize: boolean; maxBodyBytesToRead: number; isHead: boolean },
): Promise<ReadResult> {
  if (opts.isHead) {
    return { body: null, bodyBytes: opts.captureBodySize ? 0 : null, truncated: false }
  }

  try {
    const chunks: Uint8Array[] = []
    let bytes = 0
    let truncated = false
    const cap = opts.maxBodyBytesToRead
    for await (const chunk of stream) {
      const part = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
      if (bytes + part.byteLength > cap) {
        const remaining = cap - bytes
        if (remaining > 0) {
          chunks.push(part.subarray(0, remaining))
          bytes = cap
        }
        truncated = true
        break
      }
      chunks.push(part)
      bytes += part.byteLength
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8')
    return {
      body,
      bodyBytes: opts.captureBodySize ? bytes : null,
      truncated,
    }
  } catch {
    return { body: null, bodyBytes: null, truncated: false }
  }
}

/**
 * Lowercase-key, comma-joined view of undici's headers map.
 *
 * undici delivers header values as `string | string[] | undefined` depending
 * on whether the wire repeated the header. Assertion evaluators want a flat
 * `Record<string, string>` with canonical casing, so we normalize once here.
 */
function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}
