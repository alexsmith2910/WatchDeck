import chalk from 'chalk'

interface StatusOptions {
  json: boolean
}

export async function runStatus(options: StatusOptions): Promise<void> {
  // TODO: Step 8 — query the running server's /health endpoint and display results
  const placeholder = {
    status: 'unknown',
    message: 'Status command not yet implemented.',
  }

  if (options.json) {
    console.log(JSON.stringify(placeholder, null, 2))
  } else {
    console.log(chalk.yellow('Status command not yet implemented.'))
  }
}
