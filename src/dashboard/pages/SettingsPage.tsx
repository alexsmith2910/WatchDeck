import { GlobalPreferencesPanel } from '../components/notifications/GlobalPreferencesPanel'
import { ToastPlayground } from '../components/settings/ToastPlayground'

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-wd-muted">
          Configure notification defaults, quiet hours, and global mute.
        </p>
      </header>

      <GlobalPreferencesPanel />
      <ToastPlayground />
    </div>
  )
}
