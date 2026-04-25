import { uuidv7 } from 'uuidv7'

/**
 * Generate a time-ordered UUID v7. The first 48 bits are a Unix millisecond
 * timestamp, so `ORDER BY id DESC` sorts newest-first without a separate
 * `created_at` index — matching `ORDER BY _id DESC` on the Mongo adapter.
 */
export const newId = (): string => uuidv7()

/**
 * RFC 4122 UUID format check. Accepts both v4 and v7 since callers cannot
 * assume a specific generation scheme — a given deployment might have rows
 * written by older tooling.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(id: string): boolean {
  return UUID_RE.test(id)
}
