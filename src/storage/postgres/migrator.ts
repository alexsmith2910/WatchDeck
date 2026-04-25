import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PoolClient } from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE_PATTERN = /^(\d{3})_.+\.sql$/

/**
 * Resolve the migrations directory. Two locations are tried in order:
 *   1. `./migrations/` alongside this module — the dev layout when running
 *      the adapter via `tsx` from the `src/` tree.
 *   2. `../storage/postgres/migrations/` — the layout after `tsup` bundles
 *      the CLI into `dist/bin/cli.js` and the build script copies the SQL
 *      files to `dist/storage/postgres/migrations/`.
 *
 * Using the first existing directory keeps the runtime path-independent of
 * how the caller is packaged.
 */
async function resolveMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, 'migrations'),
    path.resolve(__dirname, '../storage/postgres/migrations'),
  ]
  for (const dir of candidates) {
    try {
      const st = await stat(dir)
      if (st.isDirectory()) return dir
    } catch {
      // not present, try next
    }
  }
  throw new Error(
    `Postgres migrations directory not found. Checked: ${candidates.join(', ')}`,
  )
}

function applyPrefix(sql: string, prefix: string): string {
  if (prefix === 'mx_') return sql
  return sql.replace(/mx_/g, prefix)
}

/**
 * Read migration files from disk. Exposed for test-inspection; start.ts only
 * calls ensureSchema().
 */
async function loadMigrations(): Promise<Array<{ version: number; name: string; sql: string }>> {
  const dir = await resolveMigrationsDir()
  const entries = await readdir(dir)
  const files = entries
    .map((e) => {
      const m = FILE_PATTERN.exec(e)
      return m ? { file: e, version: Number(m[1]) } : null
    })
    .filter((v): v is { file: string; version: number } => v !== null)
    .sort((a, b) => a.version - b.version)

  const out: Array<{ version: number; name: string; sql: string }> = []
  for (const { file, version } of files) {
    const raw = await readFile(path.join(dir, file), 'utf8')
    // Strip BOM in case the file was saved on Windows with one.
    const sql = raw.replace(/^﻿/, '')
    out.push({ version, name: file, sql })
  }
  return out
}

/**
 * Idempotent schema migrator.
 *
 * On every call:
 *  1. Ensure `${prefix}schema_version` exists.
 *  2. Read the highest already-applied version.
 *  3. For every migration file with a higher version, run it inside a
 *     single transaction along with the `INSERT INTO schema_version` row.
 *
 * Returns the number of distinct tables the schema defines (used by the
 * `adapter.migrate()` contract shared with the Mongo adapter).
 */
export async function ensureSchema(
  client: PoolClient,
  prefix: string,
): Promise<{ collectionCount: number }> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${prefix}schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )

  const { rows } = await client.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM ${prefix}schema_version`,
  )
  const currentVersion = rows[0]?.max ?? 0

  const migrations = await loadMigrations()
  const pending = migrations.filter((m) => m.version > currentVersion)

  for (const m of pending) {
    await client.query('BEGIN')
    try {
      await client.query(applyPrefix(m.sql, prefix))
      await client.query(
        `INSERT INTO ${prefix}schema_version (version) VALUES ($1)`,
        [m.version],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(
        `Migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Collection count mirrors the Mongo adapter's `{ collectionCount }` —
  // matches the number of base tables the combined migrations have created,
  // so the startup log prints a comparable number across backends.
  return { collectionCount: 13 }
}
