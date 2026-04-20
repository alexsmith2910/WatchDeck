import {
  formatValidationReport,
  formatWarning,
  type ValidationError,
} from '../utils/errors.js'
import type { LoadedEnv } from './envLoader.js'
import type { WatchDeckConfig } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v)
}

function push(
  errors: ValidationError[],
  field: string,
  value: unknown,
  expected: string,
  fix: string,
): void {
  errors.push({ field, value, expected, fix })
}

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj as object)) {
    const val = (obj as Record<string, unknown>)[key]
    if (typeof val === 'object' && val !== null && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateServer(cfg: WatchDeckConfig, errors: ValidationError[]): void {
  if (!isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    push(
      errors,
      'port',
      cfg.port,
      'integer between 1 and 65535',
      'Set port to a valid TCP port number',
    )
  }

  if (typeof cfg.apiBasePath !== 'string' || !cfg.apiBasePath.startsWith('/')) {
    push(
      errors,
      'apiBasePath',
      cfg.apiBasePath,
      'string starting with "/"',
      'Set apiBasePath to a path like "/api/mx"',
    )
  }

  if (
    typeof cfg.dashboardRoute !== 'string' ||
    !cfg.dashboardRoute.startsWith('/')
  ) {
    push(
      errors,
      'dashboardRoute',
      cfg.dashboardRoute,
      'string starting with "/"',
      'Set dashboardRoute to a path like "/dashboard"',
    )
  }

  if (cfg.dashboardMode !== 'standalone' && cfg.dashboardMode !== 'mounted') {
    push(
      errors,
      'dashboardMode',
      cfg.dashboardMode,
      '"standalone" or "mounted"',
      'Set dashboardMode to "standalone" or "mounted"',
    )
  }
}

function validateDefaults(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  const d = cfg.defaults
  const ALLOWED_INTERVALS = [30, 60, 120, 300, 600]

  if (!ALLOWED_INTERVALS.includes(d.checkInterval)) {
    push(
      errors,
      'defaults.checkInterval',
      d.checkInterval,
      `one of [${ALLOWED_INTERVALS.join(', ')}] seconds`,
      'Use one of the allowed check intervals',
    )
  }

  if (!isInteger(d.timeout) || d.timeout < 1000 || d.timeout > 60_000) {
    push(
      errors,
      'defaults.timeout',
      d.timeout,
      'integer between 1000 and 60000 ms',
      'Set defaults.timeout to a value in milliseconds within the allowed range',
    )
  }

  if (
    !Array.isArray(d.expectedStatusCodes) ||
    d.expectedStatusCodes.length === 0 ||
    !d.expectedStatusCodes.every((c) => isInteger(c) && c >= 100 && c <= 599)
  ) {
    push(
      errors,
      'defaults.expectedStatusCodes',
      d.expectedStatusCodes,
      'non-empty array of HTTP status codes (100–599)',
      'Provide at least one valid HTTP status code, e.g. [200]',
    )
  }

  if (
    !isInteger(d.latencyThreshold) ||
    d.latencyThreshold < 100 ||
    d.latencyThreshold > 30_000
  ) {
    push(
      errors,
      'defaults.latencyThreshold',
      d.latencyThreshold,
      'integer between 100 and 30000 ms',
      'Set defaults.latencyThreshold within the allowed range',
    )
  }

  const ALLOWED_SSL_DAYS = [7, 14, 30]
  if (!ALLOWED_SSL_DAYS.includes(d.sslWarningDays)) {
    push(
      errors,
      'defaults.sslWarningDays',
      d.sslWarningDays,
      `one of [${ALLOWED_SSL_DAYS.join(', ')}] days`,
      'Set defaults.sslWarningDays to 7, 14, or 30',
    )
  }

  if (!isInteger(d.failureThreshold) || d.failureThreshold < 1 || d.failureThreshold > 10) {
    push(
      errors,
      'defaults.failureThreshold',
      d.failureThreshold,
      'integer between 1 and 10',
      'Set defaults.failureThreshold to the number of consecutive failures before an incident opens',
    )
  }

  if (!isInteger(d.alertCooldown) || d.alertCooldown < 300 || d.alertCooldown > 7200) {
    push(
      errors,
      'defaults.alertCooldown',
      d.alertCooldown,
      'integer between 300 and 7200 seconds',
      'Set defaults.alertCooldown to limit repeated alert notifications',
    )
  }

  if (typeof d.recoveryAlert !== 'boolean') {
    push(
      errors,
      'defaults.recoveryAlert',
      d.recoveryAlert,
      'boolean',
      'Set defaults.recoveryAlert to true or false',
    )
  }

  if (!isInteger(d.escalationDelay) || d.escalationDelay < 0 || d.escalationDelay > 86_400) {
    push(
      errors,
      'defaults.escalationDelay',
      d.escalationDelay,
      'integer between 0 and 86400 seconds (0 disables escalation)',
      'Set defaults.escalationDelay to a delay in seconds, or 0 to disable',
    )
  }

  validateNotifications(cfg, errors)
}

const ALLOWED_SEVERITY_FILTERS = ['info+', 'warning+', 'critical'] as const
const ALLOWED_BYPASS_SEVERITIES = ['info', 'warning', 'critical'] as const
const TIME_HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function validateNotifications(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  const n = cfg.defaults.notifications

  if (!n || typeof n !== 'object') {
    push(
      errors,
      'defaults.notifications',
      n,
      'object',
      'Restore the defaults.notifications block (see src/config/defaults.ts)',
    )
    return
  }

  if (typeof n.enabled !== 'boolean') {
    push(errors, 'defaults.notifications.enabled', n.enabled, 'boolean', 'Set to true or false')
  }

  if (!ALLOWED_SEVERITY_FILTERS.includes(n.severityFloor)) {
    push(
      errors,
      'defaults.notifications.severityFloor',
      n.severityFloor,
      `one of ["${ALLOWED_SEVERITY_FILTERS.join('", "')}"]`,
      'Set severityFloor to "info+", "warning+", or "critical"',
    )
  }

  for (const key of ['sendOpen', 'sendResolved', 'sendEscalation', 'alertDuringMaintenance', 'retryOnFailure'] as const) {
    if (typeof n[key] !== 'boolean') {
      push(errors, `defaults.notifications.${key}`, n[key], 'boolean', `Set ${key} to true or false`)
    }
  }

  if (
    !Array.isArray(n.retryBackoffMs) ||
    n.retryBackoffMs.length === 0 ||
    !n.retryBackoffMs.every((v) => isInteger(v) && v >= 0 && v <= 600_000)
  ) {
    push(
      errors,
      'defaults.notifications.retryBackoffMs',
      n.retryBackoffMs,
      'non-empty array of integers (0–600000 ms each)',
      'Provide a retry backoff schedule, e.g. [2000, 8000, 30000]',
    )
  }

  const c = n.coalescing
  if (!c || typeof c !== 'object') {
    push(
      errors,
      'defaults.notifications.coalescing',
      c,
      'object',
      'Restore the defaults.notifications.coalescing block',
    )
  } else {
    if (typeof c.enabled !== 'boolean') {
      push(errors, 'defaults.notifications.coalescing.enabled', c.enabled, 'boolean', 'Set to true or false')
    }
    if (!isInteger(c.windowSeconds) || c.windowSeconds < 5 || c.windowSeconds > 600) {
      push(
        errors,
        'defaults.notifications.coalescing.windowSeconds',
        c.windowSeconds,
        'integer between 5 and 600 seconds',
        'Set coalescing.windowSeconds within the allowed range',
      )
    }
    if (!isInteger(c.minBurstCount) || c.minBurstCount < 2 || c.minBurstCount > 100) {
      push(
        errors,
        'defaults.notifications.coalescing.minBurstCount',
        c.minBurstCount,
        'integer between 2 and 100',
        'Set coalescing.minBurstCount within the allowed range',
      )
    }
    if (!ALLOWED_BYPASS_SEVERITIES.includes(c.bypassSeverity)) {
      push(
        errors,
        'defaults.notifications.coalescing.bypassSeverity',
        c.bypassSeverity,
        `one of ["${ALLOWED_BYPASS_SEVERITIES.join('", "')}"]`,
        'Set bypassSeverity to "info", "warning", or "critical"',
      )
    }
  }

  if (n.quietHours !== null) {
    if (
      !n.quietHours ||
      typeof n.quietHours !== 'object' ||
      typeof n.quietHours.start !== 'string' ||
      !TIME_HHMM_RE.test(n.quietHours.start) ||
      typeof n.quietHours.end !== 'string' ||
      !TIME_HHMM_RE.test(n.quietHours.end) ||
      typeof n.quietHours.tz !== 'string' ||
      n.quietHours.tz.trim() === ''
    ) {
      push(
        errors,
        'defaults.notifications.quietHours',
        n.quietHours,
        '{ start: "HH:MM", end: "HH:MM", tz: IANA zone } or null',
        'Provide a valid quiet hours object, or set to null to disable',
      )
    }
  }

  const cd = n.channelDefaults
  if (!cd || typeof cd !== 'object') {
    push(
      errors,
      'defaults.notifications.channelDefaults',
      cd,
      'object',
      'Restore the defaults.notifications.channelDefaults block',
    )
  } else {
    for (const channel of ['discord', 'slack', 'email', 'webhook'] as const) {
      const entry = cd[channel]
      const rl = entry?.rateLimitPerMinute
      if (!isInteger(rl) || rl < 1 || rl > 1000) {
        push(
          errors,
          `defaults.notifications.channelDefaults.${channel}.rateLimitPerMinute`,
          rl,
          'integer between 1 and 1000',
          `Set channelDefaults.${channel}.rateLimitPerMinute within the allowed range`,
        )
      }
    }
  }
}

function validateRetention(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  const r = cfg.retention

  const ALLOWED_DETAILED = [7, 14, 30]
  if (!ALLOWED_DETAILED.includes(r.detailedDays)) {
    push(
      errors,
      'retention.detailedDays',
      r.detailedDays,
      `one of [${ALLOWED_DETAILED.join(', ')}] days`,
      'Set retention.detailedDays to 7, 14, or 30',
    )
  }

  const ALLOWED_HOURLY = [30, 60, 90]
  if (!ALLOWED_HOURLY.includes(r.hourlyDays)) {
    push(
      errors,
      'retention.hourlyDays',
      r.hourlyDays,
      `one of [${ALLOWED_HOURLY.join(', ')}] days`,
      'Set retention.hourlyDays to 30, 60, or 90',
    )
  }

  const ALLOWED_DAILY = ['6months', '1year', 'indefinite'] as const
  if (!ALLOWED_DAILY.includes(r.daily as (typeof ALLOWED_DAILY)[number])) {
    push(
      errors,
      'retention.daily',
      r.daily,
      '"6months", "1year", or "indefinite"',
      'Set retention.daily to one of the allowed values',
    )
  }

  const ALLOWED_NOTIF = [30, 60, 90]
  if (!ALLOWED_NOTIF.includes(r.notificationLogDays)) {
    push(
      errors,
      'retention.notificationLogDays',
      r.notificationLogDays,
      `one of [${ALLOWED_NOTIF.join(', ')}] days`,
      'Set retention.notificationLogDays to 30, 60, or 90',
    )
  }
}

function validateRateLimits(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  const rl = cfg.rateLimits

  if (!isInteger(rl.minCheckInterval) || rl.minCheckInterval < 1) {
    push(
      errors,
      'rateLimits.minCheckInterval',
      rl.minCheckInterval,
      'positive integer (seconds)',
      'Set rateLimits.minCheckInterval to at least 1',
    )
  }

  if (!isInteger(rl.maxConcurrentChecks) || rl.maxConcurrentChecks < 1 || rl.maxConcurrentChecks > 50) {
    push(
      errors,
      'rateLimits.maxConcurrentChecks',
      rl.maxConcurrentChecks,
      'integer between 1 and 50',
      'Set rateLimits.maxConcurrentChecks within the allowed range',
    )
  }

  if (!isNumber(rl.perHostMinGap) || rl.perHostMinGap < 1 || rl.perHostMinGap > 10) {
    push(
      errors,
      'rateLimits.perHostMinGap',
      rl.perHostMinGap,
      'number between 1 and 10 seconds',
      'Set rateLimits.perHostMinGap within the allowed range',
    )
  }

  if (!isInteger(rl.dbReconnectAttempts) || rl.dbReconnectAttempts < 0 || rl.dbReconnectAttempts > 1000) {
    push(
      errors,
      'rateLimits.dbReconnectAttempts',
      rl.dbReconnectAttempts,
      'integer between 0 and 1000 (0 = unlimited)',
      'Set rateLimits.dbReconnectAttempts within the allowed range',
    )
  }

  if (!isInteger(rl.dbPoolSize) || rl.dbPoolSize < 1 || rl.dbPoolSize > 100) {
    push(
      errors,
      'rateLimits.dbPoolSize',
      rl.dbPoolSize,
      'integer between 1 and 100',
      'Set rateLimits.dbPoolSize within the allowed range',
    )
  }

  if (!isInteger(rl.maxEventListeners) || rl.maxEventListeners < 10 || rl.maxEventListeners > 100) {
    push(
      errors,
      'rateLimits.maxEventListeners',
      rl.maxEventListeners,
      'integer between 10 and 100',
      'Set rateLimits.maxEventListeners within the allowed range',
    )
  }

  // Cross-field: defaults.checkInterval must not go below minCheckInterval.
  if (
    isInteger(rl.minCheckInterval) &&
    isInteger(cfg.defaults.checkInterval) &&
    cfg.defaults.checkInterval < rl.minCheckInterval
  ) {
    push(
      errors,
      'defaults.checkInterval',
      cfg.defaults.checkInterval,
      `at least rateLimits.minCheckInterval (${rl.minCheckInterval}s)`,
      'Increase defaults.checkInterval or lower rateLimits.minCheckInterval',
    )
  }
}

function validateBuffer(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  if (
    !isInteger(cfg.buffer.memoryCapacity) ||
    cfg.buffer.memoryCapacity < 100 ||
    cfg.buffer.memoryCapacity > 10_000
  ) {
    push(
      errors,
      'buffer.memoryCapacity',
      cfg.buffer.memoryCapacity,
      'integer between 100 and 10000',
      'Set buffer.memoryCapacity within the allowed range',
    )
  }
}

function validateSse(cfg: WatchDeckConfig, errors: ValidationError[]): void {
  if (
    !isInteger(cfg.sse.heartbeatInterval) ||
    cfg.sse.heartbeatInterval < 15 ||
    cfg.sse.heartbeatInterval > 120
  ) {
    push(
      errors,
      'sse.heartbeatInterval',
      cfg.sse.heartbeatInterval,
      'integer between 15 and 120 seconds',
      'Set sse.heartbeatInterval within the allowed range',
    )
  }
}

function validateEventHistory(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  if (
    !isInteger(cfg.eventHistorySize) ||
    cfg.eventHistorySize < 10 ||
    cfg.eventHistorySize > 1000
  ) {
    push(
      errors,
      'eventHistorySize',
      cfg.eventHistorySize,
      'integer between 10 and 1000',
      'Set eventHistorySize within the allowed range',
    )
  }
}

function validateAggregation(
  cfg: WatchDeckConfig,
  errors: ValidationError[],
): void {
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
  if (
    typeof cfg.aggregation.time !== 'string' ||
    !TIME_RE.test(cfg.aggregation.time)
  ) {
    push(
      errors,
      'aggregation.time',
      cfg.aggregation.time,
      '24-hour time string "HH:MM" in UTC, e.g. "03:00"',
      'Set aggregation.time to a valid UTC time string',
    )
  }
}

function validateCors(cfg: WatchDeckConfig, errors: ValidationError[]): void {
  if (typeof cfg.cors.origin !== 'string' || cfg.cors.origin.trim() === '') {
    push(
      errors,
      'cors.origin',
      cfg.cors.origin,
      'non-empty string (use "*" to allow all origins)',
      'Set cors.origin to "*" or a specific domain',
    )
  }

  if (typeof cfg.cors.credentials !== 'boolean') {
    push(
      errors,
      'cors.credentials',
      cfg.cors.credentials,
      'boolean',
      'Set cors.credentials to true or false',
    )
  }
}

function validateAuth(cfg: WatchDeckConfig, errors: ValidationError[]): void {
  if (
    cfg.authMiddleware !== null &&
    typeof cfg.authMiddleware !== 'function'
  ) {
    push(
      errors,
      'authMiddleware',
      typeof cfg.authMiddleware,
      'async function (request, reply) => Promise<void>, or null',
      'Set authMiddleware to an async function or null to disable auth',
    )
  }
}

// ---------------------------------------------------------------------------
// Cross-validation: module tokens
// ---------------------------------------------------------------------------

function crossValidateModuleTokens(
  cfg: WatchDeckConfig,
  env: LoadedEnv,
  warnings: string[],
): void {
  if (cfg.modules.discord && !env.MX_DISCORD_TOKEN) {
    warnings.push(
      formatWarning(
        'modules.discord',
        'MX_DISCORD_TOKEN is not set. Discord notifications will not work. ' +
          'Add MX_DISCORD_TOKEN to your .env, or set modules.discord to false.',
      ),
    )
  }

  if (cfg.modules.slack && !env.MX_SLACK_TOKEN) {
    warnings.push(
      formatWarning(
        'modules.slack',
        'MX_SLACK_TOKEN is not set. Slack notifications will not work. ' +
          'Add MX_SLACK_TOKEN to your .env, or set modules.slack to false.',
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Public: validate + freeze
// ---------------------------------------------------------------------------

export interface ValidateResult {
  config: WatchDeckConfig
  /** Non-fatal formatted warning strings to display at startup. */
  warnings: string[]
}

/**
 * Validate all config fields against their allowed ranges/types.
 * Cross-validates module token requirements against loaded env vars.
 *
 * Returns warnings (non-fatal) for the caller to display — does NOT print them.
 * Throws a formatted error string if any hard validation failures are found.
 *
 * On success, deep-freezes the config object in place and returns it.
 */
export function validateAndFreeze(
  cfg: WatchDeckConfig,
  env: LoadedEnv,
): ValidateResult {
  const errors: ValidationError[] = []
  const warnings: string[] = []

  validateServer(cfg, errors)
  validateDefaults(cfg, errors)
  validateRetention(cfg, errors)
  validateRateLimits(cfg, errors)
  validateBuffer(cfg, errors)
  validateSse(cfg, errors)
  validateEventHistory(cfg, errors)
  validateAggregation(cfg, errors)
  validateCors(cfg, errors)
  validateAuth(cfg, errors)
  crossValidateModuleTokens(cfg, env, warnings)

  if (errors.length > 0) {
    throw new Error(formatValidationReport(errors))
  }

  return { config: deepFreeze(cfg), warnings }
}
