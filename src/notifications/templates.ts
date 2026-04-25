/**
 * Builds a channel-agnostic `NotificationMessage` from an incident + its
 * endpoint. Providers consume the message and render their own payload; the
 * plain-text helpers here are a fallback for simple channels and logs.
 */

import type { EndpointDoc, IncidentDoc } from '../storage/types.js'
import type {
  NotificationMessage,
  NotificationMessageField,
} from './types.js'

export interface BuildMessageOpts {
  /** Absolute dashboard link — `${baseUrl}/endpoints/${endpointId}`. */
  baseUrl: string
  /** Optional actor string written into the message (e.g. 'user:abc' or 'system'). */
  actor?: string
  /** Override the idempotency key — default is `${incidentId}:${kind}`. */
  idempotencyKey?: string
}

export function buildIncidentOpenedMessage(
  endpoint: EndpointDoc,
  incident: IncidentDoc,
  opts: BuildMessageOpts,
): NotificationMessage {
  const endpointId = endpoint.id
  const incidentId = incident.id
  const link = `${opts.baseUrl}/endpoints/${endpointId}?incident=${incidentId}`
  const fields: NotificationMessageField[] = [
    { label: 'Endpoint', value: endpoint.name },
    ...(endpoint.url ? [{ label: 'URL', value: endpoint.url }] : []),
    { label: 'Cause', value: incident.cause + (incident.causeDetail ? ` · ${incident.causeDetail}` : '') },
    { label: 'Started', value: incident.startedAt.toISOString() },
  ]
  return {
    kind: 'incident_opened',
    severity: deriveSeverity(endpoint, incident, 'opened'),
    title: `${endpoint.name} is DOWN`,
    summary: `Endpoint ${endpoint.name} is failing (${incident.cause}).`,
    detail: incident.causeDetail,
    endpoint: { id: endpointId, name: endpoint.name, url: endpoint.url ?? null },
    incident: { id: incidentId, startedAt: incident.startedAt, status: incident.status },
    link,
    fields,
    actor: opts.actor,
    idempotencyKey: opts.idempotencyKey ?? `${incidentId}:opened`,
  }
}

export function buildIncidentResolvedMessage(
  endpoint: EndpointDoc,
  incident: IncidentDoc,
  durationSeconds: number,
  opts: BuildMessageOpts,
): NotificationMessage {
  const endpointId = endpoint.id
  const incidentId = incident.id
  const link = `${opts.baseUrl}/endpoints/${endpointId}?incident=${incidentId}`
  return {
    kind: 'incident_resolved',
    severity: 'success',
    title: `${endpoint.name} recovered`,
    summary: `Endpoint ${endpoint.name} recovered after ${formatDuration(durationSeconds)}.`,
    endpoint: { id: endpointId, name: endpoint.name, url: endpoint.url ?? null },
    incident: { id: incidentId, startedAt: incident.startedAt, status: 'resolved' },
    link,
    fields: [
      { label: 'Duration', value: formatDuration(durationSeconds) },
      { label: 'Cause', value: incident.cause },
    ],
    actor: opts.actor,
    idempotencyKey: opts.idempotencyKey ?? `${incidentId}:resolved`,
  }
}

export function buildEscalationMessage(
  endpoint: EndpointDoc,
  incident: IncidentDoc,
  opts: BuildMessageOpts,
): NotificationMessage {
  const base = buildIncidentOpenedMessage(endpoint, incident, opts)
  return {
    ...base,
    kind: 'incident_escalated',
    severity: 'critical',
    title: `ESCALATION — ${endpoint.name} still down`,
    summary: `Endpoint ${endpoint.name} has been down for ${formatDuration(
      Math.max(0, Math.floor((Date.now() - incident.startedAt.getTime()) / 1000)),
    )} and has not recovered.`,
    idempotencyKey: opts.idempotencyKey ?? `${incident.id}:escalated`,
  }
}

export function buildChannelTestMessage(
  channelName: string,
  opts: BuildMessageOpts,
): NotificationMessage {
  return {
    kind: 'channel_test',
    severity: 'info',
    title: `Test dispatch — ${channelName}`,
    summary: 'This is a test message from WatchDeck — your channel is wired correctly.',
    link: `${opts.baseUrl}/notifications`,
    actor: opts.actor,
    idempotencyKey: opts.idempotencyKey ?? `test:${channelName}:${Date.now()}`,
  }
}

function deriveSeverity(
  _endpoint: EndpointDoc,
  incident: IncidentDoc,
  phase: 'opened' | 'resolved',
): NotificationMessage['severity'] {
  if (phase === 'resolved') return 'success'
  // A full outage (`endpoint_down`) is critical — the user has lost the
  // service entirely. Degraded states (slow latency, certificate warnings,
  // body-rule failures) are a step below — still actionable, but not a
  // page-the-team event. Anything else falls back to warning so a new
  // cause never silently downgrades to info.
  return incident.cause === 'endpoint_down' ? 'critical' : 'warning'
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}
