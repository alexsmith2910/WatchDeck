import chalk from 'chalk'
import ora from 'ora'
import { initConfig } from '../config/index.js'
import { eventBus } from '../core/eventBus.js'
import type { EventMap } from '../core/eventTypes.js'
import { MongoDBAdapter } from '../storage/mongodb.js'
import { formatWarning } from '../utils/errors.js'

interface StartOptions {
  port?: string
  config?: string
  verbose: boolean
  silent: boolean
  apiOnly: boolean
}

const SEPARATOR = chalk.dim('  ' + '─'.repeat(50))

function printStartupWarnings(notices: string[]): void {
  if (notices.length === 0) return
  console.log('')
  console.log(
    chalk.dim('  ── ') +
    chalk.yellow.bold('Startup warnings') +
    chalk.dim(' ' + '─'.repeat(30)),
  )
  for (const n of notices) {
    console.log(n)
  }
  console.log(SEPARATOR)
  console.log('')
}

export async function runStart(options: StartOptions): Promise<void> {
  if (!options.silent) {
    console.log(chalk.cyan('WatchDeck') + ' starting...')
    if (options.verbose) {
      console.log('Options:', options)
    }
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------
  let result
  try {
    result = await initConfig(options.config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      ['', chalk.red.bold('  ✗  WatchDeck failed to start'), '', msg].join('\n') + '\n',
    )
    process.exit(1)
  }

  const { config, warnings, configFound, configPath } = result
  const port = options.port !== undefined ? parseInt(options.port, 10) : config.port

  if (!options.silent) {
    const notices: string[] = []

    if (!configFound && options.config) {
      notices.push(
        formatWarning('config', `File not found: ${chalk.dim(configPath)} — reverting to defaults`),
      )
    }
    notices.push(...warnings)
    printStartupWarnings(notices)

    if (options.verbose) {
      console.log(chalk.dim('Config:'), {
        port,
        apiBasePath: config.apiBasePath,
        dashboardMode: options.apiOnly ? 'api-only (--api-only flag)' : config.dashboardMode,
      })
      console.log('')
    }
  }

  // -------------------------------------------------------------------------
  // Database — connect + migrate
  // -------------------------------------------------------------------------
  const dbUri = process.env.MX_DB_URI!
  const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'
  const adapter = new MongoDBAdapter(dbUri, dbPrefix, config)

  // Runtime reconnect listeners — stay active for the lifetime of the process.
  eventBus.on('db:reconnecting', ({ attempt, maxAttempts, nextRetryInSeconds }) => {
    if (options.silent) return
    const max = maxAttempts === 0 ? '∞' : String(maxAttempts)
    console.log(
      chalk.yellow('  ↻') +
      chalk.dim(`  Reconnecting — attempt ${attempt}/${max}, next in ${nextRetryInSeconds}s`),
    )
  })
  eventBus.on('db:reconnected', ({ outageDurationSeconds }) => {
    if (options.silent) return
    console.log(chalk.green('  ✓') + chalk.dim(`  Reconnected after ${outageDurationSeconds}s`))
  })
  eventBus.on('db:fatal', ({ totalAttempts, totalOutageDuration }) => {
    process.stderr.write(
      [
        '',
        chalk.red.bold('  ✗  Lost database connection permanently'),
        chalk.dim(`     ${totalAttempts} attempts over ${totalOutageDuration}s`),
        '',
      ].join('\n') + '\n',
    )
    process.exit(1)
  })

  // -- Connect ---------------------------------------------------------------

  const dbSpinner = ora({
    text: 'Connecting to database...',
    isSilent: options.silent,
  }).start()

  // Update spinner text on each failed boot attempt so the user sees progress.
  let inBootPhase = true
  const onBootError = ({ context }: EventMap['db:error']) => {
    if (!inBootPhase) return
    const match = /boot attempt (\d+)\/(\d+)/.exec(context)
    if (!match) return
    const [, current, max] = match.map(Number)
    if (current < max) {
      dbSpinner.text = `Connecting to database... (attempt ${current + 1}/${max})`
    }
  }
  eventBus.on('db:error', onBootError)

  // db:connected fires synchronously inside connect() — succeed the spinner there.
  eventBus.once('db:connected', ({ latencyMs }) => {
    dbSpinner.succeed(chalk.bold('Database connected') + '  ' + chalk.dim(`${latencyMs}ms`))
  })

  try {
    await adapter.connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    dbSpinner.fail(chalk.bold('Failed to connect to database'))
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

  // -- Migrate ---------------------------------------------------------------

  const migSpinner = ora({
    text: 'Running migrations...',
    isSilent: options.silent,
  }).start()

  try {
    await adapter.migrate()
    migSpinner.succeed(chalk.bold('Migrations complete'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    migSpinner.fail(chalk.bold('Migration failed'))
    process.stderr.write(chalk.dim('  ' + msg) + '\n')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // TODO: wire up check engine and Fastify server
  // -------------------------------------------------------------------------
  if (!options.silent) {
    console.log('')
    console.log(chalk.yellow('  Server startup not yet implemented.'))
  }
}
