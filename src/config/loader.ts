import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaults } from './defaults.js'
import type { UserConfig, WatchDeckConfig } from './types.js'

// ---------------------------------------------------------------------------
// Deep merge — objects are merged recursively, arrays are replaced entirely.
// ---------------------------------------------------------------------------

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const key of Object.keys(override)) {
    const baseVal = base[key]
    const overrideVal = override[key]

    if (overrideVal === undefined) continue

    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      )
    } else {
      result[key] = overrideVal
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// User config loader — dynamic import() so watchdeck.config.js is plain JS.
// ---------------------------------------------------------------------------

/**
 * Load the user's watchdeck.config.js and return the exported object.
 * Returns an empty object if the file does not exist — defaults take over.
 *
 * @param configPath Absolute or cwd-relative path to the config file.
 *                   Defaults to watchdeck.config.js in the current directory.
 */
export interface LoadUserConfigResult {
  config: UserConfig
  found: boolean
  resolvedPath: string
}

export async function loadUserConfig(configPath?: string): Promise<LoadUserConfigResult> {
  const resolvedPath = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(process.cwd(), 'watchdeck.config.js')

  if (!existsSync(resolvedPath)) {
    return { config: {}, found: false, resolvedPath }
  }

  // Use pathToFileURL so dynamic import works on Windows paths.
  const fileUrl = pathToFileURL(resolvedPath).href
  const mod = (await import(fileUrl)) as { default?: UserConfig } | UserConfig

  // Support both `export default {}` and `module.exports = {}`
  const userConfig =
    'default' in mod && mod.default !== undefined ? mod.default : mod

  if (typeof userConfig !== 'object' || userConfig === null) {
    return { config: {}, found: true, resolvedPath }
  }

  return { config: userConfig as UserConfig, found: true, resolvedPath }
}

// ---------------------------------------------------------------------------
// Public: load + deep-merge
// ---------------------------------------------------------------------------

export interface LoadConfigResult {
  config: WatchDeckConfig
  /** True if a config file was found and loaded; false means defaults only. */
  configFound: boolean
  /** Resolved path that was checked (useful for the "not found" warning). */
  configPath: string
}

/**
 * Load the user config file, deep-merge it on top of defaults, and return
 * the merged result.  The returned object is NOT yet validated or frozen —
 * call initConfig() from src/config/index.ts for the full pipeline.
 *
 * @param configPath Optional path to a custom config file (from --config flag).
 */
export async function loadConfig(configPath?: string): Promise<LoadConfigResult> {
  const { config: userConfig, found, resolvedPath } = await loadUserConfig(configPath)

  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    userConfig as Record<string, unknown>,
  )

  return {
    config: merged as unknown as WatchDeckConfig,
    configFound: found,
    configPath: resolvedPath,
  }
}
