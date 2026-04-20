/**
 * ToastShell — the visual container rendered inside HeroUI's ToastProvider.
 *
 * We don't use HeroUI's default Toast layout; we render our own composition
 * (indicator chip + title + description + actions + close) so every toast
 * matches the design tokens declared in `globals.css` exactly (§9.8).
 */
import { Icon } from '@iconify/react'
import { useNavigate } from 'react-router-dom'
import {
  Toast as HeroToast,
  ToastContent,
  ToastTitle,
  ToastDescription,
  ToastCloseButton,
} from '@heroui/react'
import type { QueuedToast } from 'react-aria-components'
import type { ToastAction, ToastActionVariant } from './types.js'
import type { HeroUIVariant } from './variants.js'

export interface ToastShellValue {
  variant: HeroUIVariant
  icon?: string
  accent?: string
  title?: React.ReactNode
  description?: React.ReactNode
  indicatorOverride?: React.ReactNode | false
  isLoading?: boolean
  actions?: ToastAction[]
  link?: { label: React.ReactNode; href: string }
}

export type ToastPlacement =
  | 'top' | 'top start' | 'top end'
  | 'bottom' | 'bottom start' | 'bottom end'

interface Props {
  toast: QueuedToast<ToastShellValue>
  placement?: ToastPlacement
}

const ACCENT_BG: Record<HeroUIVariant, string> = {
  default: 'bg-wd-surface-hover text-wd-muted',
  accent:  'bg-wd-primary/10 text-wd-primary',
  success: 'bg-wd-success/15 text-wd-success',
  warning: 'bg-wd-warning/15 text-wd-warning',
  danger:  'bg-wd-danger/15 text-wd-danger',
}

const ACTION_CLASS: Record<ToastActionVariant, string> = {
  primary:   'bg-wd-primary text-wd-primary-foreground hover:brightness-110',
  secondary: 'bg-wd-surface-hover text-foreground hover:bg-wd-border dark:bg-wd-surface-hover dark:hover:bg-wd-border',
  danger:    'bg-wd-danger text-white hover:brightness-110 dark:bg-wd-danger/60 dark:hover:bg-wd-danger/70',
  ghost:     'text-wd-muted hover:text-foreground',
}

function isExternalHref(href: string): boolean {
  if (href.startsWith('/') && !href.startsWith('//')) return false
  try {
    const url = new URL(href, window.location.origin)
    return url.host !== window.location.host
  } catch {
    return false
  }
}

export function ToastShell({ toast, placement }: Props) {
  const navigate = useNavigate()
  const c = toast.content
  const indicatorOverride = c.indicatorOverride
  const showIndicator = indicatorOverride !== false

  const indicator = showIndicator
    ? (indicatorOverride ?? (
        c.icon
          ? <Icon icon={c.icon} width={24} className={c.isLoading ? 'animate-spin' : ''} />
          : null
      ))
    : null

  const runAction = (a: ToastAction) => {
    a.onPress?.()
    if (a.href) {
      if (isExternalHref(a.href)) window.open(a.href, '_blank', 'noopener,noreferrer')
      else navigate(a.href)
    }
  }

  return (
    <HeroToast
      toast={toast}
      placement={placement}
      variant={c.variant}
      className="!bg-wd-surface border border-wd-border !rounded-xl shadow-lg dark:shadow-none !pl-4 !pr-12 !py-3 !flex !items-start !gap-3"
    >
      {showIndicator && (
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${ACCENT_BG[c.variant]}`}
          style={c.accent ? { color: c.accent, backgroundColor: `${c.accent}22` } : undefined}
          aria-hidden
        >
          {indicator}
        </div>
      )}

      <ToastContent className="flex-1 min-w-0 flex flex-col gap-0.5">
        {c.title ? (
          <ToastTitle className="text-sm font-semibold text-foreground break-words">
            {c.title}
          </ToastTitle>
        ) : null}
        {c.description ? (
          <ToastDescription className="text-xs text-wd-muted break-words">
            {c.description}
          </ToastDescription>
        ) : null}

        {(c.actions?.length || c.link) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {c.actions?.map((a, i) => (
              <button
                key={i}
                type="button"
                onClick={() => runAction(a)}
                className={`text-xs font-medium rounded-md px-2 py-1 transition ${ACTION_CLASS[a.variant ?? 'secondary']}`}
              >
                {a.label}
              </button>
            ))}
            {c.link ? (
              <button
                type="button"
                onClick={() => runAction({ label: c.link!.label, href: c.link!.href, variant: 'ghost' })}
                className="text-xs font-medium text-wd-primary hover:underline"
              >
                {c.link.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </ToastContent>

      <ToastCloseButton
        className="
          !absolute !top-1/2 !right-2 !-translate-y-1/2
          !h-8 !w-8 !min-w-0 !p-0 !rounded-lg
          !border-none !bg-transparent !opacity-100
          !flex !items-center !justify-center
          hover:!bg-wd-surface-hover/70 dark:hover:!bg-wd-primary/10
          !transition-colors
          focus-visible:!ring-2 focus-visible:!ring-wd-primary/50
        "
      >
        <Icon
          icon="solar:close-circle-bold"
          width={24}
          className="text-foreground"
          aria-hidden
        />
      </ToastCloseButton>
    </HeroToast>
  )
}
