import type { Pool } from 'pg'
import { eventBus } from '../../core/eventBus.js'
import type { WatchDeckConfig } from '../../config/types.js'

const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const BATCH_SIZE = 10_000

/**
 * Replaces Mongo's TTL indexes for the Postgres backend. Every ten minutes
 * it issues `DELETE` statements (batched via `LIMIT` subqueries) on the
 * three tables with natural expiry columns:
 *
 *   - mx_checks              (timestamp older than `retention.detailedDays`)
 *   - mx_notification_log    (sent_at older than `retention.notificationLogDays`)
 *   - mx_notification_mutes  (expires_at in the past)
 *   - mx_internal_incidents  (expires_at set and in the past)
 *
 * Hourly/daily summaries are pruned by the existing AggregationScheduler's
 * cleanup phase — this sweeper doesn't touch them.
 */
export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly pool: Pool,
    private readonly prefix: string,
    private readonly config: WatchDeckConfig,
  ) {}

  start(): void {
    if (this.timer) return
    // Kick off the first sweep on a short delay so boot-time logging isn't
    // noisy; after that, steady-state 10-minute cadence.
    this.timer = setTimeout(() => {
      this.tick().finally(() => this.reschedule())
    }, 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private reschedule(): void {
    if (!this.timer) return
    this.timer = setTimeout(() => {
      this.tick().finally(() => this.reschedule())
    }, SWEEP_INTERVAL_MS)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const startedAt = Date.now()
    try {
      const { detailedDays, notificationLogDays } = this.config.retention
      await this.sweepOldByColumn(
        `${this.prefix}checks`,
        'timestamp',
        detailedDays,
      )
      await this.sweepOldByColumn(
        `${this.prefix}notification_log`,
        'sent_at',
        notificationLogDays,
      )
      await this.sweepExpired(`${this.prefix}notification_mutes`, 'expires_at')
      await this.sweepExpired(`${this.prefix}internal_incidents`, 'expires_at')
    } catch (err) {
      eventBus.emit('db:error', {
        timestamp: new Date(),
        error: err instanceof Error ? err : new Error(String(err)),
        context: 'retention sweep',
      })
    } finally {
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > SWEEP_INTERVAL_MS) {
        // Sweep took longer than one cycle — the table has grown beyond what a
        // single ten-minute window can keep clean. Surface this so operators
        // can size up or archive-cold old data.
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: new Error(
            `Retention sweep exceeded its ${SWEEP_INTERVAL_MS / 1000}s interval (took ${Math.round(elapsedMs / 1000)}s)`,
          ),
          context: 'retention sweep slow',
        })
      }
      this.running = false
    }
  }

  /**
   * Delete rows where `<column>` is older than `days` days. Batched via a
   * `ctid IN (SELECT ... LIMIT)` subquery so one sweep doesn't acquire a
   * huge row lock or flood the WAL.
   */
  private async sweepOldByColumn(table: string, column: string, days: number): Promise<void> {
    if (days <= 0) return
    for (;;) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM ${table}
         WHERE ctid IN (
           SELECT ctid FROM ${table}
           WHERE ${column} < now() - make_interval(days => $1)
           LIMIT ${BATCH_SIZE}
         )`,
        [days],
      )
      if (!rowCount || rowCount < BATCH_SIZE) return
    }
  }

  private async sweepExpired(table: string, column: string): Promise<void> {
    for (;;) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM ${table}
         WHERE ctid IN (
           SELECT ctid FROM ${table}
           WHERE ${column} IS NOT NULL AND ${column} < now()
           LIMIT ${BATCH_SIZE}
         )`,
      )
      if (!rowCount || rowCount < BATCH_SIZE) return
    }
  }
}
