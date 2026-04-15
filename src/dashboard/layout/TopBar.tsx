import { Button, Tooltip, TooltipTrigger, TooltipContent } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useTheme } from '../hooks/useTheme'
import StatusPill from '../components/StatusPill'

interface TopBarProps {
  isCompact: boolean
  onToggleSidebar: () => void
}

export default function TopBar({ isCompact, onToggleSidebar }: TopBarProps) {
  const { isDark, toggleTheme } = useTheme()

  return (
    <header className="h-14 border-b border-wd-border bg-surface flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" onPress={onToggleSidebar}>
              <Icon
                className="text-wd-muted"
                icon="solar:sidebar-minimalistic-outline"
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isCompact ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Global status pill */}
      <StatusPill
        healthyCount={7}
        totalCount={8}
        uptimePercent={99.4}
        uptimeChange={-0.3}
        avgLatencyMs={142}
        latencyChange={-12}
        incidentCount={1}
        activeIncident={{ name: 'API Server', detail: 'Down for 4m 23s — Status 503', duration: '4m' }}
        lastUpdated="Updated 2s ago"
      />

      <div className="flex items-center gap-1">
        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost">
              <Icon
                className="text-wd-muted"
                icon="solar:magnifer-outline"
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            Search endpoints
            <kbd className="ml-1.5 rounded border border-wd-border/50 bg-wd-surface-hover/50 px-1 py-0.5 text-[10px] text-wd-muted/60">⌘K</kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip delay={300} closeDelay={0}>
          <TooltipTrigger>
            <Button isIconOnly size="sm" variant="ghost" onPress={toggleTheme}>
              <Icon
                className="text-wd-muted"
                icon={isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'}
                width={18}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent placement="bottom" className="px-2.5 py-1 text-xs font-medium">
            {isDark ? 'Light mode' : 'Dark mode'}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
