/**
 * Preferences-aware timestamp formatting.
 *
 * Every stored timestamp in WatchDeck is UTC. These helpers render against the
 * user's configured timezone + time format (set on the Settings page). Call
 * sites pick them up via `useFormat()` or pass prefs explicitly; pure helpers
 * that don't have React context take the prefs object as a parameter.
 *
 * `DEFAULT_PREFERENCES` resolves to the browser's timezone + locale hour cycle
 * so callers that don't pass prefs get the same behaviour as before this
 * module existed.
 */
import { DEFAULT_PREFERENCES, type Preferences } from '../context/PreferencesContext'

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function toDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d)
}

const NULL_PLACEHOLDER = '—'

function resolvedLocale(prefs: Preferences): string | undefined {
  // `undefined` tells Intl to use the runtime default, which honours the
  // browser's regional settings. The only time we override is when the user
  // explicitly picks ISO formatting.
  return prefs.dateFormat === 'iso' ? 'sv-SE' : undefined
}

function dateTimeOptions(prefs: Preferences, override: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions {
  return {
    timeZone: prefs.timezone,
    hour12: prefs.timeFormat === '12h',
    ...override,
  }
}

// ---------------------------------------------------------------------------
// Public formatters — all accept an optional prefs, falling back to defaults
// so one-off helpers outside React tree still work.
// ---------------------------------------------------------------------------

/** Full "Oct 12, 2026, 14:23:05" style date+time. Returns "—" for null. */
export function formatTs(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  )
}

/** Compact "Oct 12, 14:23" — no year or seconds. Used in list cells. */
export function formatTsShort(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  )
}

/** Date-only "Oct 12, 2026". */
export function formatDate(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleDateString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, { month: 'short', day: 'numeric', year: 'numeric' }),
  )
}

/** Compact "Oct 12" date (no year). */
export function formatDateShort(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleDateString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, { month: 'short', day: 'numeric' }),
  )
}

/** Time-only "14:23:05" or "02:23:05 PM". */
export function formatTime(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleTimeString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  )
}

/** Hour+minute only, used for compact chart ticks. */
export function formatHour(
  d: Date | string | number | null | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return NULL_PLACEHOLDER
  return toDate(d).toLocaleTimeString(
    resolvedLocale(prefs),
    dateTimeOptions(prefs, { hour: '2-digit', minute: '2-digit' }),
  )
}

/** "2m ago", "3h ago", "yesterday", ... — relative to now. */
export function formatRelative(
  d: Date | string | number | null,
  _prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return 'Never'
  const date = toDate(d)
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Smart formatter — renders relative when recent (within 48h), absolute
 * otherwise. Relative is always on for recent events; absolute always respects
 * the configured timezone + time format.
 */
export function formatSmart(
  d: Date | string | number | null,
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  if (d == null) return 'Never'
  const date = toDate(d)
  const ageMs = Date.now() - date.getTime()
  const recent = ageMs < 48 * 60 * 60 * 1000 && ageMs >= -60 * 1000
  if (recent) return formatRelative(date, prefs)
  return formatTs(date, prefs)
}
