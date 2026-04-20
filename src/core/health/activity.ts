/**
 * Tiny user-plane activity collector.
 *
 * The System Health page intentionally keeps one user-plane metric visible —
 * "checks per second" over the last ~minute — labelled as an activity readout,
 * NOT as a health signal. This module provides exactly that, and nothing else.
 *
 * It listens to `check:complete` events and groups completions into 1-second
 * buckets. It does not infer any status, latency, or error information from
 * those events — that is forbidden by the health redesign spec.
 */

import { eventBus } from '../eventBus.js'

const BUCKET_CAPACITY = 600 // 10 minutes at 1 bucket/second is plenty of head-room.

interface ActivityBucket {
  ts: number // epoch ms at the top of the second
  count: number
}

class ActivityCollector {
  private buckets: ActivityBucket[] = []
  private unsubscribe: (() => void) | null = null

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = eventBus.subscribe(
      'check:complete',
      () => this.recordOne(),
      'low',
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Currently-buffered buckets, oldest first. Mostly useful for tests. */
  peekBuckets(): ReadonlyArray<ActivityBucket> {
    return this.buckets
  }

  /**
   * Return `count` most recent 1-second buckets (oldest first), padding with
   * zero-count buckets when there has been no recent traffic. Each bucket
   * gives `checksPerSec` (since the bucket is 1s wide that is just `count`).
   */
  recentPerSecond(count = 60): Array<{ ts: number; checksPerSec: number }> {
    const now = Math.floor(Date.now() / 1000) * 1000
    const start = now - (count - 1) * 1000
    const byTs = new Map<number, number>()
    for (const b of this.buckets) {
      if (b.ts >= start && b.ts <= now) byTs.set(b.ts, b.count)
    }
    const out: Array<{ ts: number; checksPerSec: number }> = []
    for (let i = 0; i < count; i++) {
      const ts = start + i * 1000
      out.push({ ts, checksPerSec: byTs.get(ts) ?? 0 })
    }
    return out
  }

  private recordOne(): void {
    const ts = Math.floor(Date.now() / 1000) * 1000
    const last = this.buckets.at(-1)
    if (last && last.ts === ts) {
      last.count += 1
    } else {
      this.buckets.push({ ts, count: 1 })
      if (this.buckets.length > BUCKET_CAPACITY) {
        this.buckets.splice(0, this.buckets.length - BUCKET_CAPACITY)
      }
    }
  }
}

export const activity = new ActivityCollector()
