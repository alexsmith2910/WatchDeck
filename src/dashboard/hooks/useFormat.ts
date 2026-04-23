/**
 * Binds the pure formatters in `utils/time.ts` to the current user preferences
 * so components don't have to pass `prefs` through on every call.
 *
 * Usage:
 *   const fmt = useFormat()
 *   return <span>{fmt.ts(row.startedAt)}</span>
 *
 * `timeAgo` / `formatRelative` are equivalent names for the same behaviour —
 * the dashboard historically used `timeAgo`, new code can use `relative`.
 */
import { useMemo } from 'react'
import { usePreferences } from '../context/PreferencesContext'
import {
  formatDate,
  formatDateShort,
  formatHour,
  formatRelative,
  formatSmart,
  formatTime,
  formatTs,
  formatTsShort,
} from '../utils/time'

export function useFormat() {
  const { prefs } = usePreferences()
  return useMemo(
    () => ({
      ts: (d: Date | string | number | null | undefined) => formatTs(d, prefs),
      tsShort: (d: Date | string | number | null | undefined) => formatTsShort(d, prefs),
      date: (d: Date | string | number | null | undefined) => formatDate(d, prefs),
      dateShort: (d: Date | string | number | null | undefined) => formatDateShort(d, prefs),
      time: (d: Date | string | number | null | undefined) => formatTime(d, prefs),
      hour: (d: Date | string | number | null | undefined) => formatHour(d, prefs),
      relative: (d: Date | string | number | null | undefined) => formatRelative(d ?? null, prefs),
      smart: (d: Date | string | number | null | undefined) => formatSmart(d ?? null, prefs),
      timezone: prefs.timezone,
      prefs,
    }),
    [prefs],
  )
}
