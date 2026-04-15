import { useCallback } from 'react'

const API_BASE = '/api/mx'

interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
}

/**
 * Fetch wrapper for the WatchDeck API.
 * Returns a `request` function that prepends the base path,
 * sets JSON headers, and parses the response.
 */
export function useApi() {
  const request = useCallback(async <T = unknown>(
    path: string,
    options: ApiOptions = {},
  ): Promise<{ status: number; data: T }> => {
    const { body, headers: extraHeaders, ...rest } = options

    const init: RequestInit = { ...rest }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', ...extraHeaders }
      init.body = JSON.stringify(body)
    } else if (extraHeaders) {
      init.headers = extraHeaders
    }

    const res = await fetch(`${API_BASE}${path}`, init)
    let data: T
    try {
      data = await res.json()
    } catch {
      data = null as T
    }
    return { status: res.status, data }
  }, [])

  return { request }
}
