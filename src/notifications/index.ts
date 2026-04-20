/**
 * Notifications module entry point.
 *
 * `register()` builds the dispatcher with its collaborators and wires event
 * subscriptions. Returned instance exposes `start()`/`stop()` so the caller
 * (`start.ts`) owns lifecycle.
 */

import type { WatchDeckConfig } from '../config/types.js'
import type { StorageAdapter } from '../storage/adapter.js'
import { NotificationDispatcher } from './dispatcher.js'

export { NotificationDispatcher } from './dispatcher.js'
export { notificationMetrics } from './metrics.js'

export interface RegisterNotificationsOpts {
  adapter: StorageAdapter
  config: WatchDeckConfig
  port: number
}

export function registerNotifications(
  opts: RegisterNotificationsOpts,
): NotificationDispatcher {
  return new NotificationDispatcher({
    adapter: opts.adapter,
    config: opts.config,
    baseUrl: `http://localhost:${opts.port}`,
  })
}
