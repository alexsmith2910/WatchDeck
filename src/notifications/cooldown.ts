/**
 * Cooldown + dedup trackers — both in-memory, both keyed on strings.
 *
 * `CooldownTracker` — endpoint × channel × kind windows to throttle repeat
 * alerts during flapping ("open / close / open / close"). Expires entries
 * lazily based on `cooldownSeconds` supplied at check time.
 *
 * `DedupTracker` — incident × channel × kind one-shot keys so a retried or
 * replayed event can't double-dispatch. Entries are cleared at incident
 * resolution; residual entries are pruned by maxAge as a safety net.
 */

import type { NotificationKind } from '../storage/types.js'

function cooldownKey(endpointId: string, channelId: string, kind: NotificationKind): string {
  return `${endpointId}|${channelId}|${kind}`
}

function dedupKey(incidentId: string, channelId: string, kind: NotificationKind): string {
  return `${incidentId}|${channelId}|${kind}`
}

export class CooldownTracker {
  /** Key → earliest instant at which another dispatch of this tuple is allowed. */
  private readonly next = new Map<string, number>()

  /** Is this tuple still cooling down right now? */
  inCooldown(endpointId: string, channelId: string, kind: NotificationKind): boolean {
    const exp = this.next.get(cooldownKey(endpointId, channelId, kind))
    if (exp === undefined) return false
    if (exp <= Date.now()) {
      this.next.delete(cooldownKey(endpointId, channelId, kind))
      return false
    }
    return true
  }

  /** Stamp a successful dispatch to start the next cooldown window. */
  stamp(
    endpointId: string,
    channelId: string,
    kind: NotificationKind,
    cooldownSeconds: number,
  ): void {
    if (cooldownSeconds <= 0) return
    this.next.set(cooldownKey(endpointId, channelId, kind), Date.now() + cooldownSeconds * 1000)
  }

  clearEndpoint(endpointId: string): void {
    for (const key of this.next.keys()) {
      if (key.startsWith(`${endpointId}|`)) this.next.delete(key)
    }
  }

  size(): number {
    return this.next.size
  }
}

export class DedupTracker {
  /** Key → timestamp it was first seen. */
  private readonly seen = new Map<string, number>()

  constructor(private readonly maxAgeMs: number = 24 * 60 * 60_000) {}

  /**
   * Records the tuple as dispatched. Returns `true` if it was already seen
   * (i.e. the caller should drop this dispatch as a duplicate).
   */
  markIfNew(incidentId: string, channelId: string, kind: NotificationKind): boolean {
    this.evictStale()
    const key = dedupKey(incidentId, channelId, kind)
    if (this.seen.has(key)) return true
    this.seen.set(key, Date.now())
    return false
  }

  clearIncident(incidentId: string): void {
    for (const key of this.seen.keys()) {
      if (key.startsWith(`${incidentId}|`)) this.seen.delete(key)
    }
  }

  size(): number {
    return this.seen.size
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [key, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(key)
    }
  }
}
