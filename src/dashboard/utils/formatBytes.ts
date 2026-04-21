/**
 * Format a byte count into a short human-readable string.
 *
 * Uses decimal units (1 KB = 1000 B) because that is what file managers and
 * most APIs display. Values under 1 KB render as exact bytes.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}
