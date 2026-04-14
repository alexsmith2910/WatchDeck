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

export interface HttpCheckResult {
  statusCode: number | null
  responseTime: number
  body: string | null
  sslDaysRemaining: number | null
  errorMessage: string | null
}

export async function runHttpCheck(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  timeout?: number
  /** When true, opens a TLS socket to capture the certificate expiry. */
  captureSsl?: boolean
}): Promise<HttpCheckResult> {
  const {
    url,
    method = 'GET',
    headers = {},
    timeout = 10_000,
    captureSsl = false,
  } = params

  const start = performance.now()

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      statusCode: null,
      responseTime: 0,
      body: null,
      sslDaysRemaining: null,
      errorMessage: `Invalid URL: ${url}`,
    }
  }

  const isHttps = parsed.protocol === 'https:'

  // ── HTTPS with SSL capture: use a per-request Client with TLS interception ──

  if (isHttps && captureSsl) {
    let sslDaysRemaining: number | null = null

    const client = new Client(parsed.origin, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connect(opts: any, callback: (err: Error | null, socket: any) => void) {
        const tlsSocket = tls.connect({
          host: (opts as { hostname: string }).hostname,
          port: (opts as { port: number }).port,
          servername: (opts as { servername?: string; hostname: string }).servername
            ?? (opts as { hostname: string }).hostname,
          // Capture cert regardless of chain validity — sslEval can decide.
          rejectUnauthorized: false,
        })
        tlsSocket.once('secureConnect', () => {
          const cert = tlsSocket.getPeerCertificate()
          if (cert?.valid_to) {
            sslDaysRemaining = Math.floor(
              (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000,
            )
          }
          callback(null, tlsSocket)
        })
        tlsSocket.once('error', (err: Error) => { callback(err, null) })
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
      const body = await readBody(response.body)

      return { statusCode: response.statusCode, responseTime, body, sslDaysRemaining, errorMessage: null }
    } catch (err: unknown) {
      const responseTime = Math.round(performance.now() - start)
      return {
        statusCode: null,
        responseTime,
        body: null,
        sslDaysRemaining,
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
    const body = await readBody(response.body)

    return { statusCode: response.statusCode, responseTime, body, sslDaysRemaining: null, errorMessage: null }
  } catch (err: unknown) {
    const responseTime = Math.round(performance.now() - start)
    return {
      statusCode: null,
      responseTime,
      body: null,
      sslDaysRemaining: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody(body: { text(): Promise<string> }): Promise<string | null> {
  try {
    return await body.text()
  } catch {
    return null
  }
}
