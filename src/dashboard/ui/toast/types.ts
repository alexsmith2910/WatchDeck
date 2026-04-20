/**
 * Toast type surface.
 *
 * All app-facing toast code depends on `ToastKind` + `ToastOptions`.
 * The HeroUI API is only referenced from `toast.ts` — callers never touch it.
 */
import type { ReactNode } from 'react'

export type ToastKind =
  | 'success'
  | 'info'
  | 'warning'
  | 'error'
  | 'neutral'
  | 'loading'
  | 'promise'

export type ToastActionVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ToastCloseReason = 'timeout' | 'user' | 'programmatic'

export interface ToastAction {
  label: ReactNode
  onPress?: () => void
  /** If set, clicking navigates. Internal URLs go through react-router, external via window.open. */
  href?: string
  variant?: ToastActionVariant
  /** Don't auto-close after the action fires. */
  keepOpen?: boolean
}

export interface ToastOptions {
  kind?: ToastKind
  title?: ReactNode
  description?: ReactNode
  /** Pass `false` to hide the indicator entirely; node overrides the default icon. */
  indicator?: ReactNode | false
  /** Optional CSS color override for the indicator chip. Rare — prefer `kind`. */
  accent?: string

  actions?: ToastAction[]
  link?: { label: ReactNode; href: string }

  /** ms; `null` = persistent. Omit to use the kind's default. */
  timeout?: number | null
  dismissible?: boolean
  pauseOnHover?: boolean
  onClose?: (reason: ToastCloseReason) => void
  onMount?: () => void

  /** Stable key: a second call with the same id updates the existing toast. */
  id?: string
  /** Dedupe group (e.g. all "db-disconnect" toasts collapse to one). */
  group?: string
  /** Max simultaneous toasts per group; older ones close when exceeded. Default 3. */
  maxInGroup?: number
}

export interface ToastPromiseOptions<T = unknown> {
  loading: ReactNode
  success: ((data: T) => ReactNode) | ReactNode
  error: ((error: Error) => ReactNode) | ReactNode
  /** Optional per-phase description. */
  descriptionLoading?: ReactNode
  descriptionSuccess?: ((data: T) => ReactNode) | ReactNode
  descriptionError?: ((err: Error) => ReactNode) | ReactNode
}
