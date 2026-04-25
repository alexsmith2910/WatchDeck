/**
 * Shared provider tree that wraps the dashboard's <App />. Both the standalone
 * entry (`main.tsx`) and the mountable `WatchDeckDashboard` component render
 * through this so the two paths can't drift apart.
 *
 * `basename` is forwarded to BrowserRouter — pulled from `data-base-path` in
 * standalone mode, or from props in mounted mode.
 */
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { SSEProvider } from './context/SSEContext'
import { PreferencesProvider } from './context/PreferencesContext'
import { ToastProvider, ToastBridge } from './ui/toast'
import App from './App'

export interface AppShellProps {
  basename: string
}

export default function AppShell({ basename }: AppShellProps) {
  return (
    <BrowserRouter basename={basename}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <PreferencesProvider>
          <SSEProvider>
            <ToastProvider />
            <ToastBridge />
            <App />
          </SSEProvider>
        </PreferencesProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
