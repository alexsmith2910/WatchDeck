import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import { initConfig } from '../config/index.js'
import { eventBus, initEventBus } from '../core/eventBus.js'
import type { EventMap } from '../core/eventTypes.js'
import { MongoDBAdapter } from '../storage/mongodb.js'
import type { CheckWritePayload } from '../storage/types.js'
import { MemoryBuffer } from '../buffer/memoryBuffer.js'
import { DiskBuffer } from '../buffer/diskBuffer.js'
import { replayFromDisk } from '../buffer/replay.js'
import { OutageTracker } from '../buffer/outageTracker.js'
import { BufferPipeline } from '../buffer/pipeline.js'
import { formatWarning } from '../utils/errors.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const SECTION_WIDTH = 50

function header(): void {
  console.log('')
  console.log(chalk.cyan.bold('  WatchDeck') + chalk.dim(`  v${version}`))
}

function section(title: string): void {
  const dashes = chalk.dim('─'.repeat(Math.max(0, SECTION_WIDTH - title.length - 1)))
  console.log('')
  console.log(chalk.dim('  ── ') + chalk.bold(title) + ' ' + dashes)
  console.log('')
}

function ok(text: string, detail?: string): void {
  const line = `  ${chalk.green('✓')}  ${text}`
  console.log(detail ? line + '  ' + chalk.dim(detail) : line)
}

function warn(text: string): void {
  console.log(`  ${chalk.yellow('⚠')}  ${text}`)
}

function subItem(text: string): void {
  console.log(`       ${chalk.dim(text)}`)
}

function warnSubItem(text: string): void {
  console.log(`       ${text}`)
}

/** Create an ora spinner pre-configured to align with ok()/warn() items. */
function spinner(text: string, silent: boolean): Ora {
  return ora({ text, indent: 2, isSilent: silent })
}

/** Extract just the host from a MongoDB URI without exposing credentials. */
function hostFromUri(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return 'unknown host'
  }
}

// ---------------------------------------------------------------------------
// Start command
// ---------------------------------------------------------------------------

interface StartOptions {
  port?: string
  config?: string
  verbose: boolean
  silent: boolean
  apiOnly: boolean
}

