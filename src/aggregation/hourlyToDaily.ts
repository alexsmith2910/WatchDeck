/**
 * Hourly-to-daily aggregation worker.
 *
 * Reads hourly summaries for a given UTC day, computes daily-level
 * statistics, and upserts into mx_daily_summaries.
 *
 * Idempotent — re-running for the same day overwrites with the same data.
 */

import { ObjectId } from 'mongodb'
import type { StorageAdapter } from '../storage/adapter.js'
import type { DailySummaryDoc, HourlySummaryDoc } from '../storage/types.js'

/**
 * Aggregate hourly summaries into a daily summary for all endpoints
 * that have hourly data on the given date.
 *
 * @param adapter   Storage adapter
 * @param dateStart Midnight UTC of the target day
 * @returns Number of daily summaries upserted
 */
export async function aggregateDay(
  adapter: StorageAdapter,
  dateStart: Date,
): Promise<number> {
  // Fetch all hourly summaries for this day (up to 24 per endpoint).
  const dateEnd = new Date(dateStart.getTime() + 24 * 60 * 60 * 1000)

  // Use the hourly summaries query — we need all endpoints, so fetch a generous limit.
  // We'll group by endpointId ourselves.
  const endpointIds = await adapter.getEndpointIdsWithChecks(dateStart, dateEnd)
  let count = 0

  for (const epId of endpointIds) {
    const hourlies = await adapter.listHourlySummaries(epId, { limit: 24 })
    // Filter to only summaries within this day.
    const dayHourlies = hourlies.filter((h) => {
      const t = h.hour.getTime()
      return t >= dateStart.getTime() && t < dateEnd.getTime()
    })

    if (dayHourlies.length === 0) continue

    const summary = buildDailySummary(epId, dateStart, dayHourlies)
    await adapter.upsertDailySummary(summary)
    count++
  }

  return count
}

/**
 * Compute daily summary statistics from a set of hourly summaries.
 */
export function buildDailySummary(
  endpointId: string,
  date: Date,
  hourlies: HourlySummaryDoc[],
): Omit<DailySummaryDoc, '_id' | 'createdAt'> {
  let totalChecks = 0
  let totalSuccess = 0
  let sumResponseTime = 0
  let minResponseTime = Infinity
  let maxResponseTime = -Infinity
  let incidentCount = 0
  const allP95s: number[] = []
  const allP99s: number[] = []

  for (const h of hourlies) {
    totalChecks += h.totalChecks
    totalSuccess += h.successCount
    sumResponseTime += h.avgResponseTime * h.totalChecks
    if (h.minResponseTime < minResponseTime) minResponseTime = h.minResponseTime
    if (h.maxResponseTime > maxResponseTime) maxResponseTime = h.maxResponseTime
    allP95s.push(h.p95ResponseTime)
    allP99s.push(h.p99ResponseTime)
    if (h.hadActiveIncident) incidentCount++
  }

  const avgResponseTime = totalChecks === 0 ? 0 : Math.round(sumResponseTime / totalChecks)
  const uptimePercent =
    totalChecks === 0 ? 100 : Math.round((totalSuccess / totalChecks) * 10000) / 100

  // Approximate p95 from hourly p95 values — take the value at the 95th percentile
  // of the hourly p95s. This is an approximation but good enough for daily views.
  allP95s.sort((a, b) => a - b)
  const p95Index = Math.min(Math.ceil(allP95s.length * 0.95) - 1, allP95s.length - 1)
  const p95ResponseTime = allP95s[p95Index] ?? 0

  allP99s.sort((a, b) => a - b)
  const p99Index = Math.min(Math.ceil(allP99s.length * 0.99) - 1, allP99s.length - 1)
  const p99ResponseTime = allP99s[p99Index] ?? 0

  // Estimate downtime from fail rates across hourly buckets.
  const totalFails = hourlies.reduce((s, h) => s + h.failCount, 0)
  const totalDowntimeMinutes =
    totalChecks === 0 ? 0 : Math.round((totalFails / totalChecks) * 24 * 60 * 100) / 100

  return {
    endpointId: new ObjectId(endpointId),
    date,
    totalChecks,
    uptimePercent,
    avgResponseTime,
    minResponseTime: minResponseTime === Infinity ? 0 : minResponseTime,
    maxResponseTime: maxResponseTime === -Infinity ? 0 : maxResponseTime,
    p95ResponseTime,
    p99ResponseTime,
    incidentCount,
    totalDowntimeMinutes,
  }
}
