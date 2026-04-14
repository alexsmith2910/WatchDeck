# Step 2 — CLI Entry Point Tests

## Commands & Flags

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Help output — all 3 commands listed | `watchdeck --help` | init, start, status shown | ✅ |
| Short version flag | `watchdeck -v` | `0.1.0` | ✅ |
| Long version flag | `watchdeck --version` | `0.1.0` | ✅ |
| Init help — flags shown | `watchdeck init --help` | `--force`, `--defaults` listed | ✅ |
| Start help — flags shown | `watchdeck start --help` | `--port`, `--config`, `--verbose`, `--silent`, `--api-only` listed | ✅ |
| Status help — flags shown | `watchdeck status --help` | `--json` listed | ✅ |

## Start Command (Placeholder)

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Default output | `watchdeck start` | "WatchDeck starting..." + not implemented message | ✅ |
| Verbose flag prints options | `watchdeck start --verbose` | Options object printed | ✅ |
| Silent flag suppresses all output | `watchdeck start --silent` | No output | ✅ |

## Status Command (Placeholder)

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Default output | `watchdeck status` | Not implemented message | ✅ |
| JSON output | `watchdeck status --json` | Valid JSON with status and message fields | ✅ |

## Init — File Generation

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Defaults mode generates config | `watchdeck init --defaults` | `watchdeck.config.js` created | ✅ |
| Defaults mode generates env example | `watchdeck init --defaults` | `.env.example` created | ✅ |
| Config has all fields | — | port, modules, defaults, retention, rateLimits, buffer, sse, aggregation, cors, authMiddleware | ✅ |
| Env example has all vars | — | `MX_DB_URI`, `MX_DB_PREFIX`, `MX_ENCRYPTION_KEY` present | ✅ |
| Encryption key is generated | — | 32-char hex key in `.env.example` | ✅ |
| DB name appended to URI | — | URI ends with `/watchdeck` | ✅ |

## Init — Overwrite Protection

| Test | Command | Expected | Result |
|------|---------|----------|--------|
| Overwrite prompt fires for existing config | `watchdeck init --defaults` (files exist) | Asks to overwrite `watchdeck.config.js` | ✅ |
| Overwrite prompt fires for existing env | `watchdeck init --defaults` (files exist) | Asks to overwrite `.env.example` | ✅ |
| Force flag skips all prompts | `watchdeck init --defaults --force` | Files overwritten silently | ✅ |

## Init — Wizard Flow

| Test | Steps | Expected | Result |
|------|-------|----------|--------|
| Full wizard runs interactively | `watchdeck init` | All 6 steps presented in order | ✅ |
| Enter accepts default values | Press Enter on each prompt | Default values used | ✅ |
| Space selects notification channels | Space on Discord/Slack, then Enter | Selected channels set to true in config | ✅ |
| Cancel (Ctrl+C) exits cleanly | Ctrl+C mid-wizard | "Setup cancelled." message, no files written | ✅ |
| Declining overwrite cancels setup | Select No on overwrite prompt | "Setup cancelled." message | ✅ |
| Post-wizard instructions shown | Complete wizard | Next steps printed with .env.example copy instruction | ✅ |
