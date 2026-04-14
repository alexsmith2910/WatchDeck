/**
 * Phase 1 status evaluator.
 *
 * Determines the composite check status from raw HTTP/port check output.
 * Rules (applied in order):
 *   1. Network-level error with no response → down
 *   2. Port check: not open → down
 *   3. HTTP: status code not in expectedStatusCodes → down
 *   4. Response time exceeds latencyThreshold → degraded
 *   5. Otherwise → healthy
 */

export interface StatusEvalInput {
  type: 'http' | 'port'
  statusCode: number | null
  responseTime: number
  errorMessage: string | null
  expectedStatusCodes: number[]
  latencyThreshold: number
  /** Set for port checks */
  portOpen?: boolean
}

export interface StatusEvalResult {
  status: 'healthy' | 'degraded' | 'down'
  statusReason: string | null
}

export function evaluateStatus(input: StatusEvalInput): StatusEvalResult {
  // Rule 1: no response at all
  if (input.errorMessage !== null && input.statusCode === null && input.portOpen === undefined) {
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
    // Rule 4: latency
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

  // Rule 4: latency
  if (input.responseTime > input.latencyThreshold) {
    return {
      status: 'degraded',
      statusReason: `${input.responseTime}ms exceeds ${input.latencyThreshold}ms threshold`,
    }
  }

  return { status: 'healthy', statusReason: null }
}
