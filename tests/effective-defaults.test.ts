/**
 * Effective-defaults override merge tests.
 *
 * Covers `adapter.getEffectiveDefaults()` / `adapter.getEffectiveSlo()`:
 *   - empty mx_settings → returns ctx.config values unchanged
 *   - partial override  → only the overridden keys are swapped
 *   - full override     → every key lifts off config
 *
 * Run: npx tsx tests/effective-defaults.test.ts
 */

import { StorageAdapter } from '../src/storage/adapter.js'
import type {
  CheckDoc,
  CheckWritePayload,
  DailySummaryDoc,
  EndpointDoc,
  HealthStateDoc,
  HourlySummaryDoc,
  IncidentDoc,
  InternalIncidentDoc,
  NotificationChannelDoc,
  NotificationLogDoc,
  NotificationMuteDoc,
  NotificationPreferencesDoc,
  SettingsDoc,
  SystemEventDoc,
} from '../src/storage/types.js'
import type { WatchDeckConfig } from '../src/config/types.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`)
    passed++
  } else {
    console.log(`  ✗  ${label}${detail ? `  →  ${detail}` : ''}`)
    failed++
  }
}

/**
 * Tiny in-memory adapter that satisfies the abstract class just enough to
 * exercise getEffectiveDefaults / getEffectiveSlo. Every other method throws
 * so a bug in those helpers (calling into unexpected paths) surfaces loudly.
 */
class FakeAdapter extends StorageAdapter {
  settings: SettingsDoc

  constructor(settings: SettingsDoc) {
    super()
    this.settings = settings
  }

  async getSettings(): Promise<SettingsDoc> {
    return this.settings
  }

  async updateSettings(): Promise<SettingsDoc> {
    throw new Error('not used in this test')
  }

  async hardReset(): Promise<Record<string, number>> {
    throw new Error('not used in this test')
  }

  // All other abstract methods throw — we never call them here.
  connect(): never { throw new Error('unused') }
  disconnect(): never { throw new Error('unused') }
  healthCheck(): never { throw new Error('unused') }
  isConnected(): never { throw new Error('unused') }
  currentOutageDuration(): never { throw new Error('unused') }
  reconnectAttempt(): never { throw new Error('unused') }
  migrate(): never { throw new Error('unused') }
  saveCheck(_: CheckWritePayload): never { throw new Error('unused') }
  saveManyChecks(_: CheckWritePayload[]): never { throw new Error('unused') }
  createSystemEvent(_: SystemEventDoc): never { throw new Error('unused') }
  updateSystemEvent(): never { throw new Error('unused') }
  listEndpoints(): never { throw new Error('unused') }
  listEnabledEndpoints(): never { throw new Error('unused') }
  getEndpointById(_: string): never { throw new Error('unused') }
  updateEndpoint(): never { throw new Error('unused') }
  createEndpoint(_: Omit<EndpointDoc, 'id' | 'createdAt' | 'updatedAt'>): never { throw new Error('unused') }
  deleteEndpoint(_: string): never { throw new Error('unused') }
  updateEndpointAfterCheck(): never { throw new Error('unused') }
  getLatestCheckForEndpoint(): never { throw new Error('unused') }
  getChecksForEndpoint(): never { throw new Error('unused') }
  getHourlySummariesForEndpoint(): never { throw new Error('unused') }
  getDailySummariesForEndpoint(): never { throw new Error('unused') }
  countHealthyChecksSince(): never { throw new Error('unused') }
  writeHourlySummary(_: HourlySummaryDoc): never { throw new Error('unused') }
  writeDailySummary(_: DailySummaryDoc): never { throw new Error('unused') }
  deleteChecksBefore(): never { throw new Error('unused') }
  deleteHourlySummariesBefore(): never { throw new Error('unused') }
  getActiveIncidents(): never { throw new Error('unused') }
  getIncidents(): never { throw new Error('unused') }
  createIncident(_: IncidentDoc): never { throw new Error('unused') }
  getIncidentById(): never { throw new Error('unused') }
  updateIncident(): never { throw new Error('unused') }
  getActiveIncidentForEndpoint(): never { throw new Error('unused') }
  getIncidentStats(): never { throw new Error('unused') }
  listNotificationChannels(): never { throw new Error('unused') }
  getNotificationChannelById(): never { throw new Error('unused') }
  createNotificationChannel(_: Omit<NotificationChannelDoc, 'id'>): never { throw new Error('unused') }
  updateNotificationChannel(): never { throw new Error('unused') }
  deleteNotificationChannel(): never { throw new Error('unused') }
  appendNotificationLog(_: Omit<NotificationLogDoc, 'id'>): never { throw new Error('unused') }
  getNotificationLog(): never { throw new Error('unused') }
  getNotificationLogById(): never { throw new Error('unused') }
  getNotificationStats(): never { throw new Error('unused') }
  listScheduledEscalations(): never { throw new Error('unused') }
  getNotificationPreferences(): never { throw new Error('unused') }
  updateNotificationPreferences(): never { throw new Error('unused') }
  listNotificationMutes(): never { throw new Error('unused') }
  createNotificationMute(_: Omit<NotificationMuteDoc, 'id'>): never { throw new Error('unused') }
  deleteNotificationMute(): never { throw new Error('unused') }
  findActiveNotificationMute(): never { throw new Error('unused') }
  deleteDailySummariesBefore(): never { throw new Error('unused') }
  getEndpointIdsWithChecks(): never { throw new Error('unused') }
  saveHealthState(_: Omit<HealthStateDoc, 'id'>): never { throw new Error('unused') }
  loadHealthState(): never { throw new Error('unused') }
  listInternalIncidents(): never { throw new Error('unused') }
  upsertInternalIncident(_: InternalIncidentDoc): never { throw new Error('unused') }
  listPaginatedChecks(): never { throw new Error('unused') }
  getChecksByIds(): never { throw new Error('unused') }
  getNotificationLogByIncidentId(): never { throw new Error('unused') }
  retryNotificationLog(): never { throw new Error('unused') }
}

