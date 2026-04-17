/**
 * Sidebar navigation with plain button items.
 * Expanded: icon + label with section headers and optional badges.
 * Compact: icon-only with tooltips, no badges.
 */

import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Tooltip, TooltipTrigger, TooltipContent, Separator } from '@heroui/react'
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'

export interface NavBadge {
  count?: number
  /** Status dot color — shown instead of count */
  dot?: 'success' | 'warning' | 'danger'
}

export interface NavItem {
  key: string
  title: string
  icon: string
  href?: string
  badge?: NavBadge
}

export interface NavSection {
  key: string
  title: string
  items: NavItem[]
}

interface SidebarNavProps {
  sections: NavSection[]
  isCompact: boolean
}

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

function CountBadge({ count, color }: { count: number; color: string }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none',
        color,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function StatusDot({ status }: { status: 'success' | 'warning' | 'danger' }) {
  const color = {
    success: 'bg-wd-success',
    warning: 'bg-wd-warning',
    danger: 'bg-wd-danger',
  }[status]
  return (
    <span className="ml-auto relative flex items-center justify-center h-4 w-4">
      <span className={cn('absolute h-3 w-3 rounded-full animate-ping opacity-40', color)} />
      <span className={cn('relative h-2 w-2 rounded-full', color)} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Badge color mapping for expanded view
// ---------------------------------------------------------------------------

function getBadgeColor(item: NavItem): string {
  switch (item.key) {
    case 'incidents':
      return 'bg-wd-warning/15 text-wd-warning'
    case 'endpoints':
      return 'bg-wd-primary/15 text-wd-primary'
    case 'notifications':
      return 'bg-wd-primary/15 text-wd-primary'
    default:
      return 'bg-default/50 text-wd-muted'
  }
}

// ---------------------------------------------------------------------------
// NavButton
// ---------------------------------------------------------------------------

function NavButton({
  item,
  isActive,
  isCompact,
  onClick,
}: {
  item: NavItem
  isActive: boolean
  isCompact: boolean
  onClick: () => void
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center h-10 rounded-xl outline-none w-full',
        'transition-[colors,transform] duration-150',
        'cursor-pointer hover:bg-wd-surface-hover active:scale-[0.97]',
        'focus-visible:ring-2 focus-visible:ring-wd-primary',
        isActive && 'bg-wd-surface-hover',
        isCompact ? 'w-10 justify-center' : 'gap-3 px-3',
      )}
    >
      <Icon
        icon={item.icon}
        width={20}
        className={cn(
          'text-wd-muted shrink-0 transition-colors',
          isActive && 'text-foreground',
        )}
      />
      {!isCompact && (
        <>
          <span
            className={cn(
              'text-[13px] font-medium text-wd-muted transition-colors whitespace-nowrap',
              isActive && 'text-foreground',
            )}
          >
            {item.title}
          </span>
          {item.badge?.dot && <StatusDot status={item.badge.dot} />}
          {item.badge?.count != null && (
            <CountBadge count={item.badge.count} color={getBadgeColor(item)} />
          )}
        </>
      )}
    </button>
  )

  if (isCompact) {
    return (
      <Tooltip delay={300} closeDelay={0}>
        <TooltipTrigger className="!flex items-center justify-center">
          {button}
        </TooltipTrigger>
        <TooltipContent placement="right" className="px-2.5 py-1 text-xs font-medium">
          {item.title}
        </TooltipContent>
      </Tooltip>
    )
  }

  return button
}

// ---------------------------------------------------------------------------
// SidebarNav
// ---------------------------------------------------------------------------

export default function SidebarNav({ sections, isCompact }: SidebarNavProps) {
  const location = useLocation()
  const navigate = useNavigate()

  const activeKey = useMemo(() => {
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.href) continue
        if (item.href === '/') {
          if (location.pathname === '/') return item.key
        } else if (location.pathname.startsWith(item.href)) {
          return item.key
        }
      }
    }
    return ''
  }, [location.pathname, sections])

  return (
    <nav className="flex flex-col gap-6">
      {sections.map((section, sectionIdx) => (
        <div key={section.key}>
          {sectionIdx > 0 && isCompact && <Separator className="mb-4" />}
          {!isCompact && (
            <div className="px-3 mb-1.5 text-[11px] font-semibold text-wd-muted/60 uppercase tracking-widest">
              {section.title}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavButton
                key={item.key}
                item={item}
                isActive={activeKey === item.key}
                isCompact={isCompact}
                onClick={() => { if (item.href) navigate(item.href) }}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}
