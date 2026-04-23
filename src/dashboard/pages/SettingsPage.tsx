/**
 * Global settings page.
 *
 * Mirrors the endpoint-detail `SettingsTab` layout: sidebar nav on the left
 * (with per-panel dirty-dot indicators) and one rounded-xl panel on the right.
 * Six sections total — three editable, two read-only, one danger. Only panels
 * with an unsaved-edits concept participate in dirty tracking; read-only and
 * danger panels never flag dirty.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { PreferencesPanel } from '../components/settings/panels/PreferencesPanel'
import { NotificationsPanel } from '../components/settings/panels/NotificationsPanel'
import { CheckDefaultsPanel } from '../components/settings/panels/CheckDefaultsPanel'
import { ModulesPanel } from '../components/settings/panels/ModulesPanel'
import { RetentionPanel } from '../components/settings/panels/RetentionPanel'
import { DangerPanel } from '../components/settings/panels/DangerPanel'

type Section =
  | 'preferences'
  | 'notifications'
  | 'check-defaults'
  | 'modules'
  | 'retention'
  | 'danger'

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: 'preferences', label: 'Preferences', icon: 'solar:user-circle-linear' },
  { key: 'notifications', label: 'Notifications', icon: 'solar:bell-bing-outline' },
  { key: 'check-defaults', label: 'Check defaults', icon: 'solar:radar-linear' },
  { key: 'modules', label: 'Modules', icon: 'solar:layers-minimalistic-outline' },
  { key: 'retention', label: 'Retention', icon: 'solar:archive-down-minimlistic-outline' },
  { key: 'danger', label: 'Danger zone', icon: 'solar:danger-triangle-linear' },
]

const VALID_SECTIONS: Section[] = SECTIONS.map((s) => s.key)

type DirtyMap = Record<Exclude<Section, 'modules' | 'retention' | 'danger'>, boolean>

export default function SettingsPage() {
  const [searchParams] = useSearchParams()
  const [section, setSection] = useState<Section>(() => {
    const s = searchParams.get('section')
    return s && (VALID_SECTIONS as string[]).includes(s) ? (s as Section) : 'preferences'
  })

  const [dirty, setDirty] = useState<DirtyMap>({
    preferences: false,
    notifications: false,
    'check-defaults': false,
  })
  // Per-panel handlers are memoised once so their references stay stable across
  // renders — child effects that depend on `onDirtyChange` won't keep firing,
  // which was amplifying the dropdown render loop.
  const dirtyHandlers = useMemo<Record<keyof DirtyMap, (d: boolean) => void>>(
    () => ({
      preferences: (d) =>
        setDirty((prev) => (prev.preferences === d ? prev : { ...prev, preferences: d })),
      notifications: (d) =>
        setDirty((prev) => (prev.notifications === d ? prev : { ...prev, notifications: d })),
      'check-defaults': (d) =>
        setDirty((prev) =>
          prev['check-defaults'] === d ? prev : { ...prev, 'check-defaults': d },
        ),
    }),
    [],
  )
  const anyDirty = dirty.preferences || dirty.notifications || dirty['check-defaults']

  // Guard against accidental browser nav with unsaved edits. Same pattern as
  // the endpoint-detail Settings tab's beforeunload handler.
  useEffect(() => {
    if (!anyDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [anyDirty])

  const switchSection = (next: Section) => {
    if (next === section) return
    const leavingDirty =
      (section === 'preferences' && dirty.preferences) ||
      (section === 'notifications' && dirty.notifications) ||
      (section === 'check-defaults' && dirty['check-defaults'])
    if (leavingDirty) {
      const ok = window.confirm('Discard unsaved changes in this section?')
      if (!ok) return
    }
    setSection(next)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-[12px] text-wd-muted mt-0.5">
          Per-browser preferences, runtime configuration, and administrative actions.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
        <nav className="rounded-xl border border-wd-border/50 bg-wd-surface p-1 self-start">
          {SECTIONS.map((s) => {
            const active = section === s.key
            const isDirty =
              s.key === 'preferences'
                ? dirty.preferences
                : s.key === 'notifications'
                  ? dirty.notifications
                  : s.key === 'check-defaults'
                    ? dirty['check-defaults']
                    : false
            return (
              <button
                key={s.key}
                onClick={() => switchSection(s.key)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-[12.5px] transition-colors cursor-pointer',
                  active
                    ? 'bg-wd-primary/10 text-wd-primary font-medium'
                    : 'text-wd-muted hover:bg-wd-surface-hover hover:text-foreground',
                )}
              >
                <Icon icon={s.icon} width={15} />
                <span>{s.label}</span>
                {isDirty && (
                  <span
                    className="ml-auto h-1.5 w-1.5 rounded-full bg-wd-warning"
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                  />
                )}
              </button>
            )
          })}
        </nav>

        {/*
          All panels stay mounted — hiding with display:none preserves form
          state + dirty tracking when the user flips between sections. Same
          pattern used on the endpoint detail Settings tab.
        */}
        <div className="min-w-0 min-h-[520px]">
          <div className={cn(section !== 'preferences' && 'hidden')}>
            <PreferencesPanel onDirtyChange={dirtyHandlers.preferences} />
          </div>
          <div className={cn(section !== 'notifications' && 'hidden')}>
            <NotificationsPanel onDirtyChange={dirtyHandlers.notifications} />
          </div>
          <div className={cn(section !== 'check-defaults' && 'hidden')}>
            <CheckDefaultsPanel onDirtyChange={dirtyHandlers['check-defaults']} />
          </div>
          <div className={cn(section !== 'modules' && 'hidden')}>
            <ModulesPanel />
          </div>
          <div className={cn(section !== 'retention' && 'hidden')}>
            <RetentionPanel />
          </div>
          {section === 'danger' && <DangerPanel />}
        </div>
      </div>
    </div>
  )
}
