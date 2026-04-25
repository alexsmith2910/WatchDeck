import { useCallback, useEffect, useRef } from 'react'
import { getApiBase, getAuthHeaders } from '../lib/apiBase'

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
    // Auth headers are resolved per request so token refresh works without
    // re-mounting the SPA. Caller-supplied headers win on collision.
    const auth = getAuthHeaders()
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', ...auth, ...extraHeaders }
      init.body = JSON.stringify(body)
    } else {
      init.headers = { ...auth, ...extraHeaders }
    }

    try {
      const res = await fetch(`${getApiBase()}${path}`, init)
      let data: T
      try {
        data = await res.json()
      } catch {
        data = null as T
      }
      return { status: res.status, data }
    } catch (err) {
      // The unmount cleanup aborts every in-flight controller; that rejects
      // fetch with AbortError. The caller is either already gone or asked for
      // this cancel via `externalSignal`, so there's nothing useful to do with
      // the result. Return a never-resolving promise so `.then` handlers that
      // would otherwise setState on a dead tree simply never run, and so the
      // rejection doesn't surface as an unhandled promise error.
      if (err instanceof Error && err.name === 'AbortError') {
        return new Promise(() => {})
      }
      throw err
    } finally {
      inflight.current.delete(controller)
    }
  }, [])

  return { request }
}
