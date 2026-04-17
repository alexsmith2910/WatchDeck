/**
 * Retention cleanup worker.
 *
 * Deletes hourly and daily summary documents that have exceeded
 * their configured retention period. Raw checks (mx_checks) are
 * handled by a MongoDB TTL index and don't need manual cleanup.
 */

import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'

export interface CleanupResult {
  hourlyDeleted: number
  dailyDeleted: number
}

/**
 * Delete summaries older than their respective retention windows.
 *
 * @param adapter Storage adapter
 * @param config  WatchDeck config (for retention settings)
 * @returns Counts of deleted documents
 */
export async function runCleanup(
  adapter: StorageAdapter,
  config: WatchDeckConfig,
): Promise<CleanupResult> {
  const now = Date.now()

  // Hourly retention
  const hourlyMs = config.retention.hourlyDays * 24 * 60 * 60 * 1000
  const hourlyCutoff = new Date(now - hourlyMs)
  const hourlyDeleted = await adapter.deleteHourlySummariesBefore(hourlyCutoff)

  // Daily retention
  const dailyCutoff = dailyRetentionCutoff(config.retention.daily, now)
  let dailyDeleted = 0
  if (dailyCutoff) {
    dailyDeleted = await adapter.deleteDailySummariesBefore(dailyCutoff)
  }

  return { hourlyDeleted, dailyDeleted }
}

/**
 * Compute the cutoff date for daily summary retention.
 * Returns null for "indefinite" (no cleanup).
 */
function dailyRetentionCutoff(
  policy: '6months' | '1year' | 'indefinite',
  nowMs: number,
): Date | null {
  switch (policy) {
    case '6months':
      return new Date(nowMs - 183 * 24 * 60 * 60 * 1000)
    case '1year':
      return new Date(nowMs - 365 * 24 * 60 * 60 * 1000)
    case 'indefinite':
      return null
  }
}
