/**
 * Slack provider — stub. Block-kit formatting lands in the Slack-bot PR.
 */

import type { NotificationChannelType } from '../../storage/types.js'
import type {
  ChannelTarget,
  NotificationMessage,
  ProviderResult,
  ValidationResult,
} from '../types.js'
import { NotificationProvider, notImplementedResult } from './provider.js'

export class SlackProvider extends NotificationProvider {
  readonly type: NotificationChannelType = 'slack'

  async send(_msg: NotificationMessage, _target: ChannelTarget): Promise<ProviderResult> {
    return notImplementedResult('Slack')
  }

  async test(_target: ChannelTarget): Promise<ProviderResult> {
    return notImplementedResult('Slack')
  }

  validateTarget(channel: ChannelTarget): ValidationResult {
    if (channel.type !== 'slack') {
      return { valid: false, error: `Expected channel type 'slack', got '${channel.type}'` }
    }
    if (!channel.slackWebhookUrl || !channel.slackWebhookUrl.startsWith('https://')) {
      return {
        valid: false,
        error: 'slackWebhookUrl is required and must start with https://',
      }
    }
    return { valid: true }
  }
}
