/**
 * Core WatchDeck configuration type.
 * This interface represents the fully-merged, validated config after
 * defaults are applied and Object.freeze() is called.
 *
 * Fields are documented in src/config/defaults.ts.
 */
export interface WatchDeckConfig {
  port: number;
  apiBasePath: string;
  dashboardRoute: string;
  dashboardMode: 'standalone' | 'mounted';

  probeName: string;

  captureBodySize: boolean;
  maxBodyBytesToRead: number;

  modules: {
    discord: boolean;
    slack: boolean;
    sslChecks: boolean;
    portChecks: boolean;
    bodyValidation: boolean;
  };

  defaults: {
    checkInterval: number;
    timeout: number;
    expectedStatusCodes: number[];
    latencyThreshold: number;
    sslWarningDays: number;
    failureThreshold: number;
    alertCooldown: number;
    recoveryAlert: boolean;
    escalationDelay: number;
    notifications: {
      enabled: boolean;
      severityFloor: 'info+' | 'warning+' | 'critical';
      sendOpen: boolean;
      sendResolved: boolean;
      sendEscalation: boolean;
      alertDuringMaintenance: boolean;
      retryOnFailure: boolean;
      retryBackoffMs: number[];
      coalescing: {
        enabled: boolean;
        windowSeconds: number;
        minBurstCount: number;
        bypassSeverity: 'info' | 'warning' | 'critical';
      };
      quietHours: { start: string; end: string; tz: string } | null;
      channelDefaults: {
        discord: { rateLimitPerMinute: number };
        slack: { rateLimitPerMinute: number };
        email: { rateLimitPerMinute: number };
        webhook: { rateLimitPerMinute: number };
      };
    };
  };

  retention: {
    detailedDays: number;
    hourlyDays: number;
    daily: '6months' | '1year' | 'indefinite';
    notificationLogDays: number;
  };

  rateLimits: {
    minCheckInterval: number;
    maxConcurrentChecks: number;
    perHostMinGap: number;
    dbReconnectAttempts: number;
    dbPoolSize: number;
    maxEventListeners: number;
  };

  buffer: {
    memoryCapacity: number;
  };

  sse: {
    heartbeatInterval: number;
  };

  eventHistorySize: number;

  aggregation: {
    time: string;
  };

  cors: {
    origin: string;
    credentials: boolean;
  };

  /**
   * Optional auth middleware. null = no auth on any route.
   * Typed loosely here; the API server casts to FastifyRequest/FastifyReply.
   */
  authMiddleware: ((request: unknown, reply: unknown) => Promise<void>) | null;
}

/**
 * Recursive deep-partial — the shape of watchdeck.config.js.
 * Users only need to supply the fields they want to override.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type UserConfig = DeepPartial<WatchDeckConfig>;
