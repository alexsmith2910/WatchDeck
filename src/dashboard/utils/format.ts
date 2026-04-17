// Shared formatting and display helpers used across dashboard pages

export function timeAgo(date: Date | string | null): string {
  if (!date) return 'Never'
  const d = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

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

export function formatHour(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatTime(date: Date | null): string {
  if (!date) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function latencyColor(ms: number): string {
  if (ms === 0) return 'text-wd-muted'
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
