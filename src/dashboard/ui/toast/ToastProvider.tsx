/**
 * ToastProvider — mounts HeroUI's region with our design defaults and custom
 * shell. Must be rendered inside BrowserRouter (ToastShell uses useNavigate).
 */
import { ToastProvider as HeroUIToastProvider } from '@heroui/react'
import { ToastShell, type ToastPlacement, type ToastShellValue } from './ToastShell.js'
import { wdToastQueue } from './toast.js'

export interface ToastProviderProps {
  placement?: ToastPlacement
  width?: number
  maxVisibleToasts?: number
  gap?: number
  scaleFactor?: number
}

export function ToastProvider({
  placement = 'bottom end',
  width = 420,
  maxVisibleToasts = 3,
  gap = 12,
  scaleFactor = 0.05,
}: ToastProviderProps) {
  return (
    <HeroUIToastProvider<ToastShellValue>
      placement={placement}
      width={width}
      maxVisibleToasts={maxVisibleToasts}
      gap={gap}
      scaleFactor={scaleFactor}
      queue={wdToastQueue}
    >
      {({ toast }) => <ToastShell toast={toast} placement={placement} />}
    </HeroUIToastProvider>
  )
}
