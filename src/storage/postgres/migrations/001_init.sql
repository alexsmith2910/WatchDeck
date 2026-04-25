CREATE TABLE mx_endpoints (
  id                              UUID PRIMARY KEY,
  name                            TEXT NOT NULL,
  description                     TEXT,
  type                            TEXT NOT NULL CHECK (type IN ('http', 'port')),

  url                             TEXT,
  method                          TEXT,
  headers                         JSONB,
  expected_status_codes           INTEGER[],
  assertions                      JSONB,

  host                            TEXT,
  port                            INTEGER,

  check_interval                  INTEGER NOT NULL,
  timeout                         INTEGER NOT NULL,
  enabled                         BOOLEAN NOT NULL,
  status                          TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  latency_threshold               INTEGER NOT NULL,
  ssl_warning_days                INTEGER NOT NULL,
  failure_threshold               INTEGER NOT NULL,
  recovery_threshold              INTEGER NOT NULL,
  alert_cooldown                  INTEGER NOT NULL,
  recovery_alert                  BOOLEAN NOT NULL,
  escalation_delay                INTEGER NOT NULL,
  escalation_channel_id           UUID,
  notification_channel_ids        UUID[] NOT NULL DEFAULT '{}',
  paused_notification_channel_ids UUID[] NOT NULL DEFAULT '{}',

  last_check_at                   TIMESTAMPTZ,
  last_status                     TEXT,
  last_response_time              INTEGER,
  last_status_code                INTEGER,
  last_error_message              TEXT,
  last_ssl_issuer                 JSONB,
  current_incident_id             UUID,
  consecutive_failures            INTEGER NOT NULL DEFAULT 0,
  consecutive_healthy             INTEGER NOT NULL DEFAULT 0,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mx_endpoints_enabled_last_check ON mx_endpoints (enabled, last_check_at);
CREATE INDEX mx_endpoints_type ON mx_endpoints (type);
CREATE INDEX mx_endpoints_status ON mx_endpoints (status);

CREATE TABLE mx_checks (
  id                   UUID PRIMARY KEY,
  endpoint_id          UUID NOT NULL REFERENCES mx_endpoints(id) ON DELETE CASCADE,
  timestamp            TIMESTAMPTZ NOT NULL,
  response_time        INTEGER NOT NULL,
  status_code          INTEGER,
  ssl_days_remaining   INTEGER,
  body_bytes           INTEGER,
  body_bytes_truncated BOOLEAN,
  assertion_result     JSONB,
  port_open            BOOLEAN,
  status               TEXT NOT NULL,
  status_reason        TEXT,
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mx_checks_endpoint_timestamp ON mx_checks (endpoint_id, timestamp DESC);
CREATE INDEX mx_checks_status_timestamp ON mx_checks (status, timestamp DESC);
CREATE INDEX mx_checks_timestamp ON mx_checks (timestamp);

CREATE TABLE mx_hourly_summaries (
  id                   UUID PRIMARY KEY,
  endpoint_id          UUID NOT NULL REFERENCES mx_endpoints(id) ON DELETE CASCADE,
  hour                 TIMESTAMPTZ NOT NULL,
  total_checks         INTEGER NOT NULL,
  success_count        INTEGER NOT NULL,
  fail_count           INTEGER NOT NULL,
  degraded_count       INTEGER NOT NULL,
  uptime_percent       NUMERIC NOT NULL,
  avg_response_time    NUMERIC NOT NULL,
  min_response_time    INTEGER NOT NULL,
  max_response_time    INTEGER NOT NULL,
  p95_response_time    INTEGER NOT NULL,
  p99_response_time    INTEGER NOT NULL,
  error_types          JSONB NOT NULL DEFAULT '{}',
  had_active_incident  BOOLEAN NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, hour)
);
CREATE INDEX mx_hourly_summaries_endpoint_hour ON mx_hourly_summaries (endpoint_id, hour DESC);
CREATE INDEX mx_hourly_summaries_hour ON mx_hourly_summaries (hour);

CREATE TABLE mx_daily_summaries (
  id                     UUID PRIMARY KEY,
  endpoint_id            UUID NOT NULL REFERENCES mx_endpoints(id) ON DELETE CASCADE,
  date                   TIMESTAMPTZ NOT NULL,
  total_checks           INTEGER NOT NULL,
  uptime_percent         NUMERIC NOT NULL,
  avg_response_time      NUMERIC NOT NULL,
  min_response_time      INTEGER NOT NULL,
  max_response_time      INTEGER NOT NULL,
  p95_response_time      INTEGER NOT NULL,
  p99_response_time      INTEGER NOT NULL,
  incident_count         INTEGER NOT NULL,
  total_downtime_minutes NUMERIC NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, date)
);
CREATE INDEX mx_daily_summaries_endpoint_date ON mx_daily_summaries (endpoint_id, date DESC);
CREATE INDEX mx_daily_summaries_date ON mx_daily_summaries (date);

