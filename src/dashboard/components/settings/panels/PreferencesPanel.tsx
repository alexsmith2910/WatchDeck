/**
 * Preferences panel — per-browser settings persisted in localStorage via the
 * PreferencesContext. No API round-trips, no dirty-tracking-on-save: every
 * change applies immediately so the user sees the dashboard respond live.
 *
 * `onDirtyChange` is wired for API-symmetry with the other panels but is
 * always called with `false` — there's nothing to save or discard here.
 */
import { useEffect, useMemo } from 'react'
import { cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { SectionHead, FilterDropdown } from '../../endpoint-detail/primitives'
import { Field } from '../../endpoint-detail/SettingsTab'
import {
  usePreferences,
  type DateFormat,
  type Density,
  type ThemePreference,
  type TimeFormat,
} from '../../../context/PreferencesContext'
import { useTheme } from '../../../hooks/useTheme'
import { useFormat } from '../../../hooks/useFormat'

interface Props {
  onDirtyChange?: (dirty: boolean) => void
}

// ---------------------------------------------------------------------------
// Option sets — dropdown labels, consistent phrasing across the panel.
// ---------------------------------------------------------------------------

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

const TIME_FORMAT_OPTIONS: Array<{ id: TimeFormat; label: string }> = [
  { id: '24h', label: '24-hour (14:23)' },
  { id: '12h', label: '12-hour (2:23 PM)' },
]

const DATE_FORMAT_OPTIONS: Array<{ id: DateFormat; label: string }> = [
  { id: 'auto', label: 'Auto (browser locale)' },
  { id: 'iso', label: 'ISO (2026-04-23)' },
  { id: 'localized', label: 'Localized (long form)' },
]

const DENSITY_OPTIONS: Array<{ id: Density; label: string }> = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
]

// The common zones the dropdown prepopulates. The browser-detected zone is
// injected at the top at render time so fresh installs land on the right
// value without scrolling.
const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Pacific/Auckland',
]

export function PreferencesPanel({ onDirtyChange }: Props) {
  const { prefs, setPrefs, reset } = usePreferences()
  const { setTheme } = useTheme()
  const fmt = useFormat()

  // Preferences persist as they change, so there's never any "unsaved" state
  // for the parent layout's dirty-dot to render against. Fire once on mount.
  useEffect(() => {
    onDirtyChange?.(false)
    // onDirtyChange is stable (memoised by parent) so an empty deps array is
    // correct here — avoids an edge case where a non-stable prop would let
    // this effect re-run and interleave with child dropdown state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const timezoneOptions = useMemo(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const seen = new Set<string>()
    const out: Array<{ id: string; label: string }> = []
    if (!seen.has(detected)) {
      out.push({ id: detected, label: `Browser default — ${detected}` })
      seen.add(detected)
    }
    for (const tz of COMMON_TIMEZONES) {
      if (seen.has(tz)) continue
      out.push({ id: tz, label: tz })
      seen.add(tz)
    }
    if (!seen.has(prefs.timezone)) {
      out.push({ id: prefs.timezone, label: `${prefs.timezone} (custom)` })
    }
    return out
  }, [prefs.timezone])

  const samplePreview = useMemo(() => fmt.ts(new Date()), [fmt])

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:user-circle-linear"
        title="Preferences"
        sub="Applies to this browser only — changes save instantly."
      />

      <div className="rounded-lg border border-wd-border/40 bg-wd-surface-hover/30 px-3 py-2 mb-5 flex items-center gap-3">
        <Icon icon="solar:clock-circle-linear" width={14} className="text-wd-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-wd-muted">Preview (current settings)</div>
          <div className="text-[13px] font-mono text-foreground truncate">{samplePreview}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Theme" hint="Match system follows your OS setting.">
          <FilterDropdown<ThemePreference>
            value={prefs.theme}
            options={THEME_OPTIONS}
            onChange={(id) => {
              setPrefs({ theme: id })
              setTheme(id)
            }}
            ariaLabel="Theme"
            fullWidth
          />
        </Field>

        <Field label="Density" hint="Tighter padding for information-dense screens.">
          <FilterDropdown<Density>
            value={prefs.density}
            options={DENSITY_OPTIONS}
            onChange={(id) => setPrefs({ density: id })}
            ariaLabel="Density"
            fullWidth
          />
        </Field>

        <Field label="Timezone" hint="Every displayed timestamp renders in this zone.">
          <FilterDropdown<string>
            value={prefs.timezone}
            options={timezoneOptions}
            onChange={(id) => setPrefs({ timezone: id })}
            ariaLabel="Timezone"
            fullWidth
          />
        </Field>

        <Field
          label="Custom timezone"
          hint="Override with any IANA zone (e.g. America/Halifax)."
        >
          <input
            value={prefs.timezone}
            onChange={(e) => setPrefs({ timezone: e.target.value })}
            placeholder="Region/City"
            className={cn(
              'w-full h-9 rounded-lg bg-wd-surface border border-wd-border/60 px-3 text-[12.5px] text-foreground font-mono focus:outline-none focus:border-wd-primary transition-colors',
            )}
          />
        </Field>

        <Field label="Time format" hint="Clock-face style for times across the dashboard.">
          <FilterDropdown<TimeFormat>
            value={prefs.timeFormat}
            options={TIME_FORMAT_OPTIONS}
            onChange={(id) => setPrefs({ timeFormat: id })}
            ariaLabel="Time format"
            fullWidth
          />
        </Field>

        <Field label="Date format" hint="Order and separators in displayed dates.">
          <FilterDropdown<DateFormat>
            value={prefs.dateFormat}
            options={DATE_FORMAT_OPTIONS}
            onChange={(id) => setPrefs({ dateFormat: id })}
            ariaLabel="Date format"
            fullWidth
          />
        </Field>

      </div>

      <div className="flex items-center gap-3 mt-5 pt-4 border-t border-wd-border/40">
        <button
          type="button"
          onClick={() => {
            reset()
            setTheme('system')
          }}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border border-wd-border/50 bg-wd-surface hover:bg-wd-surface-hover transition-colors cursor-pointer"
        >
          <Icon icon="solar:refresh-linear" width={14} />
          Reset to defaults
        </button>
        <span className="text-[11.5px] text-wd-muted">
          Stored in <span className="font-mono">localStorage</span> as{' '}
          <span className="font-mono">wd.preferences</span>.
        </span>
      </div>
    </div>
  )
}
