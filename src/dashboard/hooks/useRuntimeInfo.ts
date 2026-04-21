import { useEffect, useState } from 'react'
import { useApi } from './useApi'

export interface RuntimeInfo {
  probeName: string
}

const DEFAULT_RUNTIME: RuntimeInfo = {
  probeName: 'local',
}

/**
 * Fetches constant-for-process-lifetime runtime values from GET /runtime.
 *
 * Static for the lifetime of the server process (changing requires editing
 * watchdeck.config.js and restarting), so one fetch per page mount is enough.
 * Falls back to the built-in default while loading and on error.
 */
export function useRuntimeInfo(): { runtime: RuntimeInfo; loaded: boolean } {
  const { request } = useApi()
  const [runtime, setRuntime] = useState<RuntimeInfo>(DEFAULT_RUNTIME)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await request<{ data: Partial<RuntimeInfo> }>('/runtime')
        if (cancelled) return
        if (res.status < 400 && res.data?.data) {
          setRuntime({ ...DEFAULT_RUNTIME, ...res.data.data })
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [request])

  return { runtime, loaded }
}
