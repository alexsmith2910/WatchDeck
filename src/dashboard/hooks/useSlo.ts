import { useEffect, useState } from 'react'
import { useApi } from './useApi'

export interface SloConfig {
  target: number
  windowDays: number
}

const DEFAULT_SLO: SloConfig = {
  target: 99.9,
  windowDays: 30,
}

/**
 * Fetches the global SLO config from GET /slo.
 *
 * Static for the lifetime of the server process (changing it requires editing
 * watchdeck.config.js and restarting), so one fetch per page mount is enough.
 * Falls back to the built-in default while loading and on error.
 */
export function useSlo(): { slo: SloConfig; loaded: boolean } {
  const { request } = useApi()
  const [slo, setSlo] = useState<SloConfig>(DEFAULT_SLO)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await request<{ data: Partial<SloConfig> }>('/slo')
        if (cancelled) return
        if (res.status < 400 && res.data?.data) {
          setSlo({ ...DEFAULT_SLO, ...res.data.data })
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [request])

  return { slo, loaded }
}
