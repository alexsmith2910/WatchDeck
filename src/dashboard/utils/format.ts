// Shared formatting and display helpers used across dashboard pages.
//
// Timestamp policy: every stored timestamp is UTC. Rendering goes through
// `utils/time.ts`, which applies the user's configured timezone + time format.
// Callers inside React components should prefer `useFormat()` for an ergonomic,
// already-bound API; pure helpers can import from `utils/time.ts` directly.
//
// This module re-exports the preference-aware date/time formatters under
// their historical names so the existing call sites keep working. The
// non-date helpers (duration, latency tint, incident range detection) live
// here because they don't depend on preferences.

export {
  formatDate,
  formatDateShort,
  formatHour,
  formatRelative as timeAgo,
  formatSmart,
  formatTime,
  formatTs as formatDateTime,
  formatTsShort,
} from './time'

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function formatRuntime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

/**
 * Tint a response-time value against the endpoint's latencyThreshold (ms).
 * Matches the backend status evaluator: at/above threshold = degraded = danger.
 *
 * Bands:
 *   0                       → muted      (no data)
 *   < threshold * 0.5       → success    (comfortably under threshold)
 *   < threshold             → warning    (approaching threshold)
 *   >= threshold            → danger     (backend marks this "degraded")
 *
 * When no threshold is available (legacy list rows etc.), falls back to the
 * historical 200/500 ms ladder so the tint still reads correctly-ish.
 */
export function latencyColor(ms: number, threshold?: number | null): string {
  if (ms === 0) return 'text-wd-muted'
  if (threshold != null && threshold > 0) {
    if (ms < threshold * 0.5) return 'text-wd-success'
    if (ms < threshold) return 'text-wd-warning'
    return 'text-wd-danger'
  }
  if (ms < 200) return 'text-wd-success'
  if (ms < 500) return 'text-wd-warning'
  return 'text-wd-danger'
}

export function uptimeColor(pct: number): string {
  if (pct >= 99.9) return 'text-wd-success'
  if (pct >= 99) return 'text-wd-warning'
  return 'text-wd-danger'
}

// ---------------------------------------------------------------------------
// Incident range detection for chart reference areas
// ---------------------------------------------------------------------------

export interface IncidentRange {
  x1: string
  x2: string
  type: 'down' | 'degraded'
}

/**
 * Scan chart data for contiguous runs of down/degraded points.
 * Uses `fails` / `degraded` fields (endpoint detail) or falls back to
 * `downPercent` / `uptime` (overview page).
 *
 * When an incident occupies only a single data point, the reference area
 * would be invisible (x1 === x2). In that case, expand to cover the
 * neighbouring bucket so the shading is always visible. This does NOT affect
 * which data points are treated as incident data for min/max filtering —
 * only the visual shading region.
 */
export function getIncidentRanges(
  data: Array<Record<string, string | number>>,
  /** Expand single-point ranges to cover a neighbouring bucket so the
   *  ReferenceArea stripe is visible on area/line charts. Set to false
   *  for bar charts where a single bucket is already visible. */
  expandSinglePoints = true,
): IncidentRange[] {
  const labels = data.map((d) => String(d.label))
  const ranges: IncidentRange[] = []
  let rangeStart: string | null = null
  let rangeStartIdx = -1
  let rangeType: 'down' | 'degraded' | null = null
  let lastLabel = ''
  let lastIdx = -1

  for (let i = 0; i < data.length; i++) {
    const point = data[i]
    const label = labels[i]
    const fails = Number(point.fails ?? 0)
    const degraded = Number(point.degraded ?? 0)
    const downPct = Number(point.downPercent ?? 0)
    const uptime = point.uptime != null ? Number(point.uptime) : null

    // Determine severity: down takes priority over degraded
    let type: 'down' | 'degraded' | null = null
    if (fails > 0 || downPct > 0) {
      type = 'down'
    } else if (degraded > 0 || (uptime != null && uptime < 100 && uptime > 0)) {
      type = 'degraded'
    }

    if (type) {
      if (!rangeStart || rangeType !== type) {
        // Close previous range if type changed
        if (rangeStart && rangeType) {
          ranges.push(finaliseRange(rangeStart, rangeStartIdx, lastLabel, lastIdx, rangeType, labels, expandSinglePoints))
        }
        rangeStart = label
        rangeStartIdx = i
        rangeType = type
      }
    } else {
      if (rangeStart && rangeType) {
        ranges.push(finaliseRange(rangeStart, rangeStartIdx, lastLabel, lastIdx, rangeType, labels, expandSinglePoints))
        rangeStart = null
        rangeType = null
      }
    }
    lastLabel = label
    lastIdx = i
  }

  if (rangeStart && rangeType) {
    ranges.push(finaliseRange(rangeStart, rangeStartIdx, lastLabel, lastIdx, rangeType, labels, expandSinglePoints))
  }

  return ranges
}

/**
 * If `expand` is true and a range covers only a single point (x1 === x2),
 * expand it to the adjacent bucket so the ReferenceArea stripe is visible
 * on line/area charts. Prefers expanding forward, falls back to backward.
 */
function finaliseRange(
  x1: string,
  startIdx: number,
  x2: string,
  endIdx: number,
  type: 'down' | 'degraded',
  labels: string[],
  expand: boolean,
): IncidentRange {
  if (expand && (x1 === x2 || startIdx === endIdx)) {
    if (endIdx + 1 < labels.length) {
      return { x1, x2: labels[endIdx + 1], type }
    }
    if (startIdx - 1 >= 0) {
      return { x1: labels[startIdx - 1], x2, type }
    }
  }
  return { x1, x2, type }
}

export const statusColors: Record<string, { dot: string; bg: string; text: string }> = {
  healthy: { dot: 'bg-wd-success', bg: 'bg-wd-success/10', text: 'text-wd-success' },
  degraded: { dot: 'bg-wd-warning', bg: 'bg-wd-warning/10', text: 'text-wd-warning' },
  down: { dot: 'bg-wd-danger', bg: 'bg-wd-danger/10', text: 'text-wd-danger' },
  unknown: { dot: 'bg-wd-muted', bg: 'bg-wd-surface-hover', text: 'text-wd-muted' },
}
