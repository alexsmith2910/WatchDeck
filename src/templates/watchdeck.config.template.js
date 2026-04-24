export default {
  port: {{PORT}},
  apiBasePath: '/api/mx',
  dashboardRoute: '/dashboard',
  dashboardMode: '{{DASHBOARD_MODE}}',

  modules: {
    discord: {{DISCORD}},
    slack: {{SLACK}},
    sslChecks: true,
    portChecks: true,
    bodyValidation: true,
  },

  defaults: {
    checkInterval: 60,
    timeout: 10000,
    expectedStatusCodes: [200],
    latencyThreshold: 5000,
    sslWarningDays: 14,
    failureThreshold: 3,
    recoveryThreshold: 2,
    alertCooldown: 900,
    recoveryAlert: true,
    escalationDelay: 1800,

    notifications: {
      enabled: true,
      severityFloor: 'warning+',
      sendOpen: true,
      sendResolved: true,
      sendEscalation: true,
      alertDuringMaintenance: false,
      retryOnFailure: true,
      retryBackoffMs: [2000, 8000, 30000],
      coalescing: {
        enabled: true,
        windowSeconds: 60,
        minBurstCount: 3,
        bypassSeverity: 'critical',
      },
      quietHours: null,
      channelDefaults: {
        discord: { rateLimitPerMinute: 30 },
        slack: { rateLimitPerMinute: 30 },
        email: { rateLimitPerMinute: 10 },
        webhook: { rateLimitPerMinute: 60 },
      },
    },
  },

  slo: {
    target: 99.9,
    windowDays: 30,
  },

  retention: {
    detailedDays: 30,
    hourlyDays: 90,
    daily: '1year',
    notificationLogDays: 60,
  },

  rateLimits: {
    minCheckInterval: 30,
    maxConcurrentChecks: 10,
    perHostMinGap: 2,
    dbReconnectAttempts: 30,
    dbPoolSize: 10,
    maxEventListeners: 25,
  },

  buffer: {
    memoryCapacity: 1000,
  },

  sse: {
    heartbeatInterval: 30,
  },

  eventHistorySize: 100,

  aggregation: {
    time: '03:00',
  },

  cors: {
    origin: '*',
    credentials: true,
  },

  authMiddleware: null,
}
