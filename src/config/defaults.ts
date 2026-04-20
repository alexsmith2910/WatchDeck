/**
 * WatchDeck default configuration values.
 * All fields are documented with their type, valid range/options, and purpose.
 * These values are deep-merged with the user's watchdeck.config.js at startup.
 */

export const defaults = {
  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

  /** TCP port the Fastify server listens on. Range: 1–65535. */
  port: 4000,

  /** Base path for all API routes. Must start with "/". */
  apiBasePath: "/api/mx",

  /** URL path where the dashboard is served in standalone mode. */
  dashboardRoute: "/dashboard",

  /**
   * How the dashboard is served.
   * - "standalone": Fastify serves static files at dashboardRoute.
   * - "mounted": API-only; user imports <WatchDeckDashboard /> into their own app.
   */
  dashboardMode: "standalone" as "standalone" | "mounted",

  // ---------------------------------------------------------------------------
  // Modules — set false to disable and skip loading the module entirely.
  // Disabled modules are never imported into memory (dynamic import pattern).
  // ---------------------------------------------------------------------------
  modules: {
    /**
     * Enable Discord notification channel.
     * Requires MX_DISCORD_TOKEN in environment.
     */
    discord: true,

    /**
     * Enable Slack notification channel.
     * Requires MX_SLACK_TOKEN in environment.
     */
    slack: true,

    /**
     * Enable TLS/SSL certificate expiry checks on HTTP endpoints.
     * Adds sslDaysRemaining to check results and fires alerts at sslWarningDays threshold.
     */
    sslChecks: true,

    /**
     * Enable TCP port checks (type: "port" endpoints).
     * Disabling removes port check scheduling and API support.
     */
    portChecks: true,

    /**
     * Enable response body validation rules on HTTP endpoints.
     * Adds bodyValidation result to every check.
     */
    bodyValidation: true,
  },

  // ---------------------------------------------------------------------------
  // Check Defaults — applied to each endpoint that does not override the field.
  // ---------------------------------------------------------------------------
  defaults: {
    /**
     * How often to run each check, in seconds.
     * Allowed values: 30, 60, 120, 300, 600.
     * Cannot go below rateLimits.minCheckInterval.
     */
    checkInterval: 60,

    /**
     * Maximum milliseconds to wait for a response before marking the check as timed-out.
     * Range: 1000–60000 ms.
     */
    timeout: 10_000,

    /**
     * HTTP status codes that are treated as healthy.
     * Any response code not in this list is counted as a failure.
     */
    expectedStatusCodes: [200] as number[],

    /**
     * Response time in milliseconds above which a check is considered "degraded".
     * Range: 100–30000 ms.
     */
    latencyThreshold: 5_000,

    /**
     * Number of days before SSL certificate expiry to start warning.
     * Allowed values: 7, 14, 30.
     */
    sslWarningDays: 14,

    /**
     * Number of consecutive failures required before an incident is opened.
     * Range: 1–10.
     */
    failureThreshold: 3,

    /**
     * Minimum seconds between repeated alert notifications for the same incident.
     * Prevents notification spam during extended outages.
     * Range: 300–7200 seconds.
     */
    alertCooldown: 900,

    /**
     * Whether to send a notification when an endpoint recovers from an incident.
     */
    recoveryAlert: true,

    /**
     * Seconds after incident open before escalating to the escalation channel.
     * Set to 0 to disable escalation entirely.
     * Range: 0–86400 seconds.
     */
    escalationDelay: 1_800,

    // -------------------------------------------------------------------------
    // Notifications — global dispatcher policy.
    //
    // These act as the floor for every channel; per-channel and per-endpoint
    // settings narrow them but cannot relax them. Coalescing is the burst
    // strategy (not digest) — see notifications-plan.md §1.5.
    // -------------------------------------------------------------------------
    notifications: {
      /** Master switch — false disables the dispatcher entirely. */
      enabled: true,

      /**
       * Severity floor for dispatch. Alerts below this threshold are
       * suppressed with reason 'severity_filter'.
       * Allowed: 'info+' | 'warning+' | 'critical'.
       */
      severityFloor: 'warning+' as 'info+' | 'warning+' | 'critical',

      /** Whether incident-opened dispatches fire by default. */
      sendOpen: true,
      /** Whether incident-resolved dispatches fire by default. */
      sendResolved: true,
      /** Whether the escalation dispatch fires by default. */
      sendEscalation: true,
      /** If false, dispatches are suppressed during an endpoint's maintenance window. */
      alertDuringMaintenance: false,

      /**
       * Retry failed provider calls per the backoff schedule below.
       * Per-channel `retryOnFailure` flag narrows this on a case-by-case basis.
       */
      retryOnFailure: true,

      /**
       * Backoff schedule in milliseconds. Length = maximum retry attempts.
       * Provider `429 Retry-After` headers take precedence over this schedule.
       */
      retryBackoffMs: [2000, 8000, 30000] as number[],

      /**
       * Burst coalescing — not digest. Immediate delivery by default; only
       * additional alerts arriving within `windowSeconds` after the first are
       * held and flushed as one consolidated follow-up. Critical severity
       * bypasses the buffer.
       */
      coalescing: {
        /** Master toggle for burst coalescing. */
        enabled: true,
        /** Rolling window after the first alert in which follow-ups are buffered. */
        windowSeconds: 60,
        /** Minimum number of alerts required to emit a coalesced summary. */
        minBurstCount: 3,
        /** Severity that bypasses the coalescing buffer (always immediate). */
        bypassSeverity: 'critical' as 'info' | 'warning' | 'critical',
      },

      /**
       * Global quiet hours. Set to null to disable; channels can still set
       * their own quiet hours on top.
       */
      quietHours: null as { start: string; end: string; tz: string } | null,

      /**
       * Per-channel-type rate limit defaults (can be overridden per-channel).
       * Protects provider APIs — Discord webhooks rate-limit at 5/2s by default.
       */
      channelDefaults: {
        discord: { rateLimitPerMinute: 30 },
        slack: { rateLimitPerMinute: 30 },
        email: { rateLimitPerMinute: 10 },
        webhook: { rateLimitPerMinute: 60 },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Retention — how long raw and aggregated data is kept.
  // ---------------------------------------------------------------------------
  retention: {
    /**
     * Days to retain raw check results in mx_checks before TTL deletion.
     * Allowed values: 7, 14, 30.
     */
    detailedDays: 30,

    /**
     * Days to retain hourly summary documents in mx_hourly_summaries.
     * Allowed values: 30, 60, 90.
     */
    hourlyDays: 90,

    /**
     * Retention policy for daily summaries in mx_daily_summaries.
     * Allowed values: "6months", "1year", "indefinite".
     */
    daily: "1year" as "6months" | "1year" | "indefinite",

    /**
     * Days to retain notification delivery records in mx_notification_log.
     * Allowed values: 30, 60, 90.
     */
    notificationLogDays: 60,
  },

  // ---------------------------------------------------------------------------
  // Rate Limits — protect the check engine and database from overload.
  // ---------------------------------------------------------------------------
  rateLimits: {
    /**
     * Absolute floor for check intervals across all endpoints, in seconds.
     * No endpoint can be checked more frequently than this value.
     */
    minCheckInterval: 30,

    /**
     * Maximum number of checks that may run simultaneously.
     * Range: 1–50.
     */
    maxConcurrentChecks: 10,

    /**
     * Minimum gap in seconds between consecutive checks to the same host.
     * Prevents hammering a single server when multiple endpoints share a hostname.
     * Range: 1–10 seconds.
     */
    perHostMinGap: 2,

    /**
     * Maximum number of reconnection attempts after a DB disconnect.
     * Uses exponential backoff capped at 5 minutes.
     * Set to 0 for unlimited retries.
     * Range: 0–1000.
     */
    dbReconnectAttempts: 30,

    /**
     * MongoDB connection pool size.
     * Range: 1–100. Recommended: 10.
     */
    dbPoolSize: 10,

    /**
     * Maximum number of event listeners on the event bus.
     * Raise this if you add many custom subscribers.
     * Range: 10–100. Recommended: 25.
     */
    maxEventListeners: 25,
  },

  // ---------------------------------------------------------------------------
  // Buffer — in-memory check result buffer used during DB outages.
  // ---------------------------------------------------------------------------
  buffer: {
    /**
     * Maximum number of check results held in the in-memory buffer.
     * When full, overflow spills to the disk buffer (~/.watchdeck/buffer.jsonl).
     * Range: 100–10000.
     */
    memoryCapacity: 1_000,
  },

  // ---------------------------------------------------------------------------
  // SSE — Server-Sent Events stream configuration.
  // ---------------------------------------------------------------------------
  sse: {
    /**
     * Seconds between SSE heartbeat comments sent to keep the connection alive.
     * The dashboard reconnects if it misses 2× this interval.
     * Range: 15–120 seconds.
     */
    heartbeatInterval: 30,
  },

  // ---------------------------------------------------------------------------
  // Event History — circular buffer of recent events replayed to new SSE clients.
  // ---------------------------------------------------------------------------

  /**
   * Number of recent events held in the circular history buffer.
   * Sent to newly connected SSE clients so they receive recent state immediately.
   * Range: 10–1000.
   */
  eventHistorySize: 100,

  // ---------------------------------------------------------------------------
  // Aggregation — scheduled roll-up of raw checks into hourly/daily summaries.
  // ---------------------------------------------------------------------------
  aggregation: {
    /**
     * UTC time (24-hour "HH:MM" format) at which the daily aggregation job runs.
     * Runs once per day to roll hourly summaries into daily summaries and
     * apply retention TTL cleanup.
     */
    time: "03:00",
  },

  // ---------------------------------------------------------------------------
  // CORS — Cross-Origin Resource Sharing headers on the Fastify server.
  // ---------------------------------------------------------------------------
  cors: {
    /**
     * Allowed origin(s) for CORS requests.
     * Use "*" to allow all origins, or a specific domain string for production.
     */
    origin: "*" as string,

    /**
     * Whether to allow cookies and Authorization headers in cross-origin requests.
     */
    credentials: true,
  },

  // ---------------------------------------------------------------------------
  // Auth — optional authentication middleware for all non-public routes.
  // ---------------------------------------------------------------------------

  /**
   * Custom authentication middleware function, or null to disable auth entirely.
   * When provided, the function receives (request, reply) and must throw or call
   * reply.code(401).send() to reject the request. All routes except
   * GET /health and GET /health/ping are wrapped by this middleware.
   *
   * @example
   * authMiddleware: async (request, reply) => {
   *   if (request.headers.authorization !== `Bearer ${process.env.MY_TOKEN}`) {
   *     await reply.code(401).send({ error: true, code: 'UNAUTHORIZED' });
   *   }
   * }
   */
  authMiddleware: null as
    | ((request: unknown, reply: unknown) => Promise<void>)
    | null,
} as const;

export type Defaults = typeof defaults;
