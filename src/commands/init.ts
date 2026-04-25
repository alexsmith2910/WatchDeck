import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import chalk from 'chalk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.resolve(__dirname, '../templates')

const CONFIG_FILE = 'watchdeck.config.js'
const ENV_EXAMPLE_FILE = '.env.example'

interface InitOptions {
  force: boolean
  defaults: boolean
}

function generateEncryptionKey(): string {
  // 32 bytes = 256 bits, encoded as 64 hex chars. Do NOT slice — the earlier
  // .slice(0, 32) silently halved the entropy to 128 bits.
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Exit cleanly if the prompt was cancelled. Narrows the return type to `T`
 * so the caller can use the value without a secondary cancel check.
 */
function requireValue<T>(value: T | symbol, label = 'Setup cancelled.'): T {
  if (p.isCancel(value)) {
    p.cancel(label)
    process.exit(0)
  }
  return value
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

function fileExists(filename: string): boolean {
  return fs.existsSync(path.resolve(process.cwd(), filename))
}

export async function runInit(options: InitOptions): Promise<void> {
  console.log('')
  p.intro(chalk.bold('WatchDeck Setup Wizard'))

  // Per-file overwrite checks
  if (!options.force) {
    const existingConfig = fileExists(CONFIG_FILE)
    const existingEnv = fileExists(ENV_EXAMPLE_FILE)

    if (existingConfig) {
      const overwrite = await p.confirm({
        message: `${chalk.yellow(CONFIG_FILE)} already exists. Overwrite?`,
        initialValue: false,
      })
      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel('Setup cancelled. Use --force to skip this prompt.')
        process.exit(0)
      }
    }

    if (existingEnv) {
      const overwrite = await p.confirm({
        message: `${chalk.yellow(ENV_EXAMPLE_FILE)} already exists. Overwrite?`,
        initialValue: false,
      })
      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel('Setup cancelled. Use --force to skip this prompt.')
        process.exit(0)
      }
    }
  }

  // Default mode — skip wizard
  if (options.defaults) {
    writeFiles({
      port: '4000',
      dbUri: 'mongodb://localhost:27017/watchdeck',
      dbName: 'watchdeck',
      dbPrefix: 'mx_',
      dashboardMode: 'standalone',
      encryptionKey: generateEncryptionKey(),
    })

    p.outro(
      chalk.green('Config generated with defaults.') +
        `\n\n  ${chalk.dim('Next steps:')}` +
        `\n  1. Copy ${chalk.cyan(ENV_EXAMPLE_FILE)} to ${chalk.cyan('.env')} and fill in your values` +
        `\n  2. Edit ${chalk.cyan(CONFIG_FILE)} to customise your setup` +
        `\n  3. Run ${chalk.cyan('watchdeck start')} to launch the server\n`,
    )
    return
  }

  // Step 1 — Port
  const port = requireValue(await p.text({
    message: 'Which port should WatchDeck run on?',
    placeholder: '4000',
    defaultValue: '4000',
    validate: (value) => {
      if (!value) return // empty = accept default
      const n = Number(value)
      if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port number (1-65535)'
    },
  }))

  // Step 2 — Database backend
  const backend = requireValue(await p.select({
    message: 'Which database backend?',
    options: [
      { value: 'mongodb', label: 'MongoDB', hint: 'Default. Local or Atlas.' },
      { value: 'postgres', label: 'Postgres', hint: 'Local, managed, or Supabase.' },
    ],
    initialValue: 'mongodb',
  })) as 'mongodb' | 'postgres'

  const uriPlaceholder = backend === 'mongodb'
    ? 'mongodb://localhost:27017/watchdeck'
    : 'postgres://user:pass@localhost:5432/watchdeck'

  // Step 3 — Connection URI
  const dbUri = requireValue(await p.text({
    message: `${backend === 'mongodb' ? 'MongoDB' : 'Postgres'} connection URI`,
    placeholder: uriPlaceholder,
    defaultValue: uriPlaceholder,
    validate: (value) => {
      if (!value) return // empty = accept default
      if (backend === 'mongodb') {
        if (!value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')) {
          return 'URI must start with mongodb:// or mongodb+srv://'
        }
      } else {
        if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
          return 'URI must start with postgres:// or postgresql://'
        }
      }
    },
  }))

  // Step 4 — Database name (replaces whatever's at the tail of the URI path)
  const dbName = requireValue(await p.text({
    message: 'Database name',
    placeholder: 'watchdeck',
    defaultValue: 'watchdeck',
    validate: (value) => {
      if (!value) return // empty = accept default
      if (!value.trim()) return 'Database name cannot be empty'
    },
  }))

  // Step 5 — Collection/table prefix
  const dbPrefix = requireValue(await p.text({
    message: backend === 'postgres' ? 'Table prefix' : 'Collection prefix',
    placeholder: 'mx_',
    defaultValue: 'mx_',
    validate: (value) => {
      if (!value) return // empty = accept default
      if (!/^[a-z][a-z0-9_]*_$/.test(value)) {
        return 'Prefix must be lowercase letters/numbers, ending with underscore (e.g. mx_)'
      }
    },
  }))

  // Step 6 — Dashboard mode
  const dashboardMode = requireValue(await p.select({
    message: 'Dashboard mode',
    options: [
      { value: 'standalone', label: 'Standalone', hint: 'WatchDeck serves the dashboard itself' },
      { value: 'mounted', label: 'Mounted', hint: 'Import the React component into your own app' },
    ],
  }))

  // Notification channels are configured in the dashboard — no wizard prompt
  // needed. Each channel's credentials (webhook URL, SMTP URL, recipients)
  // live on the channel doc, not in config.

  writeFiles({
    port,
    dbUri,
    dbName,
    dbPrefix,
    dashboardMode,
    encryptionKey: generateEncryptionKey(),
  })

  p.outro(
    chalk.green('Setup complete!') +
      `\n\n  ${chalk.dim('Next steps:')}` +
      `\n  1. Copy ${chalk.cyan(ENV_EXAMPLE_FILE)} to ${chalk.cyan('.env')} and fill in your values` +
      `\n  2. Run ${chalk.cyan('watchdeck start')} to launch the server` +
      `\n  3. Open the dashboard and add notification channels under Notifications → Add Channel\n`,
  )
}

