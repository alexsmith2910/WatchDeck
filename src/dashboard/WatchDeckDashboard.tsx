/**
 * Mountable WatchDeck dashboard.
 *
 * Drop-in component for embedding the dashboard inside an existing React app
 * (Next.js, CRA, Remix, etc.). The host owns routing — pass `basePath` so
 * BrowserRouter can prefix internal links correctly.
 *
 * Usage (Next.js app router):
 *
 *   "use client";
 *   import { WatchDeckDashboard } from "watchdeck/dashboard";
 *
 *   export default function Page() {
 *     return (
 *       <WatchDeckDashboard
 *         apiUrl="https://watchdeck.example.com/api/mx"
 *         basePath="/admin/watchdeck"
 *         authHeaders={() => ({ Authorization: `Bearer ${getToken()}` })}
 *       />
 *     );
 *   }
 *
 * The CSS bundle (`watchdeck/dashboard/styles.css`) must be imported once at
 * the page or layout level.
 */
import { useState } from 'react'
import AppShell from './AppShell'
import { setApiBase, setAuthHeaders, setBasePath } from './lib/apiBase'

export interface WatchDeckDashboardProps {
  /**
   * Origin + path the API is reachable at, e.g. `https://mon.example.com/api/mx`
   * or `/api/mx` for same-origin proxying. Required.
   */
  apiUrl: string
  /**
   * URL prefix this component is mounted under. Passed to `BrowserRouter` so
   * navigation links resolve against the host's path. Default: root.
   *
   * Example: if the page lives at `/admin/watchdeck/*`, pass `/admin/watchdeck`.
   */
  basePath?: string
  /**
   * Returns headers added to every API request. Re-invoked per request so the
   * host can refresh tokens without re-mounting. SSE inherits any cookie auth
   * automatically (we connect with default credentials); custom headers on
   * EventSource are not supported by the browser, so token refresh schemes
   * that depend on Authorization will only authenticate the REST surface.
   */
  authHeaders?: () => Record<string, string>
}

export function WatchDeckDashboard({
  apiUrl,
  basePath = '',
  authHeaders,
}: WatchDeckDashboardProps) {
  // Seed the runtime locators on first render — synchronously, before children
  // mount. useState's initialiser runs once per component instance, which is
  // what we want here (re-running on prop change is handled below).
  useState(() => {
    setApiBase(apiUrl)
    setBasePath(basePath)
    setAuthHeaders(authHeaders ?? null)
    return null
  })

  // Keep cached values in sync if the host changes props after mount.
  // useLayoutEffect would be slightly more correct, but useState's initialiser
  // already ran the seed; this branch is only for live-editing scenarios.
  if (typeof window !== 'undefined') {
    setApiBase(apiUrl)
    setBasePath(basePath)
    setAuthHeaders(authHeaders ?? null)
  }

  return <AppShell basename={basePath === '/' ? '' : basePath} />
}

export default WatchDeckDashboard
