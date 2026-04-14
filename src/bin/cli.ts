#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from '../commands/init.js'
import { runStart } from '../commands/start.js'
import { runStatus } from '../commands/status.js'

const program = new Command()

program
  .name('watchdeck')
  .description('Self-hosted endpoint monitoring toolkit')
  .version('0.1.0')

program
  .command('init')
  .description('Run the setup wizard to generate watchdeck.config.js and .env')
  .option('--force', 'overwrite existing config and env files without prompting')
  .option('--defaults', 'skip the wizard and generate files with default values')
  .action(async (options: { force: boolean; defaults: boolean }) => {
    await runInit(options)
  })

program
  .command('start')
  .description('Start the WatchDeck server')
  .option('--port <number>', 'override the port from config')
  .option('--config <path>', 'path to a custom config file')
  .option('--verbose', 'enable verbose logging')
  .option('--silent', 'suppress all output')
  .option('--api-only', 'start without serving the dashboard')
  .action(
    async (options: {
      port?: string
      config?: string
      verbose: boolean
      silent: boolean
      apiOnly: boolean
    }) => {
      await runStart(options)
    },
  )

program
  .command('status')
  .description('Show the current status of the WatchDeck server')
  .option('--json', 'output status as JSON')
  .action(async (options: { json: boolean }) => {
    await runStatus(options)
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