interface TemplateVars {
  port: string
  dbUri: string
  dbName: string
  dbPrefix: string
  dashboardMode: string
  encryptionKey: string
}

function writeFiles(vars: TemplateVars): void {
  const configTemplate = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'watchdeck.config.template.js'),
    'utf8',
  )
  const envTemplate = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'env.template.txt'),
    'utf8',
  )

  // The URI may carry a query string (common for Supabase: `?sslmode=require`).
  // Split it off, rewrite only the path tail, then stitch the query back on.
  const [uriBase, uriQuery] = vars.dbUri.split('?', 2)
  const rewrittenBase = (uriBase ?? vars.dbUri).replace(/\/[^/]*$/, `/${vars.dbName}`)
  const dbUriWithName = uriQuery ? `${rewrittenBase}?${uriQuery}` : rewrittenBase

  const configContent = renderTemplate(configTemplate, {
    PORT: vars.port,
    DASHBOARD_MODE: vars.dashboardMode,
  })

  const envContent = renderTemplate(envTemplate, {
    DB_URI: dbUriWithName,
    DB_PREFIX: vars.dbPrefix,
    ENCRYPTION_KEY: vars.encryptionKey,
  })

  fs.writeFileSync(path.resolve(process.cwd(), CONFIG_FILE), configContent, 'utf8')
  fs.writeFileSync(path.resolve(process.cwd(), ENV_EXAMPLE_FILE), envContent, 'utf8')
}
