/**
 * Detailed-to-hourly aggregation worker.
 *
 * Reads raw check results from mx_checks for each completed hour,
 * computes summary statistics, and upserts into mx_hourly_summaries.
 *
 * Idempotent — re-running for the same hour overwrites with the same data.
 */

import { ObjectId } from 'mongodb'
import type { StorageAdapter } from '../storage/adapter.js'
import type { CheckDoc, HourlySummaryDoc } from '../storage/types.js'

/**
 * Aggregate raw checks into hourly summaries for all endpoints
 * that have check data in the given hour range.
 *
 * @param adapter  Storage adapter
 * @param hourStart  Start of the hour bucket (truncated to hour)
 * @param hourEnd    End of the hour bucket (hourStart + 1 hour)
 * @returns Number of hourly summaries upserted
 */
export async function aggregateHour(
  adapter: StorageAdapter,
  hourStart: Date,
  hourEnd: Date,
): Promise<number> {
  const endpointIds = await adapter.getEndpointIdsWithChecks(hourStart, hourEnd)
  let count = 0

  for (const epId of endpointIds) {
    const checks = await adapter.getChecksInHour(epId, hourStart, hourEnd)
    if (checks.length === 0) continue

    const summary = buildHourlySummary(epId, hourStart, checks)
    await adapter.upsertHourlySummary(summary)
    count++
  }

  return count
}

/**
 * Compute hourly summary statistics from a set of checks.
 */
export function buildHourlySummary(
  endpointId: string,
  hour: Date,
  checks: CheckDoc[],
): Omit<HourlySummaryDoc, '_id' | 'createdAt'> {
  const totalChecks = checks.length
  let successCount = 0
  let failCount = 0
  let degradedCount = 0
  let sumResponseTime = 0
  let minResponseTime = Infinity
  let maxResponseTime = -Infinity
  const responseTimes: number[] = []
  const errorTypes: Record<string, number> = {}
  let hadActiveIncident = false

  for (const check of checks) {
    const rt = check.responseTime
    responseTimes.push(rt)
    sumResponseTime += rt
    if (rt < minResponseTime) minResponseTime = rt
    if (rt > maxResponseTime) maxResponseTime = rt

    switch (check.status) {
      case 'healthy':
        successCount++
        break
      case 'degraded':
        degradedCount++
        break
      case 'down':
        failCount++
        break
    }

    if (check.errorMessage) {
      const key = categoriseError(check.errorMessage)
      errorTypes[key] = (errorTypes[key] ?? 0) + 1
    }

    if (check.duringMaintenance === false && check.status === 'down') {
      hadActiveIncident = true
    }
  }

  const avgResponseTime = Math.round(sumResponseTime / totalChecks)
  const uptimePercent =
    totalChecks === 0 ? 100 : Math.round((successCount / totalChecks) * 10000) / 100

  // P95 — sort ascending, pick the value at the 95th-percentile index.
  responseTimes.sort((a, b) => a - b)
  const p95Index = Math.min(Math.ceil(totalChecks * 0.95) - 1, totalChecks - 1)
  const p95ResponseTime = responseTimes[p95Index] ?? 0
  const p99Index = Math.min(Math.ceil(totalChecks * 0.99) - 1, totalChecks - 1)
  const p99ResponseTime = responseTimes[p99Index] ?? 0

  return {
    endpointId: new ObjectId(endpointId),
    hour,
    totalChecks,
    successCount,
    failCount,
    degradedCount,
    uptimePercent,
    avgResponseTime,
    minResponseTime: minResponseTime === Infinity ? 0 : minResponseTime,
    maxResponseTime: maxResponseTime === -Infinity ? 0 : maxResponseTime,
    p95ResponseTime,
    p99ResponseTime,
    errorTypes,
    hadActiveIncident,
  }
}

/**
 * Reduce a raw error message to a short category key for errorTypes aggregation.
 */
function categoriseError(msg: string): string {
  const lower = msg.toLowerCase()
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout'
  if (lower.includes('econnrefused')) return 'connection_refused'
  if (lower.includes('econnreset')) return 'connection_reset'
  if (lower.includes('enotfound') || lower.includes('dns')) return 'dns_error'
  if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate')) return 'ssl_error'
  if (lower.includes('socket')) return 'socket_error'
  return 'other'
}
