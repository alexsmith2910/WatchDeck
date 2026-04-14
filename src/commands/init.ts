import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import chalk from 'chalk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CONFIG_FILE = 'watchdeck.config.js'
const ENV_FILE = '.env'

interface InitOptions {
  force: boolean
  defaults: boolean
}

function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex').slice(0, 32)
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

function checkExistingFiles(): { config: boolean; env: boolean } {
  return {
    config: fs.existsSync(path.resolve(process.cwd(), CONFIG_FILE)),
    env: fs.existsSync(path.resolve(process.cwd(), ENV_FILE)),
  }
}

export async function runInit(options: InitOptions): Promise<void> {
  console.log('')
  p.intro(chalk.bold('WatchDeck Setup Wizard'))

  const existing = checkExistingFiles()
  const hasExisting = existing.config || existing.env

  // Overwrite check
  if (hasExisting && !options.force) {
    const files = [existing.config && CONFIG_FILE, existing.env && ENV_FILE]
      .filter(Boolean)
      .join(' and ')

    const overwrite = await p.confirm({
      message: `${chalk.yellow(files)} already exist. Overwrite?`,
      initialValue: false,
    })

    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel('Setup cancelled. Use --force to skip this prompt.')
      process.exit(0)
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
      discord: 'false',
      slack: 'false',
      encryptionKey: generateEncryptionKey(),
    })

    p.outro(chalk.green('Config generated with defaults. Edit watchdeck.config.js to customise.'))
    return
  }

  // Step 1 — Port
  const port = await p.text({
    message: 'Which port should WatchDeck run on?',
    placeholder: '4000',
    defaultValue: '4000',
    validate: (value) => {
      if (!value) return // empty = accept default
      const n = Number(value)
      if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port number (1-65535)'
    },
  })
  if (p.isCancel(port)) { p.cancel('Setup cancelled.'); process.exit(0) }

  // Step 2 — MongoDB location
  const dbUri = await p.text({
    message: 'MongoDB connection URI',
    placeholder: 'mongodb://localhost:27017/watchdeck',
    defaultValue: 'mongodb://localhost:27017/watchdeck',
    validate: (value) => {
      if (!value) return // empty = accept default
      if (!value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')) {
        return 'URI must start with mongodb:// or mongodb+srv://'
      }
    },
  })
  if (p.isCancel(dbUri)) { p.cancel('Setup cancelled.'); process.exit(0) }

  // Step 3 — DB name
  const dbName = await p.text({
    message: 'Database name',
    placeholder: 'watchdeck',
    defaultValue: 'watchdeck',
    validate: (value) => {
      if (!value) return // empty = accept default
      if (!value.trim()) return 'Database name cannot be empty'
    },
  })
  if (p.isCancel(dbName)) { p.cancel('Setup cancelled.'); process.exit(0) }

  // Step 4 — Collection prefix
  const dbPrefix = await p.text({
    message: 'Collection prefix',
    placeholder: 'mx_',
    defaultValue: 'mx_',
    validate: (value) => {
      if (!value) return // empty = accept default
      if (!/^[a-z][a-z0-9_]*_$/.test(value)) {
        return 'Prefix must be lowercase letters/numbers, ending with underscore (e.g. mx_)'
      }
    },
  })
  if (p.isCancel(dbPrefix)) { p.cancel('Setup cancelled.'); process.exit(0) }

  // Step 5 — Dashboard mode
  const dashboardMode = await p.select({
    message: 'Dashboard mode',
    options: [
      { value: 'standalone', label: 'Standalone', hint: 'WatchDeck serves the dashboard itself' },
      { value: 'mounted', label: 'Mounted', hint: 'Import the React component into your own app' },
    ],
  })
  if (p.isCancel(dashboardMode)) { p.cancel('Setup cancelled.'); process.exit(0) }

  // Step 6 — Notification channels
  const channels = await p.multiselect({
    message: 'Which notification channels do you want to enable?',
    options: [
      { value: 'discord', label: 'Discord' },
      { value: 'slack', label: 'Slack' },
    ],
    required: false,
  })
  if (p.isCancel(channels)) { p.cancel('Setup cancelled.'); process.exit(0) }

  writeFiles({
    port: port as string,
    dbUri: dbUri as string,
    dbName: dbName as string,
    dbPrefix: dbPrefix as string,
    dashboardMode: dashboardMode as string,
    discord: (channels as string[]).includes('discord') ? 'true' : 'false',
    slack: (channels as string[]).includes('slack') ? 'true' : 'false',
    encryptionKey: generateEncryptionKey(),
  })

  p.outro(
    chalk.green('Setup complete!') +
      `\n\n  Run ${chalk.cyan('watchdeck start')} to launch the server.\n`,
  )
}

interface TemplateVars {
  port: string
  dbUri: string
  dbName: string
  dbPrefix: string
  dashboardMode: string
  discord: string
  slack: string
  encryptionKey: string
}

function writeFiles(vars: TemplateVars): void {
  const templatesDir = path.resolve(__dirname, '../templates')

  const configTemplate = fs.readFileSync(
    path.join(templatesDir, 'watchdeck.config.template.js'),
    'utf8',
  )
  const envTemplate = fs.readFileSync(path.join(templatesDir, 'env.template.txt'), 'utf8')

  const dbUriWithName = vars.dbUri.replace(/\/[^/]*$/, `/${vars.dbName}`)

  const configContent = renderTemplate(configTemplate, {
    PORT: vars.port,
    DASHBOARD_MODE: vars.dashboardMode,
    DISCORD: vars.discord,
    SLACK: vars.slack,
  })

  const envContent = renderTemplate(envTemplate, {
    DB_URI: dbUriWithName,
    DB_PREFIX: vars.dbPrefix,
    ENCRYPTION_KEY: vars.encryptionKey,
  })

  fs.writeFileSync(path.resolve(process.cwd(), CONFIG_FILE), configContent, 'utf8')
  fs.writeFileSync(path.resolve(process.cwd(), ENV_FILE), envContent, 'utf8')
}
