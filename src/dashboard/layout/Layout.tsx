import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Layout() {
  const [isCompact, setIsCompact] = useState(false)

  // Reset the scroll container to the top on every route change. We scroll
  // the <main> element (not window) because that's where overflow-y-auto
  // actually lives — the body itself is locked at h-screen. Keyed on
  // pathname only, not search/hash, so in-page tab switches (which update
  // ?tab=...) and pagination cursors don't yank the user back to the top.
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 })
  }, [pathname])

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isCompact={isCompact} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar isCompact={isCompact} onToggleSidebar={() => setIsCompact(!isCompact)} />
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
