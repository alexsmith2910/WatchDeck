# Step 3 — Config and Env Loader Tests

## Env Loader — Missing File

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| No .env file — red header + no-file message only | `watchdeck start` (no .env) | "No .env file found" message, no variable errors listed, exit 1 | ✅ |
| No .env file — does NOT list individual missing vars | `watchdeck start` (no .env) | Only the missing-file block shown (not MX_DB_URI error block) | ✅ |

## Env Loader — Missing Variables

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| .env exists, MX_DB_URI missing | `watchdeck start` (.env has no MX_DB_URI) | ✗ MX_DB_URI block with Expected + Fix, exit 1 | ✅ |
| .env missing — fix message differs from var-missing fix | — | No-file fix: "Run watchdeck init". Var-missing fix: "Add MX_DB_URI=… to your .env file" | ✅ |

## Env Loader — System Env Override

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| System env var overrides .env value | `MX_DB_URI=mongodb://SYSTEM:… watchdeck start --verbose` (.env has wrong URI) | Starts OK — dotenv does not clobber pre-set system env vars | ✅ |

## Config Loader — File Discovery

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| No watchdeck.config.js — falls back to all defaults | `watchdeck start --verbose` (no config file) | port 4000, apiBasePath /api/mx, dashboardMode standalone | ✅ |
| --config flag loads file from custom path | `watchdeck start --config /path/to/custom.js --verbose` | Config values from that file applied (port 5555, apiBasePath /api/custom) | ✅ |
| --config flag, file not found — falls back to defaults | `watchdeck start --config /does/not/exist.js --verbose` | Starts with defaults, exit 0 | ✅ |

## Config Loader — Deep Merge

| Test | Scenario | Expected | Result |
|------|----------|----------|--------|
| Partial override merges onto defaults | config sets port: 3000, defaults.checkInterval: 120 | port is 3000, all other fields remain at default values | ✅ |
| Nested object merge — sibling fields preserved | config only sets defaults.checkInterval | defaults.timeout, latencyThreshold, etc. unchanged | ✅ |

## Validator — Field Validation

| Test | Config | Expected | Result |
|------|--------|----------|--------|
| Invalid port | port: 99999 | ✗ port error, exit 1 | ✅ |
| checkInterval not in allowed list | defaults.checkInterval: 45 | ✗ checkInterval error, exit 1 | ✅ |
| timeout below minimum | defaults.timeout: 500 | ✗ timeout error, exit 1 | ✅ |
| heartbeatInterval below minimum | sse.heartbeatInterval: 5 | ✗ heartbeatInterval error, exit 1 | ✅ |
| Multiple invalid fields — all errors shown | port + checkInterval + timeout + heartbeatInterval all invalid | 4 errors listed in one report, exit 1 | ✅ |
| Invalid aggregation.time format | aggregation.time: "3am" | ✗ aggregation.time error, expected HH:MM format, exit 1 | ✅ |

## Validator — Cross-Field Validation

| Test | Config | Expected | Result |
|------|--------|----------|--------|
| checkInterval below minCheckInterval | rateLimits.minCheckInterval: 60, defaults.checkInterval: 30 | ✗ defaults.checkInterval error referencing minCheckInterval value, exit 1 | ✅ |

## Validator — Cross-Validation (Module Tokens)

| Test | Config / Env | Expected | Result |
|------|-------------|----------|--------|
| modules.discord true, no MX_DISCORD_TOKEN | config: discord: true, .env: no token | ⚠ yellow warning to stderr, starts OK, exit 0 | ✅ |
| modules.slack true, no MX_SLACK_TOKEN | config: slack: true, .env: no token | ⚠ yellow warning to stderr, starts OK, exit 0 | ✅ |
| Both tokens present — no warnings | .env has both tokens | No warnings, clean start | ✅ |
| Module disabled — no warning even without token | config: discord: false | No warning for MX_DISCORD_TOKEN | ✅ |

## Start Command Wiring

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| --port flag overrides config port | `watchdeck start --port 8080 --verbose` | Config loaded shows port: 8080, exit 0 | ✅ |
| Config error prints red header before report | Any invalid config | "✗ WatchDeck failed to start" line appears above the error report | ✅ |
| Env error prints red header before details | No .env / missing var | "✗ WatchDeck failed to start" line appears above env error | ✅ |
| Valid config + valid env — exit 0 | `watchdeck start` (all correct) | Exits 0, "Server startup not yet implemented" message | ✅ |