CREATE TABLE mx_incidents (
  id                 UUID PRIMARY KEY,
  endpoint_id        UUID NOT NULL REFERENCES mx_endpoints(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('active','resolved')),
  cause              TEXT NOT NULL,
  cause_detail       TEXT,
  started_at         TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,
  duration_seconds   INTEGER,
  timeline           JSONB NOT NULL DEFAULT '[]',
  notifications_sent INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mx_incidents_endpoint_status ON mx_incidents (endpoint_id, status);
CREATE INDEX mx_incidents_status_started ON mx_incidents (status, started_at DESC);
CREATE INDEX mx_incidents_started ON mx_incidents (started_at DESC);

ALTER TABLE mx_endpoints
  ADD CONSTRAINT mx_endpoints_current_incident_fk
  FOREIGN KEY (current_incident_id) REFERENCES mx_incidents(id) ON DELETE SET NULL;

CREATE TABLE mx_notification_channels (
  id                    UUID PRIMARY KEY,
  type                  TEXT NOT NULL CHECK (type IN ('discord','slack','email','webhook')),
  name                  TEXT NOT NULL,
  delivery_priority     TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  severity_filter       TEXT NOT NULL,
  event_filters         JSONB NOT NULL,
  quiet_hours           JSONB,
  rate_limit            JSONB,
  retry_on_failure      BOOLEAN NOT NULL DEFAULT true,
  metadata              JSONB,
  provider_config       JSONB NOT NULL,
  is_connected          BOOLEAN NOT NULL DEFAULT true,
  last_tested_at        TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_failure_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mx_notification_channels_type ON mx_notification_channels (type);
CREATE INDEX mx_notification_channels_enabled_type ON mx_notification_channels (enabled, type);

ALTER TABLE mx_endpoints
  ADD CONSTRAINT mx_endpoints_escalation_channel_fk
  FOREIGN KEY (escalation_channel_id) REFERENCES mx_notification_channels(id) ON DELETE SET NULL;

CREATE TABLE mx_notification_log (
  id                     UUID PRIMARY KEY,
  endpoint_id            UUID REFERENCES mx_endpoints(id) ON DELETE SET NULL,
  incident_id            UUID REFERENCES mx_incidents(id) ON DELETE SET NULL,
  channel_id             UUID REFERENCES mx_notification_channels(id) ON DELETE SET NULL,
  type                   TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  channel_type           TEXT NOT NULL,
  channel_target         TEXT NOT NULL,
  message_summary        TEXT NOT NULL,
  severity               TEXT NOT NULL,
  delivery_status        TEXT NOT NULL,
  failure_reason         TEXT,
  suppressed_reason      TEXT,
  latency_ms             INTEGER,
  idempotency_key        TEXT,
  retry_of               UUID REFERENCES mx_notification_log(id) ON DELETE SET NULL,
  coalesced_into_log_id  UUID REFERENCES mx_notification_log(id) ON DELETE SET NULL,
  coalesced_count        INTEGER,
  coalesced_incident_ids UUID[],
  payload                JSONB,
  request                JSONB,
  response               JSONB,
  sent_at                TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mx_notification_log_endpoint_sent ON mx_notification_log (endpoint_id, sent_at DESC);
CREATE INDEX mx_notification_log_channel_sent ON mx_notification_log (channel_id, sent_at DESC);
CREATE INDEX mx_notification_log_incident    ON mx_notification_log (incident_id);
CREATE INDEX mx_notification_log_status_sent ON mx_notification_log (delivery_status, sent_at DESC);
CREATE INDEX mx_notification_log_sent_at     ON mx_notification_log (sent_at);

CREATE TABLE mx_notification_mutes (
  id          UUID PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('endpoint','channel','global')),
  target_id   UUID,
  muted_by    TEXT NOT NULL,
  muted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  reason      TEXT
);
CREATE INDEX mx_notification_mutes_scope_target ON mx_notification_mutes (scope, target_id);
CREATE INDEX mx_notification_mutes_expires ON mx_notification_mutes (expires_at);

CREATE TABLE mx_notification_preferences (
  id                       TEXT PRIMARY KEY DEFAULT 'global',
  global_mute_until        TIMESTAMPTZ,
  default_severity_filter  TEXT NOT NULL,
  default_event_filters    JSONB NOT NULL,
  last_edited_by           TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 'global')
);

CREATE TABLE mx_settings (
  id         TEXT PRIMARY KEY DEFAULT 'global',
  defaults   JSONB,
  slo        JSONB,
  extra      JSONB NOT NULL DEFAULT '{}',
  CHECK (id = 'global')
);

CREATE TABLE mx_system_events (
  id                  UUID PRIMARY KEY,
  type                TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  resolved_at         TIMESTAMPTZ,
  duration_seconds    INTEGER,
  reconnect_attempts  INTEGER NOT NULL DEFAULT 0,
  severity            TEXT NOT NULL,
  cause               TEXT NOT NULL,
  cause_detail        TEXT,
  buffered_to_memory  INTEGER NOT NULL DEFAULT 0,
  buffered_to_disk    INTEGER NOT NULL DEFAULT 0,
  replay_status       TEXT NOT NULL,
  replayed_count      INTEGER NOT NULL DEFAULT 0,
  replay_errors       INTEGER NOT NULL DEFAULT 0,
  timeline            JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX mx_system_events_type_started ON mx_system_events (type, started_at DESC);

CREATE TABLE mx_health_state (
  id             TEXT PRIMARY KEY DEFAULT 'snapshot',
  saved_at       TIMESTAMPTZ NOT NULL,
  probe_history  JSONB NOT NULL,
  heatmap        JSONB NOT NULL,
  CHECK (id = 'snapshot')
);

CREATE TABLE mx_internal_incidents (
  id                TEXT PRIMARY KEY,
  subsystem         TEXT NOT NULL,
  severity          TEXT NOT NULL,
  status            TEXT NOT NULL,
  title             TEXT NOT NULL,
  cause             TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ,
  duration_seconds  INTEGER,
  commits           INTEGER NOT NULL DEFAULT 0,
  timeline          JSONB NOT NULL DEFAULT '[]',
  expires_at        TIMESTAMPTZ
);
CREATE INDEX mx_internal_incidents_status_started ON mx_internal_incidents (status, started_at DESC);
CREATE INDEX mx_internal_incidents_expires ON mx_internal_incidents (expires_at);
