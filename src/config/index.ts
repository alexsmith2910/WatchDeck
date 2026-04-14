import { loadEnv } from './envLoader.js'
import { loadConfig } from './loader.js'
import { validateAndFreeze } from './validator.js'
import type { WatchDeckConfig } from './types.js'

export type { WatchDeckConfig } from './types.js'
export type { UserConfig } from './types.js'
export type { LoadedEnv } from './envLoader.js'

export interface InitConfigResult {
  config: WatchDeckConfig
  /** Non-fatal warnings to display at startup (module tokens, etc.). */
  warnings: string[]
  /** Whether a config file was found at the resolved path. */
  configFound: boolean
  /** The resolved path that was checked for a config file. */
  configPath: string
}

/**
 * Full config boot pipeline:
 *   1. Load .env → validate required env vars
 *   2. Load watchdeck.config.js → deep-merge with defaults
 *   3. Validate all config fields + cross-validate module tokens against env
 *   4. Deep-freeze the config
 *
 * Returns warnings for the caller to display rather than printing them directly.
 * Throws with a human-readable formatted report if anything is invalid.
 * Call this once at startup before any other module is initialised.
 *
 * @param configPath Optional path to a custom config file (from --config flag).
 */
export async function initConfig(configPath?: string): Promise<InitConfigResult> {
  const env = loadEnv()
  const { config, configFound, configPath: resolvedPath } = await loadConfig(configPath)
  const { config: frozen, warnings } = validateAndFreeze(config, env)
  return { config: frozen, warnings, configFound, configPath: resolvedPath }
}
