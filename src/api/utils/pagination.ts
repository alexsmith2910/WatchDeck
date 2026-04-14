/**
 * API pagination utilities.
 *
 * Parses query string params and wraps DbPage results into the standard
 * WatchDeck pagination envelope.
 */

import type { DbPage, DbPaginationOpts } from '../../storage/types.js'

export interface PaginationQuery {
  cursor?: string
  limit?: string
}

/** Parse cursor/limit from raw query params, applying defaults and caps. */
export function parsePagination(query: PaginationQuery): DbPaginationOpts {
  const limit = query.limit !== undefined ? Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100) : 20
  return { cursor: query.cursor, limit }
}

export interface PaginationEnvelope<T> {
  data: T[]
  pagination: {
    limit: number
    hasMore: boolean
    nextCursor: string | null
    prevCursor: string | null
    total: number
  }
}

/** Wrap a DbPage into the response envelope the API returns. */
export function toEnvelope<T>(page: DbPage<T>, limit: number): PaginationEnvelope<T> {
  return {
    data: page.items,
    pagination: {
      limit,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
      total: page.total,
    },
  }
}