const baseConfig: Pick<WatchDeckConfig, 'defaults' | 'slo'> = {
  defaults: {
    checkInterval: 60,
    timeout: 10_000,
    expectedStatusCodes: [200],
    latencyThreshold: 5_000,
    sslWarningDays: 14,
    failureThreshold: 3,
    recoveryThreshold: 2,
    alertCooldown: 900,
    recoveryAlert: true,
    escalationDelay: 1_800,
    notifications: {
      enabled: true,
      severityFloor: 'warning+',
      sendOpen: true,
      sendResolved: true,
      sendEscalation: true,
      retryOnFailure: true,
      retryBackoffMs: [2000, 8000, 30000],
      coalescing: { enabled: true, windowSeconds: 60, minBurstCount: 3, bypassSeverity: 'critical' },
      channelDefaults: {
        discord: { rateLimitPerMinute: 30 },
        slack: { rateLimitPerMinute: 30 },
        email: { rateLimitPerMinute: 10 },
        webhook: { rateLimitPerMinute: 60 },
      },
    },
  },
  slo: { target: 99.9, windowDays: 30 },
}

async function main(): Promise<void> {
  console.log('\n--- Effective-defaults override merge ---\n')

  // Empty override → everything passes through.
  {
    const adapter = new FakeAdapter({ id: 'global' })
    const d = await adapter.getEffectiveDefaults(baseConfig as WatchDeckConfig)
    assert(d.checkInterval === 60, 'empty override: checkInterval falls through', String(d.checkInterval))
    assert(d.timeout === 10_000, 'empty override: timeout falls through', String(d.timeout))
    assert(d.recoveryAlert === true, 'empty override: recoveryAlert falls through', String(d.recoveryAlert))

    const s = await adapter.getEffectiveSlo(baseConfig as WatchDeckConfig)
    assert(s.target === 99.9, 'empty override: SLO target falls through', String(s.target))
    assert(s.windowDays === 30, 'empty override: SLO windowDays falls through', String(s.windowDays))
  }

  // Partial override → only named keys replace, rest pass through.
  {
    const adapter = new FakeAdapter({
      id: 'global',
      defaults: { checkInterval: 30, recoveryAlert: false },
    })
    const d = await adapter.getEffectiveDefaults(baseConfig as WatchDeckConfig)
    assert(d.checkInterval === 30, 'partial override: checkInterval replaced', String(d.checkInterval))
    assert(d.recoveryAlert === false, 'partial override: recoveryAlert replaced', String(d.recoveryAlert))
    assert(d.timeout === 10_000, 'partial override: timeout still from config', String(d.timeout))
    assert(d.latencyThreshold === 5_000, 'partial override: latencyThreshold still from config', String(d.latencyThreshold))
  }

  // Full override → every key lifts off config.
  {
    const adapter = new FakeAdapter({
      id: 'global',
      defaults: {
        checkInterval: 120,
        timeout: 20_000,
        expectedStatusCodes: [200, 204],
        latencyThreshold: 1000,
        sslWarningDays: 7,
        failureThreshold: 5,
        alertCooldown: 300,
        recoveryAlert: false,
        escalationDelay: 600,
      },
      slo: { target: 99.99, windowDays: 60 },
    })
    const d = await adapter.getEffectiveDefaults(baseConfig as WatchDeckConfig)
    assert(d.checkInterval === 120, 'full override: checkInterval', String(d.checkInterval))
    assert(d.timeout === 20_000, 'full override: timeout', String(d.timeout))
    assert(d.latencyThreshold === 1000, 'full override: latencyThreshold', String(d.latencyThreshold))
    assert(d.sslWarningDays === 7, 'full override: sslWarningDays', String(d.sslWarningDays))
    assert(d.failureThreshold === 5, 'full override: failureThreshold', String(d.failureThreshold))
    assert(d.alertCooldown === 300, 'full override: alertCooldown', String(d.alertCooldown))
    assert(d.recoveryAlert === false, 'full override: recoveryAlert', String(d.recoveryAlert))
    assert(d.escalationDelay === 600, 'full override: escalationDelay', String(d.escalationDelay))
    assert(
      d.expectedStatusCodes.length === 2 && d.expectedStatusCodes[0] === 200 && d.expectedStatusCodes[1] === 204,
      'full override: expectedStatusCodes',
      JSON.stringify(d.expectedStatusCodes),
    )

    const s = await adapter.getEffectiveSlo(baseConfig as WatchDeckConfig)
    assert(s.target === 99.99, 'full override: SLO target', String(s.target))
    assert(s.windowDays === 60, 'full override: SLO windowDays', String(s.windowDays))
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
