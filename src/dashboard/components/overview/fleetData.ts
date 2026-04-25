/**
 * Fleet-level data helpers for the Overview page.
 *
 * We generate a canonical list of bucket timestamps up front (24 hourly
 * buckets for 24h, N daily buckets for the longer ranges), then align every
 * per-endpoint series to those keys. Missing buckets show as "no data" in the
 * heatmap and as gaps in the charts rather than as fabricated 100% uptime.
 */
import type { HourlySummary, DailySummary, ApiEndpoint } from "../../types/api";

export type FleetRange = "24h" | "7d" | "30d" | "90d";

export const RANGE_CONFIG: Record<
  FleetRange,
  { hours: number; hourly: boolean; limit: number }
> = {
  "24h": { hours: 24, hourly: true, limit: 24 },
  "7d": { hours: 168, hourly: false, limit: 7 },
  "30d": { hours: 720, hourly: false, limit: 30 },
  "90d": { hours: 2160, hourly: false, limit: 90 },
};

// ---------------------------------------------------------------------------
// Canonical bucket generation
// ---------------------------------------------------------------------------

/** Returns the canonical bucket keys (ISO strings) for the given range. */
export function canonicalBucketKeys(range: FleetRange): string[] {
  const cfg = RANGE_CONFIG[range];
  const now = new Date();
  const out: string[] = [];
  if (cfg.hourly) {
    const cur = new Date(now);
    cur.setUTCMinutes(0, 0, 0);
    for (let i = cfg.limit - 1; i >= 0; i--) {
      out.push(new Date(cur.getTime() - i * 3_600_000).toISOString());
    }
  } else {
    const cur = new Date(now);
    cur.setUTCHours(0, 0, 0, 0);
    for (let i = cfg.limit - 1; i >= 0; i--) {
      out.push(new Date(cur.getTime() - i * 86_400_000).toISOString());
    }
  }
  return out;
}

/** Normalise an ISO string to the same canonical form as canonicalBucketKeys. */
function canonKey(iso: string): string {
  return new Date(iso).toISOString();
}

// ---------------------------------------------------------------------------
// Fleet bucket aggregation
// ---------------------------------------------------------------------------

export interface FleetBucket {
  label: string;
  key: string;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  uptime: number | null;
  errRate: number | null;
  throughput: number;
  healthy: number;
  degraded: number;
  down: number;
  fails: number;
}

interface Agg {
  key: string;
  totalChecks: number;
  success: number;
  degraded: number;
  failed: number;
  p95s: number[];
  p99s: number[];
  rts: number[];
}

function newAgg(key: string): Agg {
  return {
    key,
    totalChecks: 0,
    success: 0,
    degraded: 0,
    failed: 0,
    p95s: [],
    p99s: [],
    rts: [],
  };
}

function pickMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

function finaliseBucket(agg: Agg, label: string): FleetBucket {
  const total = agg.totalChecks;
  if (total === 0) {
    return {
      label,
      key: agg.key,
      avg: null,
      p50: null,
      p95: null,
      p99: null,
      uptime: null,
      errRate: null,
      throughput: 0,
      healthy: 0,
      degraded: 0,
      down: 0,
      fails: 0,
    };
  }
  const uptime = Math.round((agg.success / total) * 10000) / 100;
  const errRate =
    Math.round(((agg.failed + agg.degraded) / total) * 10000) / 100;
  const rts = agg.rts.slice().sort((a, b) => a - b);
  const p95s = agg.p95s.slice().sort((a, b) => a - b);
  const p99s = agg.p99s.slice().sort((a, b) => a - b);
  return {
    label,
    key: agg.key,
    avg: rts.length
      ? Math.round(rts.reduce((s, v) => s + v, 0) / rts.length)
      : null,
    p50: rts.length ? pickMedian(rts) : null,
    p95: p95s.length
      ? (p95s[Math.min(p95s.length - 1, Math.floor(p95s.length * 0.95))] ??
        null)
      : null,
    p99: p99s.length
      ? (p99s[Math.min(p99s.length - 1, Math.floor(p99s.length * 0.99))] ??
        null)
      : null,
    uptime,
    errRate,
    throughput: total,
    healthy: agg.success,
    degraded: agg.degraded,
    down: agg.failed,
    fails: agg.failed,
  };
}

