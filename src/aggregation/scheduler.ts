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

  /** Last-run telemetry consumed by the `aggregator` health probe. */
  private _lastHourlyRunAt = 0
  private _lastHourlyDurationMs: number | null = null
  private _nextHourlyRunAt = 0
  private _lastDailyRunAt = 0
  private _lastDailyDurationMs: number | null = null
  private _nextDailyRunAt = 0
  private readonly _startedAt = Date.now()

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly config: WatchDeckConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Probe-facing accessors (reflect last-run timestamps in epoch ms).
  // ---------------------------------------------------------------------------

  get lastHourlyRunAt(): number { return this._lastHourlyRunAt }
  get lastHourlyDurationMs(): number | null { return this._lastHourlyDurationMs }
  get nextHourlyRunAt(): number { return this._nextHourlyRunAt }
  get lastDailyRunAt(): number { return this._lastDailyRunAt }
  get lastDailyDurationMs(): number | null { return this._lastDailyDurationMs }
  get nextDailyRunAt(): number { return this._nextDailyRunAt }
  get uptimeSeconds(): number { return Math.floor((Date.now() - this._startedAt) / 1000) }

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
    this._nextHourlyRunAt = now + msUntilNextHour

    setTimeout(() => {
      if (this.stopped) return
      void this.runHourly()
      this.hourlyTimer = setInterval(() => {
        this._nextHourlyRunAt = Date.now() + 3_600_000
        void this.runHourly()
      }, 3_600_000)
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
    const start = Date.now()
    try {
      // Aggregate the previous completed hour.
      const now = new Date()
      const hourEnd = new Date(now)
      hourEnd.setUTCMinutes(0, 0, 0)
      const hourStart = new Date(hourEnd.getTime() - 3_600_000)

      const count = await aggregateHour(this.adapter, hourStart, hourEnd)

      const durationMs = Date.now() - start
      this._lastHourlyRunAt = Date.now()
      this._lastHourlyDurationMs = durationMs

      eventBus.emit('aggregation:run', {
        timestamp: new Date(),
        kind: 'hourly',
        durationMs,
        rowsIn: 0,
        rowsOut: count,
        ok: true,
      })
    } catch (err) {
      const durationMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      this._lastHourlyRunAt = Date.now()
      this._lastHourlyDurationMs = durationMs
      eventBus.emit('aggregation:run', {
        timestamp: new Date(),
        kind: 'hourly',
        durationMs,
        rowsIn: 0,
        rowsOut: 0,
        ok: false,
        error: message,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Daily rollup + cleanup
  // ---------------------------------------------------------------------------

  private scheduleDailyRun(): void {
    const msUntilDaily = this.msUntilDailyTime()
    this._nextDailyRunAt = Date.now() + msUntilDaily
    this.dailyTimer = setTimeout(() => {
      if (this.stopped) return
      void this.runDaily()
      // Reschedule for next day.
      this.scheduleDailyRun()
    }, msUntilDaily)
  }

  private async runDaily(): Promise<void> {
    const start = Date.now()
    try {
      // Aggregate yesterday's hourly summaries into a daily summary.
      const yesterday = new Date()
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      yesterday.setUTCHours(0, 0, 0, 0)

      const count = await aggregateDay(this.adapter, yesterday)

      const dailyDurationMs = Date.now() - start

      // Run retention cleanup separately so its duration is measured honestly
      // — both events feed the aggregator probe, and reporting 0 for cleanup
      // hides slow retention sweeps.
      const cleanupStart = Date.now()
      const cleanup = await runCleanup(this.adapter, this.config)
      const cleanupDurationMs = Date.now() - cleanupStart

      this._lastDailyRunAt = Date.now()
      this._lastDailyDurationMs = dailyDurationMs + cleanupDurationMs

      eventBus.emit('aggregation:run', {
        timestamp: new Date(),
        kind: 'daily',
        durationMs: dailyDurationMs,
        rowsIn: 0,
        rowsOut: count,
        ok: true,
      })
      eventBus.emit('aggregation:run', {
        timestamp: new Date(),
        kind: 'cleanup',
        durationMs: cleanupDurationMs,
        rowsIn: 0,
        rowsOut:
          cleanup.hourlyDeleted +
          cleanup.dailyDeleted +
          cleanup.notificationLogsRedacted,
        ok: true,
      })
    } catch (err) {
      const durationMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      this._lastDailyRunAt = Date.now()
      this._lastDailyDurationMs = durationMs
      eventBus.emit('aggregation:run', {
        timestamp: new Date(),
        kind: 'daily',
        durationMs,
        rowsIn: 0,
        rowsOut: 0,
        ok: false,
        error: message,
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
