import chalk from 'chalk'
import { initConfig } from '../config/index.js'
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

    // TODO: Step 7 — wire up engine and Fastify server using `config` and `port`
    console.log(chalk.yellow('Server startup not yet implemented (Step 7).'))
  }
}