/** Fleet-level aggregation across endpoints, aligned to canonical hourly keys. */
export function aggregateHourlies(
  hourlyByEp: Map<string, HourlySummary[]>,
  bucketKeys: string[],
  labelFor: (iso: string) => string,
): FleetBucket[] {
  const byKey = new Map<string, Agg>();
  for (const k of bucketKeys) byKey.set(k, newAgg(k));
  for (const list of hourlyByEp.values()) {
    for (const h of list) {
      const key = canonKey(h.hour);
      const a = byKey.get(key);
      if (!a) continue;
      a.totalChecks += h.totalChecks;
      a.success += h.successCount;
      a.degraded += h.degradedCount;
      a.failed += h.failCount;
      if (h.avgResponseTime > 0) a.rts.push(h.avgResponseTime);
      if (h.p95ResponseTime > 0) a.p95s.push(h.p95ResponseTime);
      if (h.p99ResponseTime > 0) a.p99s.push(h.p99ResponseTime);
    }
  }
  return bucketKeys.map((k) =>
    finaliseBucket(byKey.get(k) ?? newAgg(k), labelFor(k)),
  );
}

export function aggregateDailies(
  dailyByEp: Map<string, DailySummary[]>,
  bucketKeys: string[],
  labelFor: (iso: string) => string,
): FleetBucket[] {
  const byKey = new Map<string, Agg>();
  for (const k of bucketKeys) byKey.set(k, newAgg(k));
  for (const list of dailyByEp.values()) {
    for (const d of list) {
      const key = canonKey(d.date);
      const a = byKey.get(key);
      if (!a) continue;
      a.totalChecks += d.totalChecks;
      // Daily summaries don't split success vs degraded. Treat uptimePercent
      // as the success share and the remainder as failed so the stacked bar
      // chart still renders a meaningful split.
      const successShare = Math.round(d.totalChecks * (d.uptimePercent / 100));
      a.success += successShare;
      a.failed += Math.max(0, d.totalChecks - successShare);
      if (d.avgResponseTime > 0) a.rts.push(d.avgResponseTime);
      if (d.p95ResponseTime > 0) a.p95s.push(d.p95ResponseTime);
      if (d.p99ResponseTime > 0) a.p99s.push(d.p99ResponseTime);
    }
  }
  return bucketKeys.map((k) =>
    finaliseBucket(byKey.get(k) ?? newAgg(k), labelFor(k)),
  );
}

// ---------------------------------------------------------------------------
// Per-endpoint heatmap rows (aligned to canonical bucket keys)
// ---------------------------------------------------------------------------

export interface HeatmapCell {
  label: string;
  v: number | null; // 0..1 uptime, null = no data
}

export interface HeatmapRow {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "down" | "paused" | "nodata";
  uptime30d: number | null;
  values: HeatmapCell[];
  hasData: boolean;
}

