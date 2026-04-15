import { useEffect, useState, useCallback } from 'react'
import { ScrollShadow, Tooltip, TooltipTrigger, TooltipContent } from '@heroui/react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import { useApi } from '../hooks/useApi'
import { useSSE } from '../hooks/useSSE'

import SidebarNav, { type NavSection } from '../components/SidebarNav'

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  isCompact: boolean
}

export default function Sidebar({ isCompact }: SidebarProps) {
  const { request } = useApi()
  const { subscribe, status: sseStatus } = useSSE()

  // Badge counts from API
  const [endpointCount, setEndpointCount] = useState<number | null>(null)
  const [incidentCount, setIncidentCount] = useState<number | null>(null)

  // Health status derived from SSE connection
  const healthDot = sseStatus === 'connected' ? 'success' : sseStatus === 'connecting' ? 'warning' : 'danger'

  // Fetch counts on mount
  const fetchCounts = useCallback(async () => {
    try {
      const [endpointsRes, incidentsRes] = await Promise.all([
        request<{ pagination: { total: number } }>('/endpoints?limit=1'),
        request<{ pagination: { total: number } }>('/incidents?status=active&limit=1'),
      ])
      setEndpointCount(endpointsRes.data.pagination?.total ?? null)
      setIncidentCount(incidentsRes.data.pagination?.total ?? null)
    } catch {
      // Leave counts as null on failure
    }
  }, [request])

  useEffect(() => {
    fetchCounts()
  }, [fetchCounts])

  // SSE: update counts on endpoint/incident events
  useEffect(() => {
    return subscribe('endpoint:created', () => {
      setEndpointCount((prev) => (prev != null ? prev + 1 : 1))
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('endpoint:deleted', () => {
      setEndpointCount((prev) => (prev != null && prev > 0 ? prev - 1 : 0))
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:opened', () => {
      setIncidentCount((prev) => (prev != null ? prev + 1 : 1))
    })
  }, [subscribe])

  useEffect(() => {
    return subscribe('incident:resolved', () => {
      setIncidentCount((prev) => (prev != null && prev > 0 ? prev - 1 : 0))
    })
  }, [subscribe])

  // Build nav sections with live counts
  const mainSections: NavSection[] = [
    {
      key: 'overview',
      title: 'Overview',
      items: [
        { key: 'home', href: '/', icon: 'solar:home-2-linear', title: 'Overview' },
        {
          key: 'endpoints',
          href: '/endpoints',
          icon: 'solar:server-square-outline',
          title: 'Endpoints',
          ...(endpointCount != null && { badge: { count: endpointCount } }),
        },
        {
          key: 'incidents',
          href: '/incidents',
          icon: 'solar:danger-triangle-outline',
          title: 'Incidents',
          ...(incidentCount != null && incidentCount > 0 && { badge: { count: incidentCount } }),
        },
        {
          key: 'notifications',
          href: '/notifications',
          icon: 'solar:bell-outline',
          title: 'Notifications',
        },
      ],
    },
  ]

  const bottomSections: NavSection[] = [
    {
      key: 'system',
      title: 'System',
      items: [
        {
          key: 'health',
          href: '/health',
          icon: 'solar:heart-pulse-outline',
          title: 'System Health',
          badge: { dot: healthDot as 'success' | 'warning' | 'danger' },
        },
        { key: 'settings', href: '/settings', icon: 'solar:settings-outline', title: 'Settings' },
      ],
    },
    {
      key: 'resources',
      title: 'Resources',
      items: [
        { key: 'docs', icon: 'solar:document-text-outline', title: 'Docs' },
        { key: 'changelog', icon: 'solar:clipboard-list-outline', title: 'Changelog' },
      ],
    },
  ]

  return (
    <aside
      className={cn(
        'border-r border-wd-border relative flex h-full flex-col bg-surface transition-[width] duration-200 py-6 overflow-hidden',
        isCompact ? 'w-16 px-2' : 'w-64 px-6',
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex items-center shrink-0',
          isCompact ? 'justify-center' : 'px-2 gap-2.5',
        )}
      >
        <Tooltip delay={300} closeDelay={0} isDisabled={!isCompact}>
          <TooltipTrigger>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-wd-primary cursor-default shrink-0">
              <Icon
                icon="solar:shield-check-bold"
                className="text-wd-primary-foreground"
                width={22}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent placement="right" className="px-2.5 py-1 text-xs font-medium">
            WatchDeck
          </TooltipContent>
        </Tooltip>
        {!isCompact && (
          <span className="text-base font-semibold tracking-tight whitespace-nowrap">
            WatchDeck
          </span>
        )}
      </div>

      {/* Spacer */}
      <div className="h-6" />

      {/* Main nav */}
      <ScrollShadow className="flex-1 min-h-0 py-2">
        <SidebarNav sections={mainSections} isCompact={isCompact} />
      </ScrollShadow>

      {/* Bottom nav */}
      <div className="mt-auto pt-2">
        <SidebarNav sections={bottomSections} isCompact={isCompact} />
      </div>
    </aside>
  )
}
