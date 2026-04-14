# Step 7 — Check Engine Tests

## Automated (npx tsx tests/step-7-check-engine.test.ts)

### statusEval

| Test | Expected | Result |
|------|----------|--------|
| HTTP 200 in expected list | healthy | ✅ |
| Healthy result has null statusReason | null | ✅ |
| HTTP 500 not in expected list | down | ✅ |
| statusReason includes status code | "HTTP 500 — expected 200" | ✅ |
| Latency 6000ms over 5000ms threshold | degraded | ✅ |
| statusReason mentions response time | "6000ms exceeds 5000ms threshold" | ✅ |
| Network error with no statusCode | down | ✅ |
| statusReason is the error message | "ECONNREFUSED" | ✅ |
| 201 in multi-code expected list [200, 201, 204] | healthy | ✅ |
| Port open, low latency | healthy | ✅ |
| Port refused | down | ✅ |
| Port open but high latency | degraded | ✅ |

### httpCheck — live network

| Test | Expected | Result |
|------|----------|--------|
| GET httpbin.org/status/200 → statusCode | 200 | ✅ |
| responseTime > 0 | true | ✅ |
| No errorMessage on 200 response | null | ✅ |
| GET httpbin.org/status/500 → statusCode | 500 | ✅ |
| Non-2xx does not set errorMessage | null | ✅ |
| Non-existent domain → null statusCode | null | ✅ |
| Non-existent domain → errorMessage set | ENOTFOUND … | ✅ |
| responseTime still recorded on DNS error | > 0 | ✅ |
| Invalid URL → null statusCode | null | ✅ |
| Invalid URL → errorMessage says "Invalid URL" | "Invalid URL: …" | ✅ |
| Invalid URL bails before timing → responseTime 0 | 0 | ✅ |

### portCheck — live network

| Test | Expected | Result |
|------|----------|--------|
| Port 80 on example.com → open | true | ✅ |
| responseTime > 0 | true | ✅ |
| No errorMessage when open | null | ✅ |
| Port 1 on localhost → not open | false | ✅ |
| responseTime still recorded on refused | > 0 | ✅ |
| errorMessage set when refused | "ECONNREFUSED" | ✅ |

### checkRunner — check:complete event

| Test | Expected | Result |
|------|----------|--------|
| check:complete emitted for HTTP check | emitted | ✅ |
| endpointId matches endpoint._id | exact match | ✅ |
| status is one of healthy/degraded/down | valid value | ✅ |
| responseTime > 0 | true | ✅ |
| timestamp is a Date | Date instance | ✅ |
| 503 with expectedStatusCodes [200] → down | down | ✅ |
| errorMessage set for down status | "HTTP 503 — expected 200" | ✅ |
| check:complete emitted for port check | emitted | ✅ |
| Port check statusCode is null | null | ✅ |
| Port check responseTime > 0 | true | ✅ |

### CheckScheduler — DB integration

| Test | Expected | Result |
|------|----------|--------|
| Adapter connects | Connected | ✅ |
| Scheduler inits without error | queueSize ≥ 0 | ✅ |
| endpoint:created increases queueSize by 1 | +1 | ✅ |
| scheduleImmediate returns true for known endpoint | true | ✅ |
| scheduleImmediate returns false for unknown endpoint | false | ✅ |
| endpoint:deleted decreases queueSize | −1 | ✅ |
| Port endpoint not inserted when portChecks disabled | no change | ✅ |
| Adapter disconnects | Disconnected | ✅ |

**47 / 47 passed**

## Not Tested (requires live scheduler run or timing-sensitive setup)

| Test | Reason |
|------|--------|
| Concurrency gate: no more than maxConcurrentChecks run at once | Requires timing control and concurrent dispatches — manual test in step 15 |
| Per-host spacing: same host deferred by perHostMinGap seconds | Requires sub-second precision scheduling — manual test in step 15 |
| Paused endpoint skipped in tick, active again after unpause | Requires emitting endpoint:updated with status change — manual test in step 15 |
| SSL cert days captured via TLS intercept | Requires captureSsl=true and a live HTTPS endpoint with cert — manual test in step 15 |
| Scheduler updates consecutiveFailures in DB after check | Requires live endpoint + multiple failing checks — manual test in step 15 |
| Tick loop actually fires checks on schedule | Requires running process with real endpoints — covered by step 15 end-to-end test |