export function buildHeatmapRows(
  endpoints: ApiEndpoint[],
  hourlyByEp: Map<string, HourlySummary[]>,
  dailyByEp: Map<string, DailySummary[]>,
  uptimeByEp: Map<string, number | null>,
  range: FleetRange,
  bucketKeys: string[],
  labelFor: (iso: string) => string,
): HeatmapRow[] {
  const cfg = RANGE_CONFIG[range];
  return endpoints.map((ep) => {
    const status: HeatmapRow["status"] =
      ep.status === "paused" ? "paused" : (ep.lastStatus ?? "nodata");

    const byKey = new Map<string, number>();
    if (cfg.hourly) {
      for (const h of hourlyByEp.get(ep.id) ?? []) {
        byKey.set(
          canonKey(h.hour),
          h.totalChecks === 0 ? 1 : h.uptimePercent / 100,
        );
      }
    } else {
      for (const d of dailyByEp.get(ep.id) ?? []) {
        byKey.set(
          canonKey(d.date),
          d.totalChecks === 0 ? 1 : d.uptimePercent / 100,
        );
      }
    }

    const values: HeatmapCell[] = bucketKeys.map((k) => {
      const v = byKey.get(k);
      return {
        label: labelFor(k),
        v: v == null ? null : Math.max(0, Math.min(1, v)),
      };
    });

    return {
      id: ep.id,
      name: ep.name,
      status,
      uptime30d: uptimeByEp.get(ep.id) ?? null,
      values,
      hasData: byKey.size > 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface EndpointScore {
  id: string;
  name: string;
  url: string;
  status: "healthy" | "degraded" | "down" | "paused" | "nodata";
  spark: number[];
  p95: number;
  flaps: number;
  errRate: number;
}

export function buildEndpointScores(
  endpoints: ApiEndpoint[],
  hourlyByEp: Map<string, HourlySummary[]>,
  dailyByEp: Map<string, DailySummary[]>,
  incidentCountByEp: Map<string, number>,
  range: FleetRange,
): EndpointScore[] {
  const cfg = RANGE_CONFIG[range];
  return endpoints.map((ep) => {
    let maxP95 = 0;
    let total = 0;
    let failed = 0;
    let spark: number[];

    if (cfg.hourly) {
      const hours = (hourlyByEp.get(ep.id) ?? [])
        .slice()
        .sort((a, b) => a.hour.localeCompare(b.hour));
      spark = hours.map((h) => h.avgResponseTime);
      for (const h of hours) {
        maxP95 = Math.max(maxP95, h.p95ResponseTime);
        total += h.totalChecks;
        failed += h.failCount + h.degradedCount;
      }
    } else {
      const days = (dailyByEp.get(ep.id) ?? [])
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date));
      spark = days.map((d) => d.avgResponseTime);
      for (const d of days) {
        maxP95 = Math.max(maxP95, d.p95ResponseTime);
        total += d.totalChecks;
        failed += Math.max(
          0,
          Math.round((d.totalChecks * (100 - d.uptimePercent)) / 100),
        );
      }
    }

    const errRate =
      total === 0 ? 0 : Math.round((failed / total) * 10000) / 100;

    return {
      id: ep.id,
      name: ep.name,
      url: ep.url ?? (ep.host && ep.port ? `${ep.host}:${ep.port}` : ""),
      status: ep.status === "paused" ? "paused" : (ep.lastStatus ?? "nodata"),
      spark,
      p95: maxP95 > 0 ? maxP95 : (ep.lastResponseTime ?? 0),
      flaps: incidentCountByEp.get(ep.id) ?? 0,
      errRate,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-endpoint comparison series
// ---------------------------------------------------------------------------

export interface PerEndpointComparison {
  rows: Record<string, string | number | null>[];
  series: { id: string; name: string }[];
}

/** Build a recharts-ready dataset for the per-endpoint response-time chart. */
export function buildPerEndpointSeries(
  endpoints: ApiEndpoint[],
  hourlyByEp: Map<string, HourlySummary[]>,
  dailyByEp: Map<string, DailySummary[]>,
  range: FleetRange,
  bucketKeys: string[],
  labelFor: (iso: string) => string,
): PerEndpointComparison {
  const cfg = RANGE_CONFIG[range];
  const series = endpoints.map((ep) => ({ id: ep.id, name: ep.name }));

  const rows: Record<string, string | number | null>[] = bucketKeys.map(
    (k) => ({
      label: labelFor(k),
    }),
  );

  for (const ep of endpoints) {
    const byKey = new Map<string, number>();
    if (cfg.hourly) {
      for (const h of hourlyByEp.get(ep.id) ?? []) {
        if (h.avgResponseTime > 0)
          byKey.set(canonKey(h.hour), h.avgResponseTime);
      }
    } else {
      for (const d of dailyByEp.get(ep.id) ?? []) {
        if (d.avgResponseTime > 0)
          byKey.set(canonKey(d.date), d.avgResponseTime);
      }
    }
    for (let i = 0; i < bucketKeys.length; i++) {
      const key = bucketKeys[i];
      const row = rows[i];
      const v = byKey.get(key);
      row[`rt-${ep.id}`] = v ?? null;
    }
  }

  return { rows, series };
}
