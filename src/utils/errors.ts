import chalk from 'chalk'

// ---------------------------------------------------------------------------
// Shared error shapes
// ---------------------------------------------------------------------------

/** One entry in a validation error list. */
export interface ValidationError {
  field: string
  value: unknown
  expected: string
  fix: string
}

/** JSON body returned for all API errors. */
export interface ApiError {
  error: true
  code: string
  message: string
  errors?: ValidationError[]
}

// ---------------------------------------------------------------------------
// API error builder
// ---------------------------------------------------------------------------

/**
 * Build the standard WatchDeck API error object.
 *
 * @param code    Machine-readable error code, e.g. "VALIDATION_ERROR"
 * @param message Human-readable summary
 * @param errors  Optional per-field validation errors
 */
export function formatError(
  code: string,
  message: string,
  errors?: ValidationError[],
): ApiError {
  const body: ApiError = { error: true, code, message }
  if (errors && errors.length > 0) body.errors = errors
  return body
}

// ---------------------------------------------------------------------------
// Terminal validation report (used at startup when config is invalid)
// ---------------------------------------------------------------------------

/**
 * Render a human-readable config validation failure report for the terminal.
 *
 * @param errors List of collected validation errors
 * @param title  Optional override for the header line
 */
export function formatValidationReport(
  errors: ValidationError[],
  title?: string,
): string {
  const header =
    title ??
    `WatchDeck config validation failed — ${errors.length} error${errors.length === 1 ? '' : 's'}`

  const lines: string[] = [chalk.red.bold(header), '']

  for (const err of errors) {
    lines.push(`  ${chalk.red('✗')}  ${chalk.bold(err.field)}`)
    lines.push(`     ${chalk.dim('Value:')}    ${JSON.stringify(err.value)}`)
    lines.push(`     ${chalk.dim('Expected:')} ${err.expected}`)
    lines.push(`     ${chalk.dim('Fix:')}      ${err.fix}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Terminal warning (used for non-fatal issues at startup)
// ---------------------------------------------------------------------------

/**
 * Format a non-fatal warning for terminal output.
 *
 * @param module  The module or config section emitting the warning
 * @param message Warning message
 */
export function formatWarning(module: string, message: string): string {
  return `${chalk.yellow('⚠')}  ${chalk.bold(`[${module}]`)} ${message}`
}
