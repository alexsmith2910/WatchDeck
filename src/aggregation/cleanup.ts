/**
 * Retention cleanup worker.
 *
 * Deletes hourly and daily summary documents that have exceeded
 * their configured retention period. Raw checks (mx_checks) are
 * handled by a MongoDB TTL index and don't need manual cleanup.
 *
 * Also redacts the sensitive capture fields on notification-log rows
 * older than 30 days. The rows themselves are deleted by the TTL on
 * `sentAt` (per `retention.notificationLogDays`), but payload / request /
 * response are cleared earlier so webhook URLs and bodies stop sitting
 * in backups longer than they need to.
 */

import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'

const NOTIFICATION_REDACT_AFTER_MS = 30 * 24 * 60 * 60 * 1000

export interface CleanupResult {
  hourlyDeleted: number
  dailyDeleted: number
  notificationLogsRedacted: number
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

  // Notification log redaction — unset payload / request / response on rows
  // older than 30 days. Rows remain intact until the TTL removes them.
  const redactCutoff = new Date(now - NOTIFICATION_REDACT_AFTER_MS)
  const notificationLogsRedacted = await adapter.redactOldNotificationLogs(redactCutoff)

  return { hourlyDeleted, dailyDeleted, notificationLogsRedacted }
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
