import chalk from 'chalk'

interface StartOptions {
  port?: string
  config?: string
  verbose: boolean
  silent: boolean
  apiOnly: boolean
}

export async function runStart(options: StartOptions): Promise<void> {
  if (!options.silent) {
    console.log(chalk.cyan('WatchDeck') + ' starting...')

    if (options.verbose) {
      console.log('Options:', options)
    }
  }

  // TODO: Step 7 — wire up engine, config loader, and Fastify server
  if (!options.silent) {
    console.log(chalk.yellow('Start command not yet implemented.'))
  }
}
