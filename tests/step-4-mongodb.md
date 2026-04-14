# Step 4 — MongoDB Connection and Migrations Tests

## Connection — Valid

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Connects to Atlas successfully | `watchdeck start --verbose` (valid MX_DB_URI) | `✓ db connected (Xms)` printed | ✅ |
| Migrations run on first connect | `watchdeck start --verbose` | `Migrations complete` printed after connect | ✅ |
| Startup warnings still shown before connection | `watchdeck start` (no tokens set) | Warnings block appears before db output | ✅ |

## Connection — Failure

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Wrong host/port — clear error message | `MX_DB_URI=mongodb://localhost:27099/…` | `✗ WatchDeck failed to connect to MongoDB` + ECONNREFUSED detail | ✅ |
| Malformed URI — immediate failure | `MX_DB_URI=not-a-valid-uri` | Error: invalid scheme, no retries | ✅ |
| Failed connect exits with code 1 | Any failing URI | `echo $?` → `1` | ✅ |

## Boot Retry Sequence

| Test | Scenario | Expected | Result |
|------|----------|----------|--------|
| 3 attempts with 5-second gaps | Unreachable host | ~25s elapsed before giving up (3 × connect timeout + 2 × 5s gap) | ✅ |
| Final error shown once after all attempts | Unreachable host | Single styled error block, not 3 separate errors | ✅ |

## Migrations — Idempotency

| Test | Scenario | Expected | Result |
|------|----------|----------|--------|
| Second run — no errors | `watchdeck start` twice in same dir | Clean connect + `Migrations complete` both times | ✅ |
| No duplicate collections | Second run (verified in Compass) | Still 9 collections, no duplicates | ✅ |
| No duplicate indexes | Second run (verified in Compass) | Existing indexes skipped, none duplicated | ✅ |

## Collections and Indexes (verified in MongoDB Compass)

| Collection | Exists | Indexes |
|------------|--------|---------|
| mx_endpoints | ✅ | `enabled_lastCheckAt`, `type` |
| mx_checks | ✅ | `endpointId_timestamp`, `timestamp_ttl` (TTL), `status_timestamp` |
| mx_hourly_summaries | ✅ | `endpointId_hour`, `hour` |
| mx_daily_summaries | ✅ | `endpointId_date`, `date` |
| mx_incidents | ✅ | `endpointId_status`, `status_startedAt`, `startedAt` |
| mx_notification_channels | ✅ | `type` |
| mx_notification_log | ✅ | `endpointId_sentAt`, `incidentId`, `sentAt` |
| mx_settings | ✅ | none (single-document collection) |
| mx_system_events | ✅ | `type_startedAt` |

## Event Bus — DB Events

| Test | Scenario | Expected | Result |
|------|----------|----------|--------|
| `db:connected` fires on successful connect | Valid URI | `✓ db connected (Xms)` log in start.ts subscriber | ✅ |
| `db:error` fires on each failed boot attempt | Unreachable host | Event emitted × 3 internally (no visual output by design — only fatal shown) | ✅ |

## Not Tested (requires runtime DB disconnect)

| Test | Reason |
|------|--------|
| `db:reconnecting` event output | Requires killing DB mid-run — manual test in step 15 |
| `db:reconnected` event output | Requires killing and restoring DB — manual test in step 15 |
| `db:fatal` after max reconnect attempts | Requires sustained outage beyond 30 attempts — manual test in step 15 |
| Exponential backoff timing (30s → 5min) | Requires sustained outage — manual test in step 15 |
