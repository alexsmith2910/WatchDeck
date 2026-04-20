/**
 * Abstract provider contract.
 *
 * Concrete provider classes implement `send()` and `test()` to deliver a
 * `NotificationMessage` to a real channel (Discord / Slack / email / webhook).
 *
 * The dispatcher doesn't know anything about individual providers — it only
 * calls these three methods. Adding a new channel type is a matter of
 * dropping in one more subclass under `providers/`.
 */

import type { NotificationChannelType } from '../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../types.js'

export abstract class NotificationProvider {
  abstract readonly type: NotificationChannelType

  /** Send one message to one channel. Must always resolve — never throw. */
  abstract send(msg: NotificationMessage, target: ChannelTarget): Promise<ProviderResult>

  /** Send a synthetic test message so the user can verify the wiring. */
  abstract test(target: ChannelTarget): Promise<ProviderResult>

  /**
   * Pre-flight validation — called before a channel is saved. Returns a
   * structured result rather than throwing so the caller can collect
   * multi-field errors uniformly.
   */
  abstract validateTarget(channel: ChannelTarget): ValidationResult
}

/** Helper used by stub providers to synthesise a consistent "not implemented" result. */
export function notImplementedResult(provider: string): ProviderResult {
  return {
    status: 'skipped',
    latencyMs: 0,
    failureReason: `${provider} provider is not yet implemented — see notifications-plan.md §10 (Step B excludes provider bodies).`,
  }
}
