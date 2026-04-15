# Step 9 — SSE Broker Tests

## Automated (npx tsx tests/step-9-sse.test.ts)

### Setup

| Test | Expected | Result |
|------|----------|--------|
| Adapter connected + migrated | no error | ✅ |
| Server listening | random port | ✅ |

### SSE — connection and history replay

| Test | Expected | Result |
|------|----------|--------|
| GET /stream → 200 | 200 | ✅ |
| Content-Type is text/event-stream | text/event-stream | ✅ |
| History events received (>= 2) | >= 2 | ✅ |
| History includes check:complete event | present | ✅ |
| History includes endpoint:created event | present | ✅ |
| Received sse:connected event | present | ✅ |
| sse:connected has historyCount field | number | ✅ |

### SSE — client tracking

| Test | Expected | Result |
|------|----------|--------|
| Client count >= 1 after first connect | >= 1 | ✅ |
| Second SSE connection → 200 | 200 | ✅ |
| Client count >= 2 after second connect | >= 2 | ✅ |
| Client count >= 1 after second disconnects | >= 1 | ✅ |

### SSE — live event broadcast

| Test | Expected | Result |
|------|----------|--------|
| Live incident:opened received over SSE | present | ✅ |
| incident._id matches emitted value | "inc-test-001" | ✅ |
| replay:progress received over SSE | present | ✅ |
| replay:progress percentComplete = 20 | 20 | ✅ |
| replay:progress status = "running" | "running" | ✅ |

### SSE — heartbeat

| Test | Expected | Result |
|------|----------|--------|
| Heartbeat comment received within interval | ": heartbeat" | ✅ |

### SSE — auth middleware

| Test | Expected | Result |
|------|----------|--------|
| SSE stream returns 401 when auth rejects | 401 | ✅ |
| Public health/ping still returns 200 | 200 | ✅ |

### SSE — client count in health/history

| Test | Expected | Result |
|------|----------|--------|
| GET /health/history → 200 | 200 | ✅ |
| sseClients field present | number | ✅ |

### Cleanup

| Test | Expected | Result |
|------|----------|--------|
| Server closed + adapter disconnected | no error | ✅ |

**24 / 24 passed**

## Not Tested (requires full running process or external integrations)

| Test | Reason |
|------|--------|
| SSE reconnection with Last-Event-ID | Not implemented in V1 — client reconnects fresh |
| High client count stress test | Would require spawning many concurrent connections |
| SSE through reverse proxy (nginx) | Infrastructure-dependent |