export async function runStart(options: StartOptions): Promise<void> {
  const { silent, verbose } = options

  if (!silent) header()

  // ── Startup ──────────────────────────────────────────────────────────────

  if (!silent) section('Startup')

  let result
  try {
    result = await initConfig(options.config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!silent) {
      console.log(`  ${chalk.red('✗')}  Config failed`)
      console.log('')
    }
    process.stderr.write(msg + '\n')
    process.exit(1)
  }

  const { config, warnings, configFound, configPath } = result

  // Apply config-driven event bus settings before any subscribers are registered.
  initEventBus(config)

  const port = options.port !== undefined ? parseInt(options.port, 10) : config.port

  if (!silent) {
    const dashboardMode = options.apiOnly ? 'api-only' : config.dashboardMode
    ok('Config loaded', `port ${port}  ·  ${dashboardMode}`)

    if (verbose) {
      subItem(`file     ${configFound ? configPath : 'not found — using defaults'}`)
      subItem(`api      ${config.apiBasePath}`)
      subItem(`dashboard  ${config.dashboardRoute}`)
      subItem(`check interval  ${config.defaults.checkInterval}s  ·  timeout ${config.defaults.timeout / 1000}s`)
      subItem(`retention  ${config.retention.detailedDays}d checks  ·  ${config.retention.hourlyDays}d hourly  ·  ${config.retention.daily} daily`)
    }

    // Event bus init confirmation (verbose only)
    if (verbose) {
      ok(
        'Event bus',
        `maxListeners ${config.rateLimits.maxEventListeners}  ·  history ${config.eventHistorySize}`,
      )
    }

    // Collect notices: missing config file + module token warnings.
    const notices: string[] = []

    if (!configFound && options.config) {
      notices.push(
        formatWarning('config', `File not found: ${chalk.dim(configPath)} — reverting to defaults`),
      )
    }
    notices.push(...warnings)

    if (notices.length === 0) {
      ok('No warnings')
    } else {
      warn(`${notices.length} warning${notices.length === 1 ? '' : 's'}`)
      for (const n of notices) {
        warnSubItem(n)
      }
    }
  }

  // ── Database ─────────────────────────────────────────────────────────────

  if (!silent) section('Database')

  const dbUri = process.env.MX_DB_URI!
  const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'
  const adapter = new MongoDBAdapter(dbUri, dbPrefix, config)

  // Runtime reconnect listeners — stay active for the lifetime of the process.
  eventBus.subscribe('db:reconnecting', ({ attempt, maxAttempts, nextRetryInSeconds }) => {
    if (silent) return
    const max = maxAttempts === 0 ? '∞' : String(maxAttempts)
    warn(`Reconnecting  attempt ${attempt}/${max}  ·  next in ${nextRetryInSeconds}s`)
  }, 'standard')
  eventBus.subscribe('db:reconnected', ({ outageDurationSeconds }) => {
    if (silent) return
    ok(`Reconnected`, `after ${outageDurationSeconds}s outage`)
  }, 'standard')
  eventBus.subscribe('db:fatal', ({ totalAttempts, totalOutageDuration }) => {
    console.log(`  ${chalk.red('✗')}  Connection lost permanently`)
    console.log(`       ${chalk.dim(`${totalAttempts} attempts  ·  ${totalOutageDuration}s outage`)}`)
    process.exit(1)
  }, 'critical')

  // Connect
  const dbSpinner = spinner('Connecting to database...', silent).start()

  // Update spinner text on each failed boot attempt.
  let inBootPhase = true
  const onBootError = ({ context }: EventMap['db:error']) => {
    if (!inBootPhase) return
    const match = /boot attempt (\d+)\/(\d+)/.exec(context)
    if (!match) return
    const [, current, max] = match.map(Number)
    if (current < max) {
      dbSpinner.text = `Connecting to database...  attempt ${current + 1}/${max}`
    }
  }
  eventBus.on('db:error', onBootError)

  // db:connected fires synchronously inside connect() — succeed the spinner there.
  eventBus.once('db:connected', ({ latencyMs }) => {
    dbSpinner.succeed(`${chalk.bold('Connected')}  ${chalk.dim(`${latencyMs}ms`)}`)
    if (!silent && verbose) {
      subItem(`host     ${hostFromUri(dbUri)}`)
      subItem(`prefix   ${dbPrefix}  ·  pool ${config.rateLimits.dbPoolSize}`)
      subItem(`reconnect  max ${config.rateLimits.dbReconnectAttempts === 0 ? '∞' : config.rateLimits.dbReconnectAttempts} attempts  ·  30s→5min backoff`)
    }
  })

  try {
    await adapter.connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    dbSpinner.fail(chalk.bold('Failed to connect'))
    process.stderr.write(
      [
        '',
        chalk.dim('  ' + msg),
        '',
        chalk.dim('  Check that MongoDB is running and MX_DB_URI in your .env is correct.'),
        '',
      ].join('\n') + '\n',
    )
    process.exit(1)
  } finally {
    inBootPhase = false
    eventBus.off('db:error', onBootError)
  }

  // Migrate
  const migSpinner = spinner('Running migrations...', silent).start()

  try {
    await adapter.migrate()
    migSpinner.succeed(chalk.bold('Migrations complete'))
    if (!silent && verbose) {
      subItem('9 collections ensured')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    migSpinner.fail(chalk.bold('Migrations failed'))
    process.stderr.write(chalk.dim('  ' + msg) + '\n')
    process.exit(1)
  }

  // ── Buffer ───────────────────────────────────────────────────────────────

  if (!silent) section('Buffer')

  const diskBufferPath = path.join(os.homedir(), '.watchdeck', 'buffer.jsonl')
  const memBuffer = new MemoryBuffer<CheckWritePayload>(config.buffer.memoryCapacity)
  const diskBuffer = new DiskBuffer(diskBufferPath)
  const outageTracker = new OutageTracker(adapter)
  const pipeline = new BufferPipeline(adapter, memBuffer, diskBuffer, outageTracker)

  outageTracker.register()
  pipeline.register()

  if (!silent) {
    ok('Pipeline active', `memory ${config.buffer.memoryCapacity}  ·  disk ${diskBufferPath}`)
    if (verbose) {
      subItem('outage tracker registered')
      subItem('check:complete subscriber registered (critical priority)')
      subItem('db:disconnected / db:reconnected subscribers registered')
    }
  }

  // Replay any checks buffered during a previous process run.
  if (!(await diskBuffer.isEmpty())) {
    const lineCount = await diskBuffer.lineCount()
    const replaySpinner = spinner(
      `Replaying ${lineCount} buffered check${lineCount === 1 ? '' : 's'}...`,
      silent,
    ).start()
    const result = await replayFromDisk(adapter, diskBuffer)
    if (!silent) {
      if (result.errors === 0) {
        replaySpinner.succeed(
          chalk.bold(`Replayed ${result.replayed} check${result.replayed === 1 ? '' : 's'}`),
        )
      } else {
        replaySpinner.warn(
          `Replayed ${result.replayed}  ·  ${chalk.yellow(`${result.errors} errors remain on disk`)}`,
        )
      }
    } else {
      replaySpinner.stop()
    }
  } else if (!silent && verbose) {
    subItem('no buffered data on disk')
  }

  // ── Server ───────────────────────────────────────────────────────────────
  // TODO: wire up check engine and Fastify server

  if (!silent) {
    section('Server')
    console.log(`  ${chalk.yellow('…')}  Not yet implemented`)
  }
}
