/**
 * Public entry for the toast subsystem.
 *
 * App code should import only from this module — never from the individual
 * files (`toast.ts`, `presets.ts`, etc.) or from `@heroui/react` directly.
 */
export { toast } from './toast.js'
export type { ToastApi } from './toast.js'
export { ToastProvider } from './ToastProvider.js'
export { ToastBridge } from './ToastBridge.js'
export { toastPresets } from './presets.js'
export type {
  ToastKind,
  ToastOptions,
  ToastAction,
  ToastActionVariant,
  ToastCloseReason,
  ToastPromiseOptions,
} from './types.js'
