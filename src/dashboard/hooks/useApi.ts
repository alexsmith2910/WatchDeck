import { useCallback, useEffect, useRef } from 'react'

const API_BASE = '/api/mx'

interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
}

/**
 * Fetch wrapper for the WatchDeck API.
 * Returns a `request` function that prepends the base path, sets JSON headers,
 * and parses the response. Any requests still in flight when the calling
 * component unmounts are aborted so we don't setState on a dead tree.
 */
export function useApi() {
  const inflight = useRef<Set<AbortController>>(new Set())

  useEffect(() => {
    const bag = inflight.current
    return () => {
      for (const c of bag) c.abort()
      bag.clear()
    }
  }, [])

  const request = useCallback(async <T = unknown>(
    path: string,
    options: ApiOptions = {},
  ): Promise<{ status: number; data: T }> => {
    const { body, headers: extraHeaders, signal: externalSignal, ...rest } = options

    const controller = new AbortController()
    inflight.current.add(controller)

    // If the caller supplied their own signal, honour it too — aborting either
    // side cancels the request.
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const init: RequestInit = { ...rest, signal: controller.signal }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', ...extraHeaders }
      init.body = JSON.stringify(body)
    } else if (extraHeaders) {
      init.headers = extraHeaders
    }

    try {
      const res = await fetch(`${API_BASE}${path}`, init)
      let data: T
      try {
        data = await res.json()
      } catch {
        data = null as T
      }
      return { status: res.status, data }
    } finally {
      inflight.current.delete(controller)
    }
  }, [])

  return { request }
}
