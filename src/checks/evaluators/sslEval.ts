/**
 * SSL warning evaluator.
 *
 * Degrades a check when the TLS certificate is within `sslWarningDays` of
 * expiry. Runs after the status-code gate (only when the base status is
 * healthy) and before assertion evaluation. Skipped when the endpoint has a
 * `kind: 'ssl'` assertion — the explicit rule supersedes the monitoring-tab
 * threshold, same pattern as `skipLatencyCheck` in statusEval.
 *
 * Returns `status: null` when there's nothing to signal (no TLS data
 * captured, warning disabled, or plenty of days remaining). The caller uses
 * null as "leave the current status alone".
 */

export interface SslEvalInput {
  sslDaysRemaining: number | null
  sslWarningDays: number
}

export interface SslEvalResult {
  status: 'degraded' | null
  statusReason: string | null
}

export function evaluateSsl(input: SslEvalInput): SslEvalResult {
  // Warning disabled (0) or no TLS data captured → nothing to report.
  if (input.sslWarningDays <= 0) return { status: null, statusReason: null }
  if (input.sslDaysRemaining === null) return { status: null, statusReason: null }

  if (input.sslDaysRemaining < input.sslWarningDays) {
    const days = input.sslDaysRemaining
    const plural = days === 1 ? '' : 's'
    // Expired (days <= 0) is still "degraded" here because the HTTPS request
    // actually succeeded — the server is serving an expired cert. Operators
    // usually want a loud warning rather than a hard down on that, so the
    // threshold stays the authoritative signal.
    const descriptor = days <= 0 ? 'expired' : `${days} day${plural} remaining`
    return {
      status: 'degraded',
      statusReason: `Certificate ${descriptor} (warn at ${input.sslWarningDays} days)`,
    }
  }

  return { status: null, statusReason: null }
}
