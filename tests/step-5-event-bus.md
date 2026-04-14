# Step 5 — Event Bus Tests

## Automated (npx tsx tests/event-bus.test.ts)

| Test | Expected | Result |
|------|----------|--------|
| subscribe() delivers payload to listener | Listener receives correct payload | ✅ |
| unsubscribe() stops further delivery | No call after unsub | ✅ |
| getHistory() records events | History grows by emitted count | ✅ |
| getHistory() returns chronological order | Timestamps non-decreasing | ✅ |
| getHistory() carries correct event names | All entries have expected `event` field | ✅ |
| Circular buffer caps at configured size | 5 emits into size-3 buffer → 3 entries | ✅ |
| Circular overflow drops oldest entry | Retained: msg-3, msg-4, msg-5 | ✅ |
| initEventBus() sets maxListeners from config | getMaxListeners() === 42 after config with 42 | ✅ |
| Priority critical — sync throw → system:critical emitted | system:critical fires with module = event name | ✅ |
| Priority standard — sync throw → system:warning emitted | system:warning fires with module = event name | ✅ |
| Priority low — throw does NOT emit system:warning | system:warning not fired | ✅ |
| Priority low — throw does NOT emit system:critical | system:critical not fired | ✅ |
| Priority low — throw calls console.error | console.error called | ✅ |
| Async subscriber throw → system:warning emitted | system:warning fires after promise rejects | ✅ |

**16 / 16 passed**

## Observed via watchdeck start

| Observation | Expected | Result |
|-------------|----------|--------|
| initEventBus() called without crash | Clean startup, no MaxListenersExceededWarning | ✅ |
| DB reconnect subscribers registered via subscribe() | Startup proceeds to DB section normally | ✅ |
| Full startup output renders correctly | Startup → Database → Server sections all visible | ✅ |

## Not Tested (runtime disconnect required)

| Test | Reason |
|------|--------|
| system:critical handler output during live outage | Requires DB disconnect mid-run — manual test in step 15 |
| system:warning handler output during live outage | Same |
| getHistory() replay on SSE connect | SSE broker not yet implemented — tested in step 9 |
