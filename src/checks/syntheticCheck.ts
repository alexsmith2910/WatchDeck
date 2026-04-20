/**
 * Synthetic check helper used exclusively by the `checkers` health probe.
 *
 * Exercises the same HTTP client path that `runCheck()` uses for real
 * endpoints, but DOES NOT emit `check:complete` and therefore never reaches
 * the buffer pipeline or the database. This keeps the health probe
 * non-mutating so it can fire at high cadence without polluting check
 * history.
 */

import { performance } from 'node:perf_hooks'
import { runHttpCheck } from './httpCheck.js'

export interface SyntheticCheckResult {
  ok: boolean
  statusCode: number | null
  responseTime: number
  error: string | null
}

export interface SyntheticCheckOptions {
  url: string
  timeoutMs?: number
  /** Status codes accepted as "ok". Defaults to 200. */
  acceptStatus?: ReadonlyArray<number>
}

/**
 * Dispatches a single HTTP request through the shared undici client.
 * Returns a normalized result the probe can map onto a ProbeStatus.
 */
export async function dispatchSyntheticCheck(
  opts: SyntheticCheckOptions,
): Promise<SyntheticCheckResult> {
  const { url, timeoutMs = 5_000, acceptStatus = [200] } = opts
  const start = performance.now()

  const result = await runHttpCheck({
    url,
    method: 'GET',
    timeout: timeoutMs,
    captureSsl: false,
  })

  const responseTime = Math.round(performance.now() - start)
  const ok =
    result.statusCode !== null &&
    acceptStatus.includes(result.statusCode) &&
    result.errorMessage === null

  return {
    ok,
    statusCode: result.statusCode,
    responseTime,
    error: ok ? null : (result.errorMessage ?? `unexpected status ${result.statusCode}`),
  }
}
