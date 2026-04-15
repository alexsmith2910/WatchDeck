import { createContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react'

const API_BASE = '/api/mx'

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
  const esRef = useRef<EventSource | null>(null)

  const subscribe = useCallback((event: string, handler: SSEHandler): (() => void) => {
    const map = listenersRef.current
    if (!map.has(event)) map.set(event, new Set())
    map.get(event)!.add(handler)

    // If we already have an EventSource, add the listener to it
    if (esRef.current) {
      esRef.current.addEventListener(event, ((e: MessageEvent) => {
        try { handler(JSON.parse(e.data)) } catch { /* skip */ }
      }) as EventListener)
    }

    return () => {
      map.get(event)?.delete(handler)
      if (map.get(event)?.size === 0) map.delete(event)
    }
  }, [])

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false

    function connect() {
      if (disposed) return

      const es = new EventSource(`${API_BASE}/stream`)
      esRef.current = es

      es.onopen = () => setStatus('connected')
      es.onerror = () => {
        setStatus('disconnected')
        es.close()
        esRef.current = null
        // Reconnect after 60s (2x default 30s heartbeat)
        reconnectTimer = setTimeout(connect, 60_000)
      }

      // Wire up all currently registered event types
      for (const [event, handlers] of listenersRef.current) {
        es.addEventListener(event, ((e: MessageEvent) => {
          let data: unknown
          try { data = JSON.parse(e.data) } catch { return }
          for (const handler of handlers) {
            try { handler(data) } catch { /* skip */ }
          }
        }) as EventListener)
      }
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  return (
    <SSEContext.Provider value={{ status, subscribe }}>
      {children}
    </SSEContext.Provider>
  )
}
