/**
 * Kind → HeroUI variant + default icon + default timeout.
 *
 * The app never refers to HeroUI variants directly. Our wrapper translates
 * `ToastKind` into the closest HeroUI equivalent, overrides the indicator
 * with a consistent Iconify icon, and applies a sensible default timeout.
 */
import type { ToastKind } from './types.js'

export type HeroUIVariant = 'default' | 'accent' | 'success' | 'warning' | 'danger'

export interface KindSpec {
  variant: HeroUIVariant
  icon: string
  /** ms; Infinity = persistent by default (caller may override with `timeout`). */
  defaultTimeout: number
}

export const KIND_SPEC: Record<ToastKind, KindSpec> = {
  success:  { variant: 'success', icon: 'solar:check-circle-bold',      defaultTimeout: 4500 },
  info:     { variant: 'accent',  icon: 'solar:info-circle-bold',       defaultTimeout: 5000 },
  warning:  { variant: 'warning', icon: 'solar:danger-triangle-bold',   defaultTimeout: 6500 },
  error:    { variant: 'danger',  icon: 'solar:close-circle-bold',      defaultTimeout: 8000 },
  neutral:  { variant: 'default', icon: 'solar:bell-bold',              defaultTimeout: 5000 },
  loading:  { variant: 'default', icon: 'solar:refresh-bold',           defaultTimeout: Infinity },
  promise:  { variant: 'default', icon: 'solar:refresh-bold',           defaultTimeout: Infinity },
}

export function kindSpec(kind: ToastKind | undefined): KindSpec {
  return KIND_SPEC[kind ?? 'neutral']
}
