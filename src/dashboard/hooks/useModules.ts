import { useEffect, useState } from 'react'
import { useApi } from './useApi'

export interface ModulesState {
  sslChecks: boolean
  portChecks: boolean
}

const DEFAULT_MODULES: ModulesState = {
  sslChecks: true,
  portChecks: true,
}

/**
 * Fetches the module-toggle state from GET /modules.
 *
 * Module toggles are static for the lifetime of the server process (changing
 * one requires editing watchdeck.config.js and restarting), so one fetch per
 * page mount is enough — no SSE refresh needed.
 *
 * Falls back to "everything enabled" while loading and on error, which errs
 * on the side of letting the user try the action and letting the backend
 * return a proper MODULE_DISABLED error.
 */
export function useModules(): { modules: ModulesState; loaded: boolean } {
  const { request } = useApi()
  const [modules, setModules] = useState<ModulesState>(DEFAULT_MODULES)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await request<{ data: Partial<ModulesState> }>('/modules')
        if (cancelled) return
        if (res.status < 400 && res.data?.data) {
          setModules({ ...DEFAULT_MODULES, ...res.data.data })
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [request])

  return { modules, loaded }
}
