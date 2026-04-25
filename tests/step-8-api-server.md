# Step 8 — API Server Tests

## Automated (npx tsx tests/step-8-api-server.test.ts)

### Pagination utilities

| Test | Expected | Result |
|------|----------|--------|
| default limit is 20 | 20 | ✅ |
| cursor undefined when not provided | undefined | ✅ |
| limit parsed from string "50" | 50 | ✅ |
| cursor passed through | "abc123" | ✅ |
| limit capped at 100 (got 999) | 100 | ✅ |
| invalid limit string falls back to 20 | 20 | ✅ |
| toEnvelope: data array has correct length | correct | ✅ |
| toEnvelope: total forwarded | matches | ✅ |
| toEnvelope: hasMore forwarded | matches | ✅ |
| toEnvelope: nextCursor forwarded | matches | ✅ |
| toEnvelope: limit recorded | matches | ✅ |
| toEnvelope: nextCursor null when no more pages | null | ✅ |
| toEnvelope: hasMore false on last page | false | ✅ |

### API routes — setup

| Test | Expected | Result |
|------|----------|--------|
| Adapter connected + migrated | no error | ✅ |

### API routes — health

| Test | Expected | Result |
|------|----------|--------|
| GET /health/ping → 200 | 200 | ✅ |
| GET /health/ping body.status = "ok" | "ok" | ✅ |
| GET /health → 200 | 200 | ✅ |
| GET /health has status field | present | ✅ |
| GET /health has db field | present | ✅ |
| GET /health has scheduler field | present | ✅ |
| GET /health has numeric uptime | number | ✅ |

### API routes — error format

| Test | Expected | Result |
|------|----------|--------|
| unknown route → 404 | 404 | ✅ |
| 404 body.error = true | true | ✅ |
| 404 body.code is a string | string | ✅ |
| POST /endpoints with empty body → 422 | 422 | ✅ |
| validation error code is VALIDATION_ERROR | "VALIDATION_ERROR" | ✅ |
| validation error includes errors array | array | ✅ |

### API routes — endpoints CRUD

| Test | Expected | Result |
|------|----------|--------|
| POST /endpoints (HTTP) → 201 | 201 | ✅ |
| created endpoint has correct name | "Test HTTP Endpoint" | ✅ |
| default checkInterval applied | number | ✅ |
| POST /endpoints (port) → 201 | 201 | ✅ |
| port endpoint has type = "port" | "port" | ✅ |
| POST /endpoints missing url → 422 | 422 | ✅ |
| error points at body.url | "body.url" | ✅ |
| POST /endpoints invalid URL → 422 | 422 | ✅ |
| GET /endpoints → 200 | 200 | ✅ |
| GET /endpoints returns data array | array | ✅ |
| GET /endpoints has pagination.total | number | ✅ |
| GET /endpoints/archived → 200 | 200 | ✅ |
| GET /endpoints/archived returns data array | array | ✅ |
| GET /endpoints/:id → 200 | 200 | ✅ |
| GET /endpoints/:id returns correct endpoint | matching _id | ✅ |
| GET /endpoints/:id includes latestCheck field | present | ✅ |
| GET /endpoints/:id with invalid ObjectId → 400 | 400 | ✅ |
| error code is INVALID_ID | "INVALID_ID" | ✅ |
| GET /endpoints/:id non-existent → 404 | 404 | ✅ |
| PUT /endpoints/:id → 200 | 200 | ✅ |
| PUT /endpoints/:id updates name | new name | ✅ |
| PUT /endpoints/:id updates checkInterval | 120 | ✅ |
| PATCH /endpoints/:id/toggle → 200 | 200 | ✅ |
| toggle: active → paused | "paused" | ✅ |
| PATCH toggle a second time → 200 | 200 | ✅ |
| toggle: paused → active | "active" | ✅ |
| POST /endpoints/:id/recheck → 202 | 202 | ✅ |
| recheck body.status = "scheduled" | "scheduled" | ✅ |

