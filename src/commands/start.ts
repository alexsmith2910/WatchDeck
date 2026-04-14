import chalk from 'chalk'
import { initConfig } from '../config/index.js'
import { eventBus } from '../core/eventBus.js'
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

  let result
  try {
    result = await initConfig(options.config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      [
        '',
        chalk.red.bold('  ✗  WatchDeck failed to start'),
        '',
        msg,
      ].join('\n') + '\n',
    )
    process.exit(1)
  }

  const { config, warnings, configFound, configPath } = result

  if (!options.silent) {
    // Build ordered notice list: config-load issues first, then module warnings.
    const notices: string[] = []

    if (!configFound && options.config) {
      // Only warn when the user explicitly passed --config and the file is missing.
      // Silent fallback to defaults when no --config flag is expected behaviour.
      notices.push(
        formatWarning('config', `File not found: ${chalk.dim(configPath)} — reverting to defaults`),
      )
    }

    notices.push(...warnings)

    printStartupWarnings(notices)

    // Port flag overrides config value.
    const port = options.port !== undefined ? parseInt(options.port, 10) : config.port

    if (options.verbose) {
      console.log(chalk.dim('Config loaded:'), {
        port,
        apiBasePath: config.apiBasePath,
        dashboardMode: options.apiOnly ? 'api-only (--api-only flag)' : config.dashboardMode,
      })
    }

    // -----------------------------------------------------------------------
    // MongoDB connection + migrations
    // -----------------------------------------------------------------------
    const dbUri = process.env.MX_DB_URI!
    const dbPrefix = process.env.MX_DB_PREFIX ?? 'mx_'
    const adapter = new MongoDBAdapter(dbUri, dbPrefix, config)

    // Subscribe before connecting so no events are missed.
    eventBus.on('db:connected', ({ latencyMs }) => {
      if (!options.silent) {
        console.log(chalk.green('✓') + chalk.dim('  db connected') + chalk.dim(` (${latencyMs}ms)`))
      }
    })
    eventBus.on('db:reconnecting', ({ attempt, maxAttempts, nextRetryInSeconds }) => {
      const max = maxAttempts === 0 ? '∞' : String(maxAttempts)
      if (!options.silent) {
        console.log(
          chalk.yellow('↻') +
          chalk.dim(`  db reconnecting — attempt ${attempt}/${max}, next retry in ${nextRetryInSeconds}s`),
        )
      }
    })
    eventBus.on('db:reconnected', ({ outageDurationSeconds }) => {
      if (!options.silent) {
        console.log(chalk.green('✓') + chalk.dim(`  db reconnected after ${outageDurationSeconds}s outage`))
      }
    })
    eventBus.on('db:fatal', ({ totalAttempts, totalOutageDuration }) => {
      process.stderr.write(
        [
          '',
          chalk.red.bold('  ✗  WatchDeck lost database connection permanently'),
          chalk.dim(`     ${totalAttempts} reconnect attempts over ${totalOutageDuration}s`),
          '',
        ].join('\n') + '\n',
      )
      process.exit(1)
    })

    try {
      await adapter.connect()
      await adapter.migrate()
      if (options.verbose) {
        console.log(chalk.dim('  Migrations complete'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        [
          '',
          chalk.red.bold('  ✗  WatchDeck failed to connect to MongoDB'),
          '',
          chalk.dim('  ' + msg),
          '',
          chalk.dim('  Make sure MongoDB is running and MX_DB_URI in your .env is correct.'),
          '',
        ].join('\n') + '\n',
      )
      process.exit(1)
    }

    // TODO: Step 7 — wire up check engine and Fastify server
    console.log(chalk.yellow('Server startup not yet implemented.'))
  }
}
