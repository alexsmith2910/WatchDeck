/**
 * Per-browser user preferences (timezone, time format, theme, density, …).
 *
 * Persisted to `wd.preferences` in `localStorage`. Defaults are sourced from
 * `Intl.DateTimeFormat().resolvedOptions()` on first load so a fresh browser
 * picks up the OS timezone and locale conventions automatically.
 *
 * Timestamps across the dashboard are rendered through `utils/time.ts` using
 * the current preferences — switching timezone here instantly re-renders
 * every visible timestamp that reads from `usePreferences()`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemePreference = 'light' | 'dark' | 'system'
export type TimeFormat = '12h' | '24h'
export type DateFormat = 'auto' | 'iso' | 'localized'
export type Density = 'comfortable' | 'compact'

export interface Preferences {
  theme: ThemePreference
  timezone: string
  timeFormat: TimeFormat
  dateFormat: DateFormat
  density: Density
}

export interface PreferencesContextValue {
  prefs: Preferences
  setPrefs: (updater: Partial<Preferences> | ((prev: Preferences) => Preferences)) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'wd.preferences'

function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

function detectTimeFormat(): TimeFormat {
  try {
    const hc = (Intl.DateTimeFormat().resolvedOptions() as { hourCycle?: string }).hourCycle
    if (hc === 'h23' || hc === 'h24') return '24h'
    return '12h'
  } catch {
    return '24h'
  }
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  timezone: detectTimezone(),
  timeFormat: detectTimeFormat(),
  dateFormat: 'auto',
  density: 'comfortable',
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

function readStored(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return { ...DEFAULT_PREFERENCES, ...parsed }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Preferences>(readStored)

  // Apply density as an attribute on <html> so CSS can scope off it without
  // React re-rendering every consumer.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-density', prefs.density)
  }, [prefs.density])

  // Mirror changes from other tabs so two open dashboards stay in sync.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue == null) return
      try {
        const parsed = JSON.parse(e.newValue) as Partial<Preferences>
        setPrefsState((prev) => ({ ...prev, ...parsed }))
      } catch {
        // Ignore — a malformed write will get overwritten on the next save.
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setPrefs = useCallback<PreferencesContextValue['setPrefs']>((updater) => {
    setPrefsState((prev) => {
      const next =
        typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage full / disabled — preference lives for the session only.
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Non-fatal.
    }
    setPrefsState(DEFAULT_PREFERENCES)
  }, [])

  const value = useMemo<PreferencesContextValue>(
    () => ({ prefs, setPrefs, reset }),
    [prefs, setPrefs, reset],
  )

  return (
    <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
  )
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error('usePreferences must be used inside <PreferencesProvider>')
  return ctx
}
