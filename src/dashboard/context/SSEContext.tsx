import { createContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { getApiBase } from '../lib/apiBase'

type SSEStatus = 'connecting' | 'connected' | 'disconnected'
type SSEHandler = (data: unknown) => void

export interface SSEContextValue {
  /** Current connection status. */
  status: SSEStatus
  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  subscribe: (event: string, handler: SSEHandler) => () => void
}

export const SSEContext = createContext<SSEContextValue | null>(null)

/**
 * SSE provider — maintains a single EventSource connection to the server.
 * Reconnects automatically on disconnect (at 2x heartbeat interval).
 * Dispatches events to subscribers registered via subscribe().
 */
export function SSEProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SSEStatus>('connecting')
  const listenersRef = useRef(new Map<string, Set<SSEHandler>>())
  // Event types that have an active dispatcher attached to the current ES.
  const dispatchedRef = useRef(new Set<string>())
  const esRef = useRef<EventSource | null>(null)

  // Install a single dispatcher for `event` on the given EventSource. The
  // dispatcher reads the current handler Set at fire time, so we never need
  // to re-register when handlers come and go — this avoids stacking duplicate
  // listeners across mount/unmount cycles.
  const attachDispatcher = useCallback((es: EventSource, event: string) => {
    if (dispatchedRef.current.has(event)) return
    dispatchedRef.current.add(event)
    es.addEventListener(event, ((e: MessageEvent) => {
      let data: unknown
      try { data = JSON.parse(e.data) } catch { return }
      const handlers = listenersRef.current.get(event)
      if (!handlers) return
      for (const h of handlers) {
        try { h(data) } catch { /* skip */ }
      }
    }) as EventListener)
  }, [])

  const subscribe = useCallback((event: string, handler: SSEHandler): (() => void) => {
    const map = listenersRef.current
    let set = map.get(event)
    if (!set) {
      set = new Set()
      map.set(event, set)
    }
    set.add(handler)

    if (esRef.current) attachDispatcher(esRef.current, event)

    return () => {
      // Keep the Set in the map even when empty — the ES dispatcher reads it
      // lazily. Recreating the Set on re-subscribe would force us to
      // re-register the dispatcher, which is what caused the duplicate-listener
      // leak in the previous implementation.
      map.get(event)?.delete(handler)
    }
  }, [attachDispatcher])

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false

    function connect() {
      if (disposed) return

      const es = new EventSource(`${getApiBase()}/stream`)
      esRef.current = es
      // New EventSource means no dispatchers are attached yet.
      dispatchedRef.current = new Set()

      es.onopen = () => setStatus('connected')
      es.onerror = () => {
        setStatus('disconnected')
        es.close()
        esRef.current = null
        dispatchedRef.current = new Set()
        // Reconnect after 60s (2x default 30s heartbeat)
        reconnectTimer = setTimeout(connect, 60_000)
      }

      // Wire up dispatchers for all currently known event types.
      for (const event of listenersRef.current.keys()) {
        attachDispatcher(es, event)
      }
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      esRef.current?.close()
      esRef.current = null
      dispatchedRef.current = new Set()
    }
  }, [attachDispatcher])

  return (
    <SSEContext.Provider value={{ status, subscribe }}>
      {children}
    </SSEContext.Provider>
  )
}
