/**
 * Aggregation scheduler.
 *
 * Runs two periodic jobs:
 *   1. **Hourly rollup** — every hour (on the hour), aggregates raw checks
 *      from the previous hour into mx_hourly_summaries.
 *   2. **Daily rollup + cleanup** — once per day at the configured UTC time,
 *      aggregates yesterday's hourly summaries into mx_daily_summaries and
 *      applies retention cleanup.
 *
 * Both jobs are idempotent and safe to re-run.
 */

import { eventBus } from '../core/eventBus.js'
import { aggregateHour } from './detailedToHourly.js'
import { aggregateDay } from './hourlyToDaily.js'
import { runCleanup } from './cleanup.js'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WatchDeckConfig } from '../config/types.js'

export class AggregationScheduler {
  private hourlyTimer: ReturnType<typeof setInterval> | null = null
  private dailyTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly config: WatchDeckConfig,
  ) {}

  /**
   * Start the aggregation timers.
   *
   * - Runs an immediate hourly catchup for the previous hour.
   * - Schedules hourly rollups at the top of each hour.
   * - Schedules the daily rollup + cleanup at config.aggregation.time UTC.
   */
  async init(): Promise<void> {
    // Run an immediate hourly rollup for the last completed hour.
    await this.runHourly()

    // Schedule hourly: compute ms until the next hour boundary, then setInterval every hour.
    const now = Date.now()
    const msUntilNextHour = 3_600_000 - (now % 3_600_000)

    setTimeout(() => {
      if (this.stopped) return
      void this.runHourly()
      this.hourlyTimer = setInterval(() => { void this.runHourly() }, 3_600_000)
    }, msUntilNextHour)

    // Schedule daily at the configured UTC time.
    this.scheduleDailyRun()
  }

  /** Stop all timers. In-flight aggregations complete normally. */
  stop(): void {
    this.stopped = true
    if (this.hourlyTimer !== null) {
      clearInterval(this.hourlyTimer)
      this.hourlyTimer = null
    }
    if (this.dailyTimer !== null) {
      clearTimeout(this.dailyTimer)
      this.dailyTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Hourly rollup
  // ---------------------------------------------------------------------------

  private async runHourly(): Promise<void> {
    try {
      // Aggregate the previous completed hour.
      const now = new Date()
      const hourEnd = new Date(now)
      hourEnd.setUTCMinutes(0, 0, 0)
      const hourStart = new Date(hourEnd.getTime() - 3_600_000)

      const count = await aggregateHour(this.adapter, hourStart, hourEnd)

      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'aggregation',
        message: `Hourly rollup complete: ${count} endpoint summaries for ${hourStart.toISOString()}`,
      })
    } catch (err) {
      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'aggregation',
        message: `Hourly rollup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Daily rollup + cleanup
  // ---------------------------------------------------------------------------

  private scheduleDailyRun(): void {
    const msUntilDaily = this.msUntilDailyTime()
    this.dailyTimer = setTimeout(() => {
      if (this.stopped) return
      void this.runDaily()
      // Reschedule for next day.
      this.scheduleDailyRun()
    }, msUntilDaily)
  }

  private async runDaily(): Promise<void> {
    try {
      // Aggregate yesterday's hourly summaries into a daily summary.
      const yesterday = new Date()
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      yesterday.setUTCHours(0, 0, 0, 0)

      const count = await aggregateDay(this.adapter, yesterday)

      // Run retention cleanup.
      const cleanup = await runCleanup(this.adapter, this.config)

      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'aggregation',
        message: `Daily rollup complete: ${count} daily summaries. Cleanup: ${cleanup.hourlyDeleted} hourly, ${cleanup.dailyDeleted} daily removed.`,
      })
    } catch (err) {
      eventBus.emit('system:warning', {
        timestamp: new Date(),
        module: 'aggregation',
        message: `Daily rollup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /**
   * Compute milliseconds from now until the next occurrence of config.aggregation.time UTC.
   */
  private msUntilDailyTime(): number {
    const [hours, minutes] = this.config.aggregation.time.split(':').map(Number) as [number, number]

    const now = new Date()
    const target = new Date(now)
    target.setUTCHours(hours, minutes, 0, 0)

    // If the target time has already passed today, schedule for tomorrow.
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1)
    }

    return target.getTime() - now.getTime()
  }
}
