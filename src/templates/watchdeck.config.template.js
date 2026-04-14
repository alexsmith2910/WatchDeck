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
    alertCooldown: 900,
    recoveryAlert: true,
    escalationDelay: 1800,
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
