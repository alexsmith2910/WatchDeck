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
import { CheckScheduler } from '../core/scheduler.js'
import { buildServer } from '../api/server.js'
import { AggregationScheduler } from '../aggregation/scheduler.js'
import { IncidentManager } from '../alerts/incidentManager.js'
import { registerNotifications } from '../notifications/index.js'
import { probeRegistry } from '../core/health/probeRegistry.js'
import { registerCoreProbes } from '../core/health/register.js'
import { internalIncidents } from '../alerts/internalIncidents.js'
import { activity } from '../core/health/activity.js'
import { healthPersistence } from '../core/health/persistence.js'
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

/**
 * Register process-level guards so one escaping error in a module can't
 * tear the whole monitor down. Idempotent — safe to call more than once
 * if the start command is re-entered (e.g. during tests).
 */
let safetyNetsInstalled = false
function installProcessSafetyNets(): void {
  if (safetyNetsInstalled) return
  safetyNetsInstalled = true

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error(`  ${chalk.red('✗')}  unhandledRejection: ${err.message}`)
    if (err.stack) console.error(chalk.dim(err.stack))
    console.error(
      chalk.dim(
        '       The originating module should be handling this itself — please report it. Continuing.',
      ),
    )
  })

  process.on('uncaughtException', (err) => {
    console.error(`  ${chalk.red('✗')}  uncaughtException: ${err.message}`)
    if (err.stack) console.error(chalk.dim(err.stack))
    console.error(
      chalk.dim(
        '       The originating module should be handling this itself — please report it. Continuing.',
      ),
    )
  })
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

  // Last-line-of-defence handlers. Individual modules already try/catch
  // their own work (the event bus wraps subscribers; the dispatcher
  // catches around retries and the coalescing flush) but if anything
  // ever slips through we want to log it and *keep the monitor alive*
  // rather than drop off and stop checking endpoints. A dead monitor
  // is worse than a noisy one.
  installProcessSafetyNets()

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
    const migrateResult = await adapter.migrate()
    migSpinner.succeed(chalk.bold('Migrations complete'))
    if (!silent && verbose) {
      subItem(`${migrateResult.collectionCount} collections ensured`)
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

  // ── Check Engine ─────────────────────────────────────────────────────────

  if (!silent) section('Check Engine')

  const scheduler = new CheckScheduler(adapter, config)
  const engineSpinner = spinner('Loading endpoints...', silent).start()

  try {
    await scheduler.init()
    engineSpinner.succeed(
      chalk.bold(`Scheduler running`) +
        chalk.dim(`  ${scheduler.queueSize} endpoint${scheduler.queueSize === 1 ? '' : 's'} queued`),
    )
    if (!silent && verbose) {
      subItem(
        `concurrency  max ${config.rateLimits.maxConcurrentChecks}  ·  per-host gap ${config.rateLimits.perHostMinGap}s`,
      )
      subItem(
        `ssl checks  ${config.modules.sslChecks ? 'enabled' : 'disabled'}  ·  port checks  ${config.modules.portChecks ? 'enabled' : 'disabled'}`,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    engineSpinner.fail(chalk.bold('Scheduler failed to start'))
    process.stderr.write(chalk.dim('  ' + msg) + '\n')
    process.exit(1)
  }

  // ── Incidents ────────────────────────────────────────────────────────────

  if (!silent) section('Incidents')

  const incidentManager = new IncidentManager(adapter)
  const incSpinner = spinner('Starting incident manager...', silent).start()

  try {
    await incidentManager.init()
    const activeCount = (await adapter.listActiveIncidents()).length
    incSpinner.succeed(
      chalk.bold('Incident manager active') +
        (activeCount > 0
          ? chalk.dim(`  ${activeCount} active incident${activeCount === 1 ? '' : 's'}`)
          : chalk.dim('  no active incidents')),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    incSpinner.warn(chalk.bold('Incident manager failed') + chalk.dim(`  ${msg}`))
    // Non-fatal — checks still run, just no automatic incident creation.
  }

  // ── Notifications ────────────────────────────────────────────────────────

  if (!silent) section('Notifications')

  const notifications = registerNotifications({ adapter, config, port })
  const notifSpinner = spinner('Starting notification dispatcher...', silent).start()

  try {
    await notifications.start()
    const chCount = notifications.channels.size()
    notifSpinner.succeed(
      chCount > 0
        ? chalk.bold('Dispatcher active') +
            chalk.dim(`  ${chCount} channel${chCount === 1 ? '' : 's'}`)
        : chalk.bold('Dispatcher active') + chalk.dim('  no channels configured'),
    )
    if (!silent && verbose) {
      subItem(
        `coalescing  ${config.defaults.notifications.coalescing.enabled ? 'on' : 'off'}  ·  window ${config.defaults.notifications.coalescing.windowSeconds}s  ·  burst ≥${config.defaults.notifications.coalescing.minBurstCount}`,
      )
      subItem(
        `retry  ${config.defaults.notifications.retryOnFailure ? 'enabled' : 'disabled'}  ·  backoff [${config.defaults.notifications.retryBackoffMs.join(', ')}] ms`,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    notifSpinner.warn(chalk.bold('Notification dispatcher failed') + chalk.dim(`  ${msg}`))
    // Non-fatal — everything else can run without the dispatcher.
  }

  // ── Aggregation ──────────────────────────────────────────────────────────

  if (!silent) section('Aggregation')

  const aggregation = new AggregationScheduler(adapter, config)
  const aggSpinner = spinner('Starting aggregation scheduler...', silent).start()

  try {
    await aggregation.init()
    aggSpinner.succeed(
      chalk.bold('Aggregation active') +
        chalk.dim(`  hourly rollup  ·  daily at ${config.aggregation.time} UTC`),
    )
    if (!silent && verbose) {
      subItem(`retention  hourly ${config.retention.hourlyDays}d  ·  daily ${config.retention.daily}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    aggSpinner.warn(chalk.bold('Aggregation failed to start') + chalk.dim(`  ${msg}`))
    // Non-fatal — the rest of the system can run without aggregation.
  }

  // ── Server ───────────────────────────────────────────────────────────────

  if (!silent) section('Server')

  const serverSpinner = spinner('Starting API server...', silent).start()
  let server

  try {
    server = await buildServer({ adapter, scheduler, config, notifications, logRequests: verbose })
    await server.listen({ port, host: '0.0.0.0' })
    serverSpinner.succeed(
      chalk.bold('API server listening') + chalk.dim(`  http://localhost:${port}${config.apiBasePath}`),
    )

    // Wire and start the probe-based health system. Must happen after the
    // server is listening so the `checkers` loopback probe has a target.
    activity.start()
    internalIncidents.start()
    registerCoreProbes({
      adapter,
      scheduler,
      pipeline,
      memBuffer,
      diskBuffer,
      aggregation,
      config,
      port,
    })
    await healthPersistence.loadAndHydrate(adapter)
    probeRegistry.start()
    healthPersistence.start()
    if (!silent && verbose) {
      subItem(`auth      ${config.authMiddleware ? 'enabled' : 'disabled (no auth)'}`)
      subItem(`cors      origin ${config.cors.origin}`)
      subItem(`dashboard ${options.apiOnly ? 'api-only (--api-only)' : config.dashboardMode}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    serverSpinner.fail(chalk.bold('API server failed to start'))
    process.stderr.write(chalk.dim('  ' + msg) + '\n')
    process.exit(1)
  }

  // Graceful shutdown
  function shutdown(): void {
    probeRegistry.stop()
    healthPersistence.stop()
    internalIncidents.stop()
    activity.stop()
    scheduler.stop()
    notifications.stop()
    aggregation.stop()
    void healthPersistence.flush().finally(() => {
      void server!.close().finally(() => {
        void adapter.disconnect().finally(() => process.exit(0))
      })
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  if (!silent) {
    console.log('')
    console.log(chalk.dim('  Press Ctrl+C to stop'))
    if (verbose) {
      section('Requests')
    }
  }
}