### API routes — checks

| Test | Expected | Result |
|------|----------|--------|
| GET /endpoints/:id/checks → 200 | 200 | ✅ |
| checks returns data array | array | ✅ |
| checks has pagination envelope | present | ✅ |
| GET /endpoints/:id/uptime → 200 | 200 | ✅ |
| uptime has 24h field | present | ✅ |
| uptime has 7d field | present | ✅ |
| uptime has 30d field | present | ✅ |
| uptime has 90d field | present | ✅ |
| GET /endpoints/:id/hourly → 200 | 200 | ✅ |
| hourly returns data array | array | ✅ |
| GET /endpoints/:id/daily → 200 | 200 | ✅ |
| daily returns data array | array | ✅ |

### API routes — incidents

| Test | Expected | Result |
|------|----------|--------|
| GET /incidents → 200 | 200 | ✅ |
| incidents returns data array | array | ✅ |
| incidents has pagination envelope | present | ✅ |
| GET /incidents/active → 200 | 200 | ✅ |
| active incidents returns data array | array | ✅ |
| GET /incidents/:id non-existent → 404 | 404 | ✅ |

### API routes — notifications

| Test | Expected | Result |
|------|----------|--------|
| GET /notifications/channels → 200 | 200 | ✅ |
| channels returns data array | array | ✅ |
| POST /notifications/channels → 201 | 201 | ✅ |
| created channel has correct type | "discord" | ✅ |
| created channel has correct name | "Test Discord" | ✅ |
| PUT /notifications/channels/:id → 200 | 200 | ✅ |
| channel name updated | new name | ✅ |
| channel deliveryPriority updated | "low" | ✅ |
| GET /notifications/log → 200 | 200 | ✅ |
| notification log has pagination envelope | present | ✅ |

### API routes — settings

| Test | Expected | Result |
|------|----------|--------|
| GET /settings → 200 | 200 | ✅ |
| settings doc has _id = "global" | "global" | ✅ |
| PUT /settings → 200 | 200 | ✅ |
| PUT /settings persists theme value | "dark" | ✅ |
| PUT /settings persists arbitrary fields | matches | ✅ |
| GET /endpoints/:id/settings → 200 | 200 | ✅ |
| endpoint settings includes checkInterval | present | ✅ |
| endpoint settings includes timeout | present | ✅ |
| PUT /endpoints/:id/settings → 200 | 200 | ✅ |
| endpoint checkInterval updated to 300 | 300 | ✅ |
| endpoint latencyThreshold updated to 2000 | 2000 | ✅ |

### API routes — auth middleware

| Test | Expected | Result |
|------|----------|--------|
| auth: protected route returns 401 when middleware rejects | 401 | ✅ |
| auth: public health/ping still returns 200 | 200 | ✅ |

### API routes — delete

| Test | Expected | Result |
|------|----------|--------|
| DELETE /endpoints/:id (default archive) → 204 | 204 | ✅ |
| archived endpoint has status = "archived" | "archived" | ✅ |
| DELETE /endpoints/:id?mode=hard → 204 | 204 | ✅ |
| hard-deleted endpoint returns 404 on subsequent GET | 404 | ✅ |

### Cleanup

| Test | Expected | Result |
|------|----------|--------|
| Server closed + adapter disconnected | no error | ✅ |

**111 / 111 passed**

## Not Tested (requires full running process or external integrations)

| Test | Reason |
|------|--------|
| Notification channel test endpoint dispatches real message | Requires live Discord/Slack token and dispatcher wiring — manual test in step 15 |
| DELETE /notifications/channels/:id | Not yet exercised in test suite — low risk, standard CRUD path |
| SSE endpoint streams events | SSE broker not yet implemented (step 9) |
| Dashboard static file serving | Dashboard build not yet present (step 10+) |
| Cursor pagination: second page returns correct items | Would require seeding many documents — covered by step 15 integration test |
