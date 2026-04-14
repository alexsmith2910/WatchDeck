# Step 6 — Buffer Pipeline Tests

## Automated (npx tsx tests/step-6-buffer.test.ts)

### MemoryBuffer

| Test | Expected | Result |
|------|----------|--------|
| Starts empty | isEmpty() true, size = 0 | ✅ |
| push() accepted when below capacity | Returns true | ✅ |
| push() at capacity | isFull() true | ✅ |
| push() rejected when full | Returns false | ✅ |
| flush() returns all items in order | [1,2,3] | ✅ |
| flush() resets buffer | isEmpty(), size = 0 | ✅ |
| push() accepted again after flush | Returns true, size = 1 | ✅ |

### DiskBuffer — basic operations

| Test | Expected | Result |
|------|----------|--------|
| isEmpty() before first write | true (no file) | ✅ |
| lineCount() before first write | 0 | ✅ |
| append() creates file and writes 3 lines | lineCount = 3 | ✅ |
| readBatch(2) returns first 2 items | Items 1 and 2 in order | ✅ |
| readBatch() is non-destructive | lineCount unchanged after read | ✅ |
| truncateBatch(2) removes first 2 lines | lineCount = 1, remaining = 'down' | ✅ |
| Empty after final truncate | isEmpty() true | ✅ |

### DiskBuffer — corrupted line skipping

| Test | Expected | Result |
|------|----------|--------|
| Corrupted line skipped in readBatch | 2 of 3 lines returned | ✅ |
| system:warning emitted for corrupted line | module = 'disk-buffer' | ✅ |

### Replay integration (Atlas)

| Test | Expected | Result |
|------|----------|--------|
| Adapter connects to Atlas | Connected successfully | ✅ |
| 5 payloads seeded to disk buffer | lineCount = 5 | ✅ |
| replayFromDisk replays all 5 | replayed = 5, errors = 0 | ✅ |
| Disk buffer empty after replay | isEmpty() true | ✅ |

**36 / 36 passed**

## Observed via watchdeck start (startup replay)

3 entries seeded to `~/.watchdeck/buffer.jsonl` then `watchdeck start` run:

```
── Database ─────────────────────────────────────

✔ Connected  1267ms
✔ Migrations complete
✔ Replayed 3 checks
```

Disk buffer confirmed empty after process ran.

## Not Tested (requires live DB disconnect)

| Test | Reason |
|------|--------|
| Pipeline switches to buffer mode on db:disconnected | Requires killing DB mid-run — manual test in step 15 |
| Memory buffer overflow spills to disk | Same — needs sustained outage |
| db:reconnected drains memory + replays disk | Same |
| OutageTracker writes SystemEventDoc to mx_system_events | Same — fires on db:reconnected |
| Replay retry logic (3 attempts, 5s gaps) | Requires DB going down during replay |
| replay:progress events stream to SSE clients | SSE broker not yet implemented — tested in step 9 |
