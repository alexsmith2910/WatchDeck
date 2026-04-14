/**
 * Check runner — orchestrates a single check cycle for one endpoint.
 *
 * Zero DB awareness: the runner knows nothing about MongoDB or the storage
 * adapter. It runs the appropriate check, pipes the raw result through the
 * evaluator pipeline, and emits a check:complete event. The buffer pipeline
 * picks up the event and routes it to the DB.
 */

import { eventBus } from '../core/eventBus.js'
import type { EndpointDoc } from '../storage/types.js'
import { runHttpCheck } from './httpCheck.js'
import { runPortCheck } from './portCheck.js'
import { evaluateStatus } from './evaluators/statusEval.js'

export async function runCheck(
  endpoint: EndpointDoc,
  opts: { captureSsl?: boolean } = {},
): Promise<void> {
  const timestamp = new Date()

  if (endpoint.type === 'http') {
    await runHttpEndpointCheck(endpoint, timestamp, opts.captureSsl ?? false)
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
  captureSsl: boolean,
): Promise<void> {
  const result = await runHttpCheck({
    url: endpoint.url!,
    method: endpoint.method ?? 'GET',
    headers: endpoint.headers ?? {},
    timeout: endpoint.timeout,
    captureSsl,
  })

  const eval_ = evaluateStatus({
    type: 'http',
    statusCode: result.statusCode,
    responseTime: result.responseTime,
    errorMessage: result.errorMessage,
    expectedStatusCodes: endpoint.expectedStatusCodes ?? [200],
    latencyThreshold: endpoint.latencyThreshold,
  })

  eventBus.emit('check:complete', {
    timestamp,
    endpointId: endpoint._id.toString(),
    status: eval_.status,
    responseTime: result.responseTime,
    statusCode: result.statusCode,
    errorMessage: eval_.statusReason ?? result.errorMessage,
  })
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

  eventBus.emit('check:complete', {
    timestamp,
    endpointId: endpoint._id.toString(),
    status: eval_.status,
    responseTime: result.responseTime,
    statusCode: null,
    errorMessage: eval_.statusReason ?? result.errorMessage,
  })
}
