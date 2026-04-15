import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Layout() {
  const [isCompact, setIsCompact] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isCompact={isCompact} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar isCompact={isCompact} onToggleSidebar={() => setIsCompact(!isCompact)} />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
