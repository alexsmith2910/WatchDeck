/**
 * Per-channel token-bucket rate limiter.
 *
 * Each channel gets a bucket with capacity `maxPerMinute` tokens that
 * refills at `maxPerMinute / 60` tokens per second. `tryConsume()` returns
 * whether the dispatch is allowed right now; on deny, the dispatcher
 * should record a `suppressedReason: 'rate_limit'` log row.
 */

interface Bucket {
  tokens: number
  capacity: number
  refillPerSec: number
  lastRefillMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  /** Re-sync a channel's bucket when its `maxPerMinute` changes. Idempotent. */
  configure(channelId: string, maxPerMinute: number): void {
    const existing = this.buckets.get(channelId)
    const capacity = Math.max(1, Math.floor(maxPerMinute))
    if (existing && existing.capacity === capacity) return
    this.buckets.set(channelId, {
      tokens: capacity,
      capacity,
      refillPerSec: capacity / 60,
      lastRefillMs: Date.now(),
    })
  }

  tryConsume(channelId: string, maxPerMinute: number): boolean {
    this.configure(channelId, maxPerMinute)
    const bucket = this.buckets.get(channelId)!
    this.refill(bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  remove(channelId: string): void {
    this.buckets.delete(channelId)
  }

  private refill(bucket: Bucket): void {
    const now = Date.now()
    const elapsedSec = (now - bucket.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.refillPerSec)
    bucket.lastRefillMs = now
  }
}
