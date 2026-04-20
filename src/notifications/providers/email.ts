/**
 * Email provider — stub. SMTP transport lands in the email-provider PR.
 */

import type { NotificationChannelType } from '../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../types.js'
import { NotificationProvider, notImplementedResult } from './provider.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class EmailProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'email'

  async send(_msg: NotificationMessage, _target: ChannelTarget): Promise<ProviderResult> {
    return notImplementedResult('Email')
  }

  async test(_target: ChannelTarget): Promise<ProviderResult> {
    return notImplementedResult('Email')
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'email') {
      return { valid: false, error: `Expected channel type 'email', got '${channel.type}'` }
    }
    if (!channel.emailRecipients || channel.emailRecipients.length === 0) {
      return { valid: false, error: 'At least one recipient is required' }
    }
    const bad = channel.emailRecipients.find((addr) => !EMAIL_RE.test(addr))
    if (bad) return { valid: false, error: `Invalid recipient address: ${bad}` }
    return { valid: true }
  }
}
