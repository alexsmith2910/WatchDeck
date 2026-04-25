/**
 * Example Next.js (App Router) page mounting the WatchDeck dashboard.
 *
 * Drop this in at app/admin/watchdeck/page.tsx (or wherever you want it
 * served from) and import the styles once at a layout above it:
 *
 *   // app/admin/layout.tsx
 *   import "watchdeck/dashboard/styles.css";
 *
 * Update `apiUrl` and `basePath` to match your deployment, and supply
 * `authHeaders` if your API requires a bearer token. The function is
 * re-invoked per request so token refresh works without re-mounting.
 */
'use client'

import { WatchDeckDashboard } from 'watchdeck/dashboard'

export default function WatchDeckPage() {
  return (
    <WatchDeckDashboard
      apiUrl={process.env.NEXT_PUBLIC_WATCHDECK_API_URL ?? '/api/mx'}
      basePath="/admin/watchdeck"
      authHeaders={() => ({
        // Authorization: `Bearer ${getYourToken()}`,
      })}
    />
  )
}
