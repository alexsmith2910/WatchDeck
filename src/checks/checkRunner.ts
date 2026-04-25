/**
 * Check runner — orchestrates a single check cycle for one endpoint.
 *
 * Zero DB awareness: the runner knows nothing about MongoDB or the storage
 * adapter. It runs the appropriate check, pipes the raw result through the
 * evaluator pipeline, and emits a check:complete event. The buffer pipeline
 * picks up the event and routes it to the DB.
 */

import { eventBus } from '../core/eventBus.js'
import type { AssertionEvalResult, EndpointDoc } from '../storage/types.js'
import { runHttpCheck } from './httpCheck.js'
import { runPortCheck } from './portCheck.js'
import { evaluateStatus } from './evaluators/statusEval.js'
import { evaluateAssertions } from './evaluators/assertionsEval.js'
import { evaluateSsl } from './evaluators/sslEval.js'

export async function runCheck(
  endpoint: EndpointDoc,
  opts: {
    captureSsl?: boolean
    captureBodySize?: boolean
    maxBodyBytesToRead?: number
  } = {},
): Promise<void> {
  const timestamp = new Date()

  if (endpoint.type === 'http') {
    await runHttpEndpointCheck(endpoint, timestamp, {
      captureSsl: opts.captureSsl ?? false,
      captureBodySize: opts.captureBodySize ?? false,
      maxBodyBytesToRead: opts.maxBodyBytesToRead ?? 1_048_576,
    })
  } else {
    await runPortEndpointCheck(endpoint, timestamp)
  }
}

// ---------------------------------------------------------------------------
// Private runners
// ---------------------------------------------------------------------------

async function runHttpEndpointCheck(
  endpoint: EndpointDoc,
  timestamp: Date,
  opts: { captureSsl: boolean; captureBodySize: boolean; maxBodyBytesToRead: number },
): Promise<void> {
  const result = await runHttpCheck({
    url: endpoint.url!,
    method: endpoint.method ?? 'GET',
    headers: endpoint.headers ?? {},
    timeout: endpoint.timeout,
    captureSsl: opts.captureSsl,
    captureBodySize: opts.captureBodySize,
    maxBodyBytesToRead: opts.maxBodyBytesToRead,
  })

  // When the user has a `kind: 'latency'` / `kind: 'ssl'` assertion configured
  // we treat it as the single source of truth for that signal and skip the
  // Monitoring-tab threshold. Prevents same-severity double-signalling where
  // the narrower of the two fires first and the other is dead weight.
  const hasLatencyAssertion = (endpoint.assertions ?? []).some(
    (a) => a.kind === 'latency',
  )
  const hasSslAssertion = (endpoint.assertions ?? []).some(
    (a) => a.kind === 'ssl',
  )

  const eval_ = evaluateStatus({
    type: 'http',
    statusCode: result.statusCode,
    responseTime: result.responseTime,
    errorMessage: result.errorMessage,
    expectedStatusCodes: endpoint.expectedStatusCodes ?? [200],
    latencyThreshold: endpoint.latencyThreshold,
    skipLatencyCheck: hasLatencyAssertion,
  })

  // Preserve the measured duration even when the check is down — a long
  // responseTime on a down result is evidence of a timeout or slow failure,
  // and zeroing it destroys diagnostic signal.
  const responseTime = result.responseTime

  let finalStatus = eval_.status
  let finalReason = eval_.statusReason

  // SSL warning — only applies when the base status is still healthy and no
  // SSL assertion supersedes it. Can only upgrade healthy→degraded; never
  // touches down or downgrades from degraded.
  if (finalStatus === 'healthy' && !hasSslAssertion) {
    const sslEval_ = evaluateSsl({
      sslDaysRemaining: result.sslDaysRemaining,
      sslWarningDays: endpoint.sslWarningDays,
    })
    if (sslEval_.status === 'degraded') {
      finalStatus = 'degraded'
      finalReason = sslEval_.statusReason
    }
  }

  // Assertion evaluation is gated on the base status: if the endpoint is
  // already down (unreachable, unexpected status code) there's no body or
  // headers to assert against. The gate also keeps the hot path cheap when
  // the endpoint has no assertions configured.
  let assertionResult: AssertionEvalResult | null = null
  if (
    eval_.status !== 'down' &&
    endpoint.assertions &&
    endpoint.assertions.length > 0
  ) {
    assertionResult = evaluateAssertions({
      assertions: endpoint.assertions,
      body: result.body,
      headers: result.headers,
      responseTime,
      sslDaysRemaining: result.sslDaysRemaining,
      isHttps: (endpoint.url ?? '').startsWith('https://'),
    })
    if (assertionResult.failedSeverity === 'down') {
      finalStatus = 'down'
      finalReason = firstFailureReason(assertionResult) ?? 'Assertion failed'
    } else if (
      assertionResult.failedSeverity === 'degraded' &&
      finalStatus === 'healthy'
    ) {
      finalStatus = 'degraded'
      finalReason = firstFailureReason(assertionResult) ?? 'Assertion failed'
    }
  }

  eventBus.emit('check:complete', {
    timestamp,
    endpointId: endpoint.id.toString(),
    status: finalStatus,
    responseTime,
    statusCode: result.statusCode,
    errorMessage: finalReason ?? result.errorMessage,
    sslDaysRemaining: result.sslDaysRemaining,
    sslIssuer: result.sslIssuer,
    bodyBytes: result.bodyBytes,
    bodyBytesTruncated: result.bodyBytesTruncated,
    assertionResult,
  })
}

/**
 * Build a short human-readable reason from the first failed assertion, so the
 * Check-tab error column shows *why* a previously-healthy check flipped to
 * down/degraded.
 */
function firstFailureReason(result: AssertionEvalResult): string | null {
  for (const r of result.results) {
    if (r.passed) continue
    if (r.error) return `assertion: ${r.kind} · ${r.error}`
    const target = r.target ? ` ${r.target}` : ''
    const value = r.value !== undefined ? ` ${r.value}` : ''
    return `assertion failed: ${r.kind}${target} ${r.operator}${value}`
  }
  return null
}

async function runPortEndpointCheck(endpoint: EndpointDoc, timestamp: Date): Promise<void> {
  const result = await runPortCheck({
    host: endpoint.host!,
    port: endpoint.port!,
    timeout: endpoint.timeout,
  })

  const eval_ = evaluateStatus({
    type: 'port',
    statusCode: null,
    responseTime: result.responseTime,
    errorMessage: result.errorMessage,
    expectedStatusCodes: [],
    latencyThreshold: endpoint.latencyThreshold,
    portOpen: result.portOpen,
  })

  // Preserve the measured duration even when the check is down — a long
  // responseTime on a down result is evidence of a timeout or slow failure,
  // and zeroing it destroys diagnostic signal.
  const responseTime = result.responseTime

  eventBus.emit('check:complete', {
    timestamp,
    endpointId: endpoint.id.toString(),
    status: eval_.status,
    responseTime,
    statusCode: null,
    errorMessage: eval_.statusReason ?? result.errorMessage,
    sslDaysRemaining: null,
    sslIssuer: null,
    bodyBytes: null,
    bodyBytesTruncated: false,
    assertionResult: null,
  })
}
