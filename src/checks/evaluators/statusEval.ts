/**
 * Phase 1 status evaluator.
 *
 * Determines the composite check status from raw HTTP/port check output.
 * Rules (applied in order):
 *   1. Network-level error with no response → down
 *   2. Port check: not open → down
 *   3. HTTP: status code not in expectedStatusCodes → down
 *   4. Response time exceeds latencyThreshold → degraded
 *      (skipped when `skipLatencyCheck` is true — the endpoint has a
 *      latency assertion that fully supersedes this check)
 *   5. Otherwise → healthy
 */

export interface StatusEvalInput {
  type: 'http' | 'port'
  statusCode: number | null
  responseTime: number
  errorMessage: string | null
  expectedStatusCodes: number[]
  latencyThreshold: number
  /**
   * When true, bypass the latency-threshold branch. The caller (checkRunner)
   * sets this when the endpoint has a `kind: 'latency'` assertion configured,
   * so the user's explicit rule is the single source of truth for latency
   * outcomes instead of two overlapping signals at the same severity.
   */
  skipLatencyCheck?: boolean
  /** Set for port checks */
  portOpen?: boolean
}

export interface StatusEvalResult {
  status: 'healthy' | 'degraded' | 'down'
  statusReason: string | null
}

export function evaluateStatus(input: StatusEvalInput): StatusEvalResult {
  // Rule 1: HTTP with no response at all (network error before any status).
  // Port checks have their own refused/timeout branch below, so gate on type
  // explicitly rather than inferring it from `portOpen === undefined`.
  if (input.type === 'http' && input.errorMessage !== null && input.statusCode === null) {
    return { status: 'down', statusReason: input.errorMessage }
  }

  if (input.type === 'port') {
    // Rule 2: port refused
    if (!input.portOpen) {
      return {
        status: 'down',
        statusReason: input.errorMessage ?? 'Port connection refused',
      }
    }
    // Rule 4: latency (port checks never have assertions, so always applies)
    if (input.responseTime > input.latencyThreshold) {
      return {
        status: 'degraded',
        statusReason: `${input.responseTime}ms exceeds ${input.latencyThreshold}ms threshold`,
      }
    }
    return { status: 'healthy', statusReason: null }
  }

  // Rule 3: unexpected HTTP status code
  if (input.statusCode !== null && !input.expectedStatusCodes.includes(input.statusCode)) {
    return {
      status: 'down',
      statusReason: `HTTP ${input.statusCode} — expected ${input.expectedStatusCodes.join(' or ')}`,
    }
  }

  // Rule 4: latency — skipped when a latency assertion supersedes this check.
  if (!input.skipLatencyCheck && input.responseTime > input.latencyThreshold) {
    return {
      status: 'degraded',
      statusReason: `${input.responseTime}ms exceeds ${input.latencyThreshold}ms threshold`,
    }
  }

  return { status: 'healthy', statusReason: null }
}
