import chalk from 'chalk'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Loaded env shape
// ---------------------------------------------------------------------------

export interface LoadedEnv {
  /** MongoDB connection string. Required. */
  MX_DB_URI: string
  /** Collection name prefix. Defaults to "mx_". */
  MX_DB_PREFIX: string
  /** Discord bot token. Required when modules.discord is true. */
  MX_DISCORD_TOKEN?: string
  /** Slack bot token. Required when modules.slack is true. */
  MX_SLACK_TOKEN?: string
  /** AES-256 key for encrypting stored secrets. Optional in V1. */
  MX_ENCRYPTION_KEY?: string
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load the .env file from the current working directory, then read and
 * validate the WatchDeck environment variables from process.env.
 *
 * System env vars already set in the process take precedence over .env
 * values (standard dotenv behaviour — dotenv will not overwrite them).
 *
 * Throws if required variables are missing.
 */
export function loadEnv(): LoadedEnv {
  const envPath = resolve(process.cwd(), '.env')

  // No .env file at all — stop here, don't enumerate missing variables
  // (they're obviously all missing, and the fix is the same for all of them).
  if (!existsSync(envPath)) {
    throw new Error(
      [
        `  ${chalk.yellow('!')}  ${chalk.bold('No .env file found')} in ${chalk.dim(envPath)}`,
        `     Run ${chalk.cyan('"watchdeck init"')} to generate one, or create it manually.`,
        '',
      ].join('\n'),
    )
  }

  // quiet: true suppresses the dotenv v17 verbose "injected env (N)" log.
  dotenv.config({ path: envPath, quiet: true })

  // ------------------------------------------------------------------
  // Validate required variables — collect all errors before throwing.
  // ------------------------------------------------------------------
  const errors: Array<{ field: string; expected: string; fix: string }> = []

  if (!process.env.MX_DB_URI) {
    errors.push({
      field: 'MX_DB_URI',
      expected: 'MongoDB connection string, e.g. mongodb://localhost:27017/watchdeck',
      fix: 'Add MX_DB_URI=mongodb://... to your .env file',
    })
  }

  if (errors.length > 0) {
    const lines: string[] = []

    for (const e of errors) {
      lines.push(
        `  ${chalk.red('✗')}  ${chalk.bold.red(e.field)}`,
        `     ${chalk.dim('Expected')}  ${e.expected}`,
        `     ${chalk.green('Fix')}       ${e.fix}`,
        '',
      )
    }

    throw new Error(lines.join('\n'))
  }

  return {
    MX_DB_URI: process.env.MX_DB_URI!,
    MX_DB_PREFIX: process.env.MX_DB_PREFIX ?? 'mx_',
    MX_DISCORD_TOKEN: process.env.MX_DISCORD_TOKEN,
    MX_SLACK_TOKEN: process.env.MX_SLACK_TOKEN,
    MX_ENCRYPTION_KEY: process.env.MX_ENCRYPTION_KEY,
  }
}
