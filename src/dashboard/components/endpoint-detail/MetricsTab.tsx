/**
 * Metrics tab — Response Time + Latency Histogram + Check Pass Rate + Hour-of-Day.
 *
 * Range selector on the RT chart is the *master* range — the other three
 * graphs rebuild off the same time window. Default is 30d. Data sources:
 *
 *   1h  → raw checks (last hour)
 *   24h → hourly summaries (last 24)
 *   7d  → daily summaries (last 7) — falls back to hourly when daily sparse
 *   30d → daily summaries (last 30)
 *
 * Hour-of-day latency (bottom right) uses 8 buckets of 3 hours each, derived
 * from raw checks over the selected window.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useApi } from "../../hooks/useApi";
import type {
  ApiCheck,
  ApiIncident,
  DailySummary,
  HourlySummary,
} from "../../types/api";
import { formatDateShort, formatHour } from "../../utils/time";
import type { Preferences } from "../../context/PreferencesContext";
import { useFormat } from "../../hooks/useFormat";
import type { IncidentRange } from "../../utils/format";
import ForegroundReferenceArea from "../ForegroundReferenceArea";
import { Segmented, SectionHead } from "./primitives";

type PercentileKey = "avg" | "p50" | "p95" | "p99" | "min" | "max";

type LabelPosition =
  | "insideTopLeft"
  | "insideTopRight"
  | "insideBottomLeft"
  | "insideBottomRight";

interface PercentileRow {
  key: PercentileKey;
  label: string;
  color: string;
  dash: string;
  labelPos: LabelPosition;
}

// Ordered ascending (Min → Max) so the 2-col legend reads left-to-right,
// top-to-bottom as a mental "smallest → biggest" ladder. Each row picks a
// different corner for its reference-line label so identical or nearly-equal
// lines don't stack their labels on top of each other.
const PERCENTILE_ROWS: PercentileRow[] = [
  { key: "min", label: "Min", color: "var(--wd-muted)", dash: "2 3", labelPos: "insideTopLeft" },
  { key: "max", label: "Max", color: "var(--wd-muted)", dash: "2 3", labelPos: "insideTopRight" },
  { key: "avg", label: "Avg", color: "#68c4c0", dash: "4 3", labelPos: "insideBottomLeft" },
  { key: "p50", label: "p50", color: "var(--wd-success)", dash: "3 3", labelPos: "insideBottomRight" },
  { key: "p95", label: "p95", color: "var(--wd-warning)", dash: "4 2", labelPos: "insideTopRight" },
  { key: "p99", label: "p99", color: "var(--wd-danger)", dash: "4 2", labelPos: "insideTopLeft" },
];

// Which percentiles vary per-point vs. are only derivable as an overall stat.
const PER_POINT_KEYS = new Set<PercentileKey>(["avg", "p95", "p99"]);

// Percentiles shown on the chart by default; user can toggle the rest on via
// the side legend. Keeping the defaults sparse (just min/max/avg) avoids a
// busy chart on first view and lines up with what most users scan first.
const DEFAULT_VISIBLE_REFS: PercentileKey[] = ["min", "max", "avg"];

export type MetricsRange = "1h" | "24h" | "7d" | "30d";

interface Props {
  endpointId: string;
  range: MetricsRange;
  setRange: (r: MetricsRange) => void;
  hourly24h: HourlySummary[];
  daily30d: DailySummary[];
  latencyThreshold: number;
  incidents: ApiIncident[];
}

// `fails` / `degraded` piggyback on each chart point so `getIncidentRanges`
// (the shared helper in utils/format.ts) can scan for coloured bands. The
// counts are always per-bucket — 1 if a single raw check was down, or the
// aggregated failCount when the bucket is an hour / day.
interface ChartPoint {
  label: string;
  ts: number;
  spanMs: number;
  avg: number;
  p95: number;
  p99: number;
  fails: number;
  degraded: number;
}


interface PassRatePoint {
  label: string;
  passRate: number;
  total: number;
  success: number;
  fail: number;
  degraded: number;
  isPerCheck: boolean;
  status?: "healthy" | "degraded" | "down";
  source: "raw" | "hourly" | "daily";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * (pct / 100)),
  );
  return sorted[idx];
}

// Pick a "nice" bucket width (1-2-2.5-5-10 × power of 10) close to rawStep.
// Clamped to 1ms minimum — sub-ms resolution isn't meaningful for our samples.
function niceStep(rawStep: number): number {
  if (rawStep <= 1) return 1;
  const exp = Math.floor(Math.log10(rawStep));
  const base = Math.pow(10, exp);
  const mantissa = rawStep / base;
  if (mantissa <= 1) return base;
  if (mantissa <= 2) return 2 * base;
  if (mantissa <= 2.5) return 2.5 * base;
  if (mantissa <= 5) return 5 * base;
  return 10 * base;
}

function formatMs(v: number): string {
  if (v >= 1000) {
    const s = v / 1000;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  return `${v}`;
}

function rawChecksToPoints(checks: ApiCheck[], prefs: Preferences): ChartPoint[] {
  return [...checks]
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    .map((c) => ({
      label: formatHour(c.timestamp, prefs),
      ts: new Date(c.timestamp).getTime(),
      spanMs: 60_000,
      avg: c.responseTime,
      p95: c.responseTime,
      p99: c.responseTime,
      fails: c.status === "down" ? 1 : 0,
      degraded: c.status === "degraded" ? 1 : 0,
    }));
}

function hourlyToPoints(hourly: HourlySummary[], prefs: Preferences): ChartPoint[] {
  return [...hourly]
    .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())
    .map((h) => ({
      label: formatHour(h.hour, prefs),
      ts: new Date(h.hour).getTime(),
      spanMs: 3_600_000,
      avg: h.avgResponseTime,
      p95: h.p95ResponseTime,
      p99: h.p99ResponseTime,
      fails: h.failCount,
      degraded: h.degradedCount,
    }));
}

// Daily summaries don't break out fail/degraded counts, so we roll up the
// matching hourlies. 7d + 30d both fetch enough hourly rows to cover the
// full range, so this is always populated.
function dailyToPoints(
  daily: DailySummary[],
  hourlies: HourlySummary[],
  prefs: Preferences,
): ChartPoint[] {
  return [...daily]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((d) => {
      const dayStart = new Date(d.date).getTime();
      const dayEnd = dayStart + 86_400_000;
      let fails = 0;
      let degraded = 0;
      for (const h of hourlies) {
        const hStart = new Date(h.hour).getTime();
        if (hStart >= dayStart && hStart < dayEnd) {
          fails += h.failCount;
          degraded += h.degradedCount;
        }
      }
      return {
        label: formatDateShort(d.date, prefs),
        ts: dayStart,
        spanMs: 86_400_000,
        avg: d.avgResponseTime,
        p95: d.p95ResponseTime,
        p99: d.p99ResponseTime,
        fails,
        degraded,
      };
    });
}


function rawChecksToRatePoints(checks: ApiCheck[], prefs: Preferences): PassRatePoint[] {
  return [...checks]
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    .map((c) => ({
      label: formatHour(c.timestamp, prefs),
      passRate: c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0,
      total: 1,
      success: c.status === "healthy" ? 1 : 0,
      fail: c.status === "down" ? 1 : 0,
      degraded: c.status === "degraded" ? 1 : 0,
      isPerCheck: true,
      status: c.status,
      source: "raw" as const,
    }));
}

function hourlyToRatePoints(hourly: HourlySummary[], prefs: Preferences): PassRatePoint[] {
  return [...hourly]
    .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())
    .map((h) => ({
      label: formatHour(h.hour, prefs),
      passRate: h.uptimePercent,
      total: h.totalChecks,
      success: h.successCount,
      fail: h.failCount,
      degraded: h.degradedCount,
      isPerCheck: false,
      source: "hourly" as const,
    }));
}

function dailyToRatePoints(daily: DailySummary[], prefs: Preferences): PassRatePoint[] {
  return [...daily]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((d) => {
      // Daily summaries don't break out success/fail/degraded counts, so
      // derive success from uptimePercent × totalChecks and fold the rest
      // into "fail" for the tooltip.
      const success = Math.round((d.uptimePercent / 100) * d.totalChecks);
      const fail = Math.max(0, d.totalChecks - success);
      return {
        label: formatDateShort(d.date, prefs),
        passRate: d.uptimePercent,
        total: d.totalChecks,
        success,
        fail,
        degraded: 0,
        isPerCheck: false,
        source: "daily" as const,
      };
    });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MetricsTabBase({
  endpointId,
  range,
  setRange,
  hourly24h,
  daily30d,
  latencyThreshold,
  incidents,
}: Props) {
  const { request } = useApi();
  const { prefs } = useFormat();
  const [rangeChecks, setRangeChecks] = useState<ApiCheck[]>([]);
  const [rangeHourly, setRangeHourly] = useState<HourlySummary[]>([]);
  const [rangeDaily, setRangeDaily] = useState<DailySummary[]>([]);
  const [loadingRange, setLoadingRange] = useState(false);
  const [visibleRefs, setVisibleRefs] = useState<Set<PercentileKey>>(
    () => new Set(DEFAULT_VISIBLE_REFS),
  );
  const [hoveredRef, setHoveredRef] = useState<PercentileKey | null>(null);
  const toggleRef = useCallback((key: PercentileKey) => {
    setVisibleRefs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Generation token — incremented each time fetchRange starts. In-flight
  // pagination loops and pending responses check this before committing
  // state, so switching 30d → 24h mid-fetch drops the stale 30d data
  // (which can easily be 10k+ raw checks) instead of letting it overwrite
  // the newer 24h window.
  const fetchGenRef = useRef(0);

  // Pulls every check whose timestamp falls inside the requested window by
  // walking the cursor pagination to exhaustion. The caller just names a
  // time range — the helper handles however many pages the server hands
  // back. Aborts early if the generation token has advanced.
  const fetchAllChecksSince = useCallback(
    async (fromMs: number, gen: number): Promise<ApiCheck[] | null> => {
      const fromIso = new Date(fromMs).toISOString();
      const all: ApiCheck[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 50; pages++) {
        if (fetchGenRef.current !== gen) return null;
        const params = new URLSearchParams({
          limit: "1000",
          from: fromIso,
        });
        if (cursor) params.set("cursor", cursor);
        const res = await request<{
          data: ApiCheck[];
          pagination?: { hasMore: boolean; nextCursor: string | null };
        }>(`/endpoints/${endpointId}/checks?${params.toString()}`);
        if (fetchGenRef.current !== gen) return null;
        if (res.status >= 400) break;
        all.push(...(res.data.data ?? []));
        const next = res.data.pagination?.nextCursor;
        if (!res.data.pagination?.hasMore || !next) break;
        cursor = next;
      }
      return all;
    },
    [endpointId, request],
  );

  const fetchRange = useCallback(async () => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoadingRange(true);
    // Clear previous window's data so the chart doesn't flash the old
    // range's points while the new fetch is in flight.
    setRangeChecks([]);
    if (range === "1h") {
      const checks = await fetchAllChecksSince(Date.now() - 3_600_000, gen);
      if (fetchGenRef.current !== gen || checks === null) return;
      setRangeChecks(checks);
      setRangeHourly([]);
      setRangeDaily([]);
    } else if (range === "24h") {
      // Keep hourly24h cached for the pass-rate + hour-of-day charts; the RT
      // chart itself is driven off raw checks so per-check failures show up
      // as reference areas.
      setRangeHourly(hourly24h);
      setRangeDaily([]);
      const checks = await fetchAllChecksSince(Date.now() - 86_400_000, gen);
      if (fetchGenRef.current !== gen || checks === null) return;
      setRangeChecks(checks);
    } else if (range === "7d") {
      const [dRes, hRes, checks] = await Promise.all([
        request<{ data: DailySummary[] }>(
          `/endpoints/${endpointId}/daily?limit=7`,
        ),
        request<{ data: HourlySummary[] }>(
          `/endpoints/${endpointId}/hourly?limit=168`,
        ),
        fetchAllChecksSince(Date.now() - 7 * 86_400_000, gen),
      ]);
      if (fetchGenRef.current !== gen || checks === null) return;
      setRangeDaily(dRes.status < 400 ? (dRes.data.data ?? []) : []);
      setRangeHourly(hRes.status < 400 ? (hRes.data.data ?? []) : []);
      setRangeChecks(checks);
    } else {
      setRangeDaily(daily30d.slice(-30));
      // 30d hour-of-day uses hourly summaries (720 = 30d × 24h) so every
      // time-of-day bucket is averaged across every day in the range.
      const [hRes, checks] = await Promise.all([
        request<{ data: HourlySummary[] }>(
          `/endpoints/${endpointId}/hourly?limit=720`,
        ),
        fetchAllChecksSince(Date.now() - 30 * 86_400_000, gen),
      ]);
      if (fetchGenRef.current !== gen || checks === null) return;
      setRangeHourly(hRes.status < 400 ? (hRes.data.data ?? []) : []);
      setRangeChecks(checks);
    }
    if (fetchGenRef.current === gen) setLoadingRange(false);
  }, [range, endpointId, request, hourly24h, daily30d, fetchAllChecksSince]);

  useEffect(() => {
    void fetchRange();
  }, [fetchRange]);

  // ── RT chart data + percentiles ────────────────────────────────────────
  // 1h + 24h render every raw check so per-check failures (single flaky
  // checks that never become incidents) still show up as shaded reference
  // areas. 24h at one-check-per-minute is ~1440 points, comfortably within
  // recharts' render budget.
  const rtData = useMemo<ChartPoint[]>(() => {
    if (range === "1h" || range === "24h") return rawChecksToPoints(rangeChecks, prefs);
    if (range === "7d") {
      const pts = dailyToPoints(rangeDaily, rangeHourly, prefs);
      if (pts.length >= 3) return pts;
      return hourlyToPoints(rangeHourly, prefs);
    }
    return dailyToPoints(rangeDaily, rangeHourly, prefs);
  }, [range, rangeChecks, rangeHourly, rangeDaily, prefs]);

  // ── Incident overlays on the RT chart ──────────────────────────────────
  // Severity per bucket is folded from three sources:
  //   1. the aggregated counts already on the point (failCount/degradedCount
  //      for hourly/daily rollups)
  //   2. every raw check whose timestamp falls inside the bucket window
  //      (catches single flaky checks that never become incidents)
  //   3. the authoritative incidents list from the server (catches non-check
  //      incidents like ssl_expiring where all checks are 'healthy')
  //
  // Source (3) is especially important for the 24h view: if a user sees an
  // incident on the Incidents tab but no raw check has status='down', only
  // the incident window itself anchors the overlay. Contiguous buckets of
  // the same severity collapse into one range; the end label points to the
  // *next* bucket so the shade spans the full failing window.
  const incidentOverlays = useMemo((): IncidentRange[] => {
    if (rtData.length === 0) return [];

    const spanMs = rtData[0].spanMs;
    const severity = new Array<0 | 1 | 2>(rtData.length).fill(0);
    const rank = (n: number) => (n >= 2 ? 2 : n >= 1 ? 1 : 0) as 0 | 1 | 2;

    // 1. Aggregated counts on the chart point (hourly/daily rollups).
    for (let i = 0; i < rtData.length; i++) {
      const p = rtData[i];
      if (p.fails > 0) severity[i] = 2;
      else if (p.degraded > 0) severity[i] = rank(Math.max(severity[i], 1));
    }

    // Precompute bucket ranges for index lookup by timestamp.
    const chartStart = rtData[0].ts;
    const chartEnd = rtData[rtData.length - 1].ts + spanMs;
    const findBucket = (tsMs: number): number => {
      if (tsMs < chartStart || tsMs >= chartEnd) return -1;
      for (let i = 0; i < rtData.length; i++) {
        if (tsMs >= rtData[i].ts && tsMs < rtData[i].ts + spanMs) return i;
      }
      return -1;
    };

    // 2. Raw-check statuses.
    for (const c of rangeChecks) {
      if (c.status === "healthy") continue;
      const idx = findBucket(new Date(c.timestamp).getTime());
      if (idx < 0) continue;
      const sev: 1 | 2 = c.status === "down" ? 2 : 1;
      if (sev > severity[idx]) severity[idx] = sev;
    }

    // 3. Incident windows. An incident is treated as 'down' severity if its
    // cause is a hard failure (down / port_closed / body_mismatch /
    // ssl_expired) and 'degraded' otherwise (high_latency / ssl_expiring /
    // degraded). Open incidents (resolvedAt missing) extend to "now".
    const CRITICAL_CAUSES = new Set([
      "endpoint_down",
      "port_closed",
      "body_mismatch",
      "ssl_expired",
    ]);
    const nowMs = Date.now();
    for (const inc of incidents) {
      const start = new Date(inc.startedAt).getTime();
      const end = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : nowMs;
      if (end < chartStart || start >= chartEnd) continue;
      const sev: 1 | 2 = CRITICAL_CAUSES.has(inc.cause) ? 2 : 1;
      const clampedStart = Math.max(start, chartStart);
      const clampedEnd = Math.min(end, chartEnd - 1);
      // Mark every bucket the incident overlaps.
      for (let i = 0; i < rtData.length; i++) {
        const bucketStart = rtData[i].ts;
        const bucketEnd = bucketStart + spanMs;
        if (bucketEnd <= clampedStart || bucketStart > clampedEnd) continue;
        if (sev > severity[i]) severity[i] = sev;
      }
    }

    // Run-length encode severity into labelled ranges.
    const ranges: IncidentRange[] = [];
    let i = 0;
    while (i < rtData.length) {
      if (severity[i] === 0) {
        i++;
        continue;
      }
      const cur = severity[i];
      let j = i;
      while (j + 1 < rtData.length && severity[j + 1] === cur) j++;
      const x1 = rtData[i].label;
      const x2 =
        j + 1 < rtData.length ? rtData[j + 1].label : rtData[j].label;
      ranges.push({ x1, x2, type: cur === 2 ? "down" : "degraded" });
      i = j + 1;
    }

    return ranges;
  }, [rtData, rangeChecks, incidents]);

  const percentiles = useMemo(() => {
    const raw = rangeChecks
      .map((c) => c.responseTime)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (raw.length > 0) {
      return {
        min: raw[0],
        max: raw[raw.length - 1],
        avg: Math.round(raw.reduce((s, v) => s + v, 0) / raw.length),
        p50: percentile(raw, 50),
        p95: percentile(raw, 95),
        p99: percentile(raw, 99),
      };
    }
    // Fallback from aggregates when we don't have raw checks.
    if (rtData.length > 0) {
      const avgs = rtData.map((p) => p.avg);
      const p95s = rtData.map((p) => p.p95).filter((v) => v > 0);
      const p99s = rtData.map((p) => p.p99).filter((v) => v > 0);
      return {
        min: Math.min(...avgs),
        max: Math.max(...avgs),
        avg: Math.round(avgs.reduce((s, v) => s + v, 0) / avgs.length),
        p50: avgs[Math.floor(avgs.length / 2)],
        p95: p95s.length
          ? Math.round(p95s.reduce((s, v) => s + v, 0) / p95s.length)
          : 0,
        p99: p99s.length
          ? Math.round(p99s.reduce((s, v) => s + v, 0) / p99s.length)
          : 0,
      };
    }
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }, [rangeChecks, rtData]);

  // ── Histogram (latency distribution) ───────────────────────────────────
  // Adaptive buckets: step sized from the actual min/max so tightly-clustered
  // samples (e.g. a localhost endpoint consistently <100ms) still spread
  // across the chart instead of collapsing into one bar.
  //
  // Down checks are excluded — their responseTime is typically 0 (connection
  // refused) or a timeout, which is a failure signal, not latency data.
  // Including them would skew the distribution and create misleading outlier
  // bars. The excluded count is surfaced in the section subtitle so the
  // sample count isn't silently misleading.
  const { buckets: histogram, excludedDown } = useMemo(() => {
    if (rangeChecks.length === 0) {
      return { buckets: [], excludedDown: 0 };
    }
    const healthy = rangeChecks.filter((c) => c.status !== "down");
    const excluded = rangeChecks.length - healthy.length;
    const values = healthy
      .map((c) => c.responseTime)
      .filter((v) => v >= 0);
    if (values.length === 0) {
      return { buckets: [], excludedDown: excluded };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const TARGET_BUCKETS = 7;
    const rawStep = (range > 0 ? range : Math.max(max, 1)) / TARGET_BUCKETS;
    const step = niceStep(rawStep);
    const start = Math.floor(min / step) * step;
    const bucketCount = Math.max(1, Math.floor((max - start) / step) + 1);
    const counts = new Array<number>(bucketCount).fill(0);
    for (const v of values) {
      const idx = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((v - start) / step)),
      );
      counts[idx]++;
    }
    const total = values.length;
    const buckets = counts.map((count, i) => {
      const lo = start + i * step;
      const hi = lo + step;
      return {
        label: `${formatMs(lo)}-${formatMs(hi)}`,
        count,
        lo,
        hi,
        pct: total > 0 ? (count / total) * 100 : 0,
        fill:
          hi <= latencyThreshold
            ? "var(--wd-success)"
            : lo < latencyThreshold
              ? "var(--wd-primary)"
              : "var(--wd-warning)",
      };
    });
    return { buckets, excludedDown: excluded };
  }, [rangeChecks, latencyThreshold]);

  // ── Check pass rate over range ─────────────────────────────────────────
  // Mirrors rtData's source selection but pulls from success/fail counts so
  // the tooltip can show pass/total, not just the rate.
  const passRateData = useMemo<PassRatePoint[]>(() => {
    if (range === "1h") return rawChecksToRatePoints(rangeChecks, prefs);
    if (range === "24h") {
      const pts = hourlyToRatePoints(rangeHourly, prefs);
      if (pts.length >= 4) return pts;
      return rawChecksToRatePoints(rangeChecks, prefs);
    }
    if (range === "7d") {
      const pts = dailyToRatePoints(rangeDaily, prefs);
      if (pts.length >= 3) return pts;
      return hourlyToRatePoints(rangeHourly, prefs);
    }
    return dailyToRatePoints(rangeDaily, prefs);
  }, [range, rangeChecks, rangeHourly, rangeDaily, prefs]);

  // Zoom the Y domain when all points are high so sub-percent dips remain
  // visible instead of flattening against the top. The per-check stairstep
  // (1h raw) always uses 0-100 so the 0/50/100 states read cleanly.
  const passRateDomain = useMemo<[number, number]>(() => {
    if (passRateData.length === 0 || range === "1h") return [0, 100];
    const min = Math.min(...passRateData.map((p) => p.passRate));
    return min >= 95 ? [90, 100] : [0, 100];
  }, [passRateData, range]);

  const passTotals = useMemo(() => {
    const total = passRateData.reduce((s, p) => s + p.total, 0);
    const success = passRateData.reduce((s, p) => s + p.success, 0);
    return {
      total,
      success,
      pct: total > 0 ? (success / total) * 100 : null,
    };
  }, [passRateData]);

  // ── Hour of day latency (8 × 3-hour buckets) ────────────────────────────
  // Derived from hourly summaries so the full range is represented — raw
  // checks get truncated by the API's row limit on long ranges. 1h falls back
  // to 24h hourlies because a single hour can't populate time-of-day buckets.
  // For 7d/30d each bucket is a weighted average across every day's matching
  // hours, answering "when of day is this endpoint slowest?".
  const hourOfDay = useMemo(() => {
    const hourlies =
      range === "1h" || range === "24h" ? hourly24h : rangeHourly;
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      label: `${String(i * 3).padStart(2, "0")}-${String(i * 3 + 3).padStart(2, "0")}`,
      weightedSum: 0,
      samples: 0,
    }));
    for (const h of hourlies) {
      const hour = new Date(h.hour).getHours();
      const idx = Math.min(7, Math.floor(hour / 3));
      buckets[idx].weightedSum += h.avgResponseTime * h.totalChecks;
      buckets[idx].samples += h.totalChecks;
    }
    return buckets.map((b) => {
      const avg = b.samples > 0 ? Math.round(b.weightedSum / b.samples) : 0;
      return {
        label: b.label,
        avg,
        samples: b.samples,
        fill:
          b.samples === 0
            ? "var(--wd-border)"
            : avg > latencyThreshold
              ? "var(--wd-warning)"
              : "var(--wd-primary)",
      };
    });
  }, [range, hourly24h, rangeHourly, latencyThreshold]);

  const hasRtData = rtData.length > 0;
  const hasHistogramData = histogram.some((b) => b.count > 0);
  const hasHourData = hourOfDay.some((b) => b.samples > 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <div className="xl:col-span-2 rounded-xl border border-wd-border/50 bg-wd-surface p-4">
        <SectionHead
          icon="solar:pulse-2-linear"
          title="Response time"
          sub={`${rtData.length} ${rtData.length === 1 ? "sample" : "samples"} · last ${range}`}
          right={
            <Segmented<MetricsRange>
              options={[
                { key: "1h", label: "1h" },
                { key: "24h", label: "24h" },
                { key: "7d", label: "7d" },
                { key: "30d", label: "30d" },
              ]}
              value={range}
              onChange={setRange}
              ariaLabel="Metrics range"
            />
          }
        />
        <div className="flex mt-2 gap-3">
          <div className="flex-1 h-[260px] min-w-0">
            {loadingRange ? (
              <ChartSkeleton />
            ) : hasRtData ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={rtData}
                  margin={{ top: 10, right: 32, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="rtGradMetrics"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--wd-primary)"
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--wd-primary)"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="var(--wd-border)"
                    strokeOpacity={0.3}
                    strokeDasharray="2 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{
                      fontSize: 10,
                      fill: "var(--wd-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{
                      fontSize: 10,
                      fill: "var(--wd-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                    tickFormatter={(v) =>
                      v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                    }
                  />
                  <RechartsTooltip
                    content={
                      <RtTooltip
                        visibleRefs={visibleRefs}
                        percentiles={percentiles}
                      />
                    }
                    cursor={{
                      stroke: "var(--wd-muted)",
                      strokeWidth: 1,
                      strokeDasharray: "3 3",
                    }}
                  />
                  <ReferenceLine
                    y={latencyThreshold}
                    stroke="var(--wd-warning)"
                    strokeDasharray="4 3"
                    strokeOpacity={0.5}
                    label={{
                      value: `threshold ${latencyThreshold}ms`,
                      position: "insideTopRight",
                      fill: "var(--wd-warning)",
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  {PERCENTILE_ROWS.map((row) => {
                    if (!visibleRefs.has(row.key)) return null;
                    if (percentiles[row.key] <= 0) return null;
                    const isHovered = hoveredRef === row.key;
                    const somethingElseHovered =
                      hoveredRef !== null && !isHovered;
                    return (
                      <ReferenceLine
                        key={row.key}
                        y={percentiles[row.key]}
                        stroke={row.color}
                        strokeDasharray={row.dash}
                        strokeWidth={isHovered ? 1.8 : 1}
                        strokeOpacity={
                          isHovered ? 1 : somethingElseHovered ? 0.18 : 0.7
                        }
                        ifOverflow="extendDomain"
                        label={{
                          value: `${row.label} · ${percentiles[row.key]}ms`,
                          position: row.labelPos,
                          fill: row.color,
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          fontWeight: isHovered ? 600 : 400,
                          fillOpacity: somethingElseHovered ? 0.3 : 1,
                        }}
                      />
                    );
                  })}
                  <Area
                    dataKey="avg"
                    stroke="var(--wd-primary)"
                    strokeWidth={1.4}
                    fill="url(#rtGradMetrics)"
                    type="monotone"
                  />
                  {incidentOverlays.length > 0 && (
                    <ForegroundReferenceArea ranges={incidentOverlays} />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart label="No response time samples in this range" />
            )}
          </div>
          <div
            className="shrink-0 w-[224px] grid grid-cols-2 grid-rows-3 border-l border-wd-border/40"
            role="group"
            aria-label="Percentile reference lines"
          >
            {PERCENTILE_ROWS.map((row, i) => {
              const on = visibleRefs.has(row.key);
              const col = i % 2;
              const rowIdx = Math.floor(i / 2);
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => toggleRef(row.key)}
                  onMouseEnter={() => on && setHoveredRef(row.key)}
                  onMouseLeave={() =>
                    setHoveredRef((curr) => (curr === row.key ? null : curr))
                  }
                  onFocus={() => on && setHoveredRef(row.key)}
                  onBlur={() =>
                    setHoveredRef((curr) => (curr === row.key ? null : curr))
                  }
                  aria-pressed={on}
                  title={on ? `Hide ${row.label} line` : `Show ${row.label} line`}
                  className={cn(
                    "group relative text-left flex flex-col justify-start gap-1.5 px-3 py-2.5 overflow-hidden cursor-pointer",
                    "transition-colors hover:bg-wd-surface-hover/40",
                    col === 0 && "border-r border-wd-border/40",
                    rowIdx < 2 && "border-b border-wd-border/40",
                  )}
                >
                  <span className="flex items-center justify-between gap-1.5 text-[10px] font-medium uppercase tracking-wide text-wd-muted">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        aria-hidden
                        className="inline-block h-[2px] w-3.5 rounded-full transition-opacity"
                        style={{
                          backgroundColor: row.color,
                          opacity: on ? 1 : 0.28,
                        }}
                      />
                      <span className={cn(on ? "" : "text-wd-muted/70")}>
                        {row.label}
                      </span>
                    </span>
                    <Icon
                      aria-hidden
                      icon={on ? "solar:eye-linear" : "solar:eye-closed-linear"}
                      width={13}
                      className={cn(
                        "shrink-0 transition-colors",
                        on
                          ? "text-wd-muted group-hover:text-foreground"
                          : "text-wd-muted/50 group-hover:text-wd-muted",
                      )}
                    />
                  </span>
                  <span className="text-[18px] font-mono font-semibold tabular-nums text-foreground leading-none">
                    {percentiles[row.key]}
                    <span className="text-[11px] font-normal text-wd-muted ml-1">
                      ms
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
        <SectionHead
          icon="solar:chart-square-linear"
          title="Latency distribution"
          sub={(() => {
            const included = histogram.reduce((s, b) => s + b.count, 0);
            const base = `Histogram · ${included} ${included === 1 ? "sample" : "samples"}`;
            if (excludedDown === 0) return base;
            return `${base} · ${excludedDown} failed ${excludedDown === 1 ? "check" : "checks"} excluded`;
          })()}
        />
        <div className="h-[220px]">
          {loadingRange ? (
            <ChartSkeleton />
          ) : hasHistogramData ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={histogram}
                margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="var(--wd-border)"
                  strokeOpacity={0.25}
                  strokeDasharray="2 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <RechartsTooltip
                  content={<HistogramTooltip threshold={latencyThreshold} />}
                  cursor={{ fill: "var(--wd-surface-hover)", opacity: 0.55 }}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {histogram.map((b) => (
                    <Cell key={b.label} fill={b.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="Not enough samples in this range" />
          )}
        </div>
      </div>

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
        <SectionHead
          icon="solar:checklist-minimalistic-linear"
          title="Check pass rate"
          sub={
            passTotals.pct != null
              ? `${passTotals.pct.toFixed(2)}% · ${passTotals.success}/${passTotals.total} passed · last ${range}${passRateDomain[0] > 0 ? " · zoomed" : ""}`
              : `Last ${range}`
          }
        />
        <div className="h-[220px]">
          {loadingRange ? (
            <ChartSkeleton />
          ) : passRateData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={passRateData}
                margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient
                    id="passGradMetrics"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor="var(--wd-success)"
                      stopOpacity={0.32}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--wd-success)"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="var(--wd-border)"
                  strokeOpacity={0.25}
                  strokeDasharray="2 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={48}
                />
                <YAxis
                  domain={passRateDomain}
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  tickFormatter={(v) => `${v}%`}
                />
                <RechartsTooltip
                  content={<PassRateTooltip />}
                  cursor={{
                    stroke: "var(--wd-muted)",
                    strokeWidth: 1,
                    strokeDasharray: "3 3",
                  }}
                />
                <ReferenceLine
                  y={99}
                  stroke="var(--wd-success)"
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                  label={{
                    value: "99%",
                    position: "insideTopRight",
                    fill: "var(--wd-success)",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                  }}
                />
                <Area
                  dataKey="passRate"
                  stroke="var(--wd-success)"
                  strokeWidth={1.4}
                  fill="url(#passGradMetrics)"
                  type="monotone"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="No data in this range" />
          )}
        </div>
      </div>

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 xl:col-span-2">
        <SectionHead
          icon="solar:clock-circle-linear"
          title="Latency by hour of day"
          sub={(() => {
            const effective = range === "1h" ? "24h" : range;
            const note = range === "1h" ? " (1h range too short)" : "";
            return `8 × 3-hour buckets · averaged across last ${effective}${note}`;
          })()}
        />
        <div className="h-[220px]">
          {loadingRange ? (
            <ChartSkeleton />
          ) : hasHourData ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={hourOfDay}
                margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="var(--wd-border)"
                  strokeOpacity={0.25}
                  strokeDasharray="2 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{
                    fontSize: 10,
                    fill: "var(--wd-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickFormatter={(v) =>
                    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                  }
                />
                <RechartsTooltip
                  content={<HourTooltip threshold={latencyThreshold} />}
                  cursor={{ fill: "var(--wd-surface-hover)", opacity: 0.55 }}
                />
                <ReferenceLine
                  y={latencyThreshold}
                  stroke="var(--wd-warning)"
                  strokeDasharray="4 3"
                  strokeOpacity={0.5}
                />
                <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                  {hourOfDay.map((b) => (
                    <Cell key={b.label} fill={b.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="No hour-of-day samples yet" />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltips
//
// Shared style matches the chart tooltips on the Incidents and Notifications
// pages (NotificationCharts.tsx ChartTooltip / IncidentExtras VolumeTooltip):
//   • rounded-lg shell, shadow-lg, flex-col with 1.5 gap
//   • uppercase-mono header separated by a 1px border
//   • each row is `swatch · muted label — mono value` with optional coloring
//     on the value so semantic detail (success / warning / danger) jumps out
// ---------------------------------------------------------------------------

const TOOLTIP_SHELL =
  "rounded-lg border border-wd-border bg-wd-surface shadow-lg px-3 py-2.5 text-[11px] flex flex-col gap-1.5 min-w-[200px]";

function TooltipHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-wd-muted/80 font-mono border-b border-wd-border/50 pb-1.5">
      {children}
    </div>
  );
}

function TooltipRow({
  color,
  label,
  suffix,
  value,
  unit,
  valueColor,
}: {
  color?: string;
  label: string;
  suffix?: React.ReactNode;
  value: React.ReactNode;
  unit?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-wd-muted min-w-0">
        {color ? (
          <span
            aria-hidden
            className="w-2 h-2 rounded-sm shrink-0"
            style={{ background: color }}
          />
        ) : null}
        <span className="truncate">{label}</span>
        {suffix}
      </span>
      <span
        className="font-mono font-medium tabular-nums shrink-0"
        style={{ color: valueColor ?? "var(--foreground)" }}
      >
        {value}
        {unit && (
          <span className="text-wd-muted font-normal ml-0.5">{unit}</span>
        )}
      </span>
    </div>
  );
}

function RtTooltip({
  active,
  payload,
  label,
  visibleRefs,
  percentiles,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; payload: ChartPoint }>;
  label?: string;
  visibleRefs?: Set<PercentileKey>;
  percentiles?: Record<PercentileKey, number>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const shown = visibleRefs
    ? PERCENTILE_ROWS.filter((r) => visibleRefs.has(r.key))
    : PERCENTILE_ROWS;
  const rows = shown.map((r) => {
    const isPerPoint = PER_POINT_KEYS.has(r.key);
    const perPoint = isPerPoint
      ? (point[r.key as "avg" | "p95" | "p99"] ?? 0)
      : 0;
    const value = isPerPoint ? perPoint : (percentiles?.[r.key] ?? 0);
    return { ...r, value, isPerPoint };
  });
  if (rows.length === 0) return null;
  return (
    <div className={TOOLTIP_SHELL}>
      <TooltipHeader>{label}</TooltipHeader>
      {rows.map((r) => (
        <TooltipRow
          key={r.key}
          color={r.color}
          label={r.label}
          suffix={
            !r.isPerPoint ? (
              <span className="text-[9.5px] uppercase tracking-wide text-wd-muted/60">
                overall
              </span>
            ) : null
          }
          value={r.value}
          unit="ms"
          valueColor={r.color}
        />
      ))}
    </div>
  );
}

function PassRateTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: PassRatePoint }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  // Per-check points → raw status color. Rollups → pass-rate color using the
  // same 99/95 thresholds the KPI card uses, so the two read consistently.
  const headlineColor = p.isPerCheck
    ? p.status === "healthy"
      ? "var(--wd-success)"
      : p.status === "degraded"
        ? "var(--wd-warning)"
        : "var(--wd-danger)"
    : p.passRate >= 99
      ? "var(--wd-success)"
      : p.passRate >= 95
        ? "var(--wd-warning)"
        : "var(--wd-danger)";
  const sourceLabel =
    p.source === "raw"
      ? "Single check"
      : p.source === "hourly"
        ? "Hourly rollup"
        : "Daily rollup";
  return (
    <div className={TOOLTIP_SHELL}>
      <TooltipHeader>{label}</TooltipHeader>
      <TooltipRow
        color={headlineColor}
        label={p.isPerCheck ? "Status" : "Pass rate"}
        value={p.isPerCheck && p.status ? p.status : `${p.passRate.toFixed(2)}%`}
        valueColor={headlineColor}
      />
      {!p.isPerCheck && (
        <>
          <TooltipRow
            color="var(--wd-success)"
            label="Passed"
            value={
              <>
                {p.success}
                <span className="text-wd-muted font-normal">/{p.total}</span>
              </>
            }
            valueColor="var(--wd-success)"
          />
          {p.fail > 0 && (
            <TooltipRow
              color="var(--wd-danger)"
              label="Failed"
              value={p.fail}
              valueColor="var(--wd-danger)"
            />
          )}
          {p.degraded > 0 && (
            <TooltipRow
              color="var(--wd-warning)"
              label="Degraded"
              value={p.degraded}
              valueColor="var(--wd-warning)"
            />
          )}
        </>
      )}
      <div className="pt-1.5 border-t border-wd-border/50 text-[10px] uppercase tracking-wider font-mono text-wd-muted/80">
        {sourceLabel}
      </div>
    </div>
  );
}

function HistogramTooltip({
  active,
  payload,
  threshold,
}: {
  active?: boolean;
  payload?: Array<{
    payload: { lo: number; hi: number; count: number; pct: number };
  }>;
  threshold: number;
}) {
  if (!active || !payload?.length) return null;
  const { lo, hi, count, pct } = payload[0].payload;
  const bucketLabel = `${formatMs(lo)} – ${formatMs(hi)}`;
  const band =
    hi <= threshold
      ? { text: "Under threshold", color: "var(--wd-success)" }
      : lo < threshold
        ? { text: "Straddles threshold", color: "var(--wd-primary)" }
        : { text: "Over threshold", color: "var(--wd-warning)" };
  return (
    <div className={TOOLTIP_SHELL}>
      <TooltipHeader>{`Latency ${bucketLabel}`}</TooltipHeader>
      <TooltipRow
        color={band.color}
        label="Checks"
        value={count}
        valueColor={band.color}
      />
      <TooltipRow
        color="var(--wd-muted)"
        label="Share"
        value={`${pct.toFixed(1)}%`}
        valueColor={band.color}
      />
      <div className="pt-1.5 border-t border-wd-border/50 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider font-mono">
        <span className="font-semibold" style={{ color: band.color }}>
          {band.text}
        </span>
        <span className="text-wd-muted/80">{formatMs(threshold)}</span>
      </div>
    </div>
  );
}

function HourTooltip({
  active,
  payload,
  label,
  threshold,
}: {
  active?: boolean;
  payload?: Array<{ payload: { avg: number; samples: number } }>;
  label?: string;
  threshold: number;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const hasSamples = p.samples > 0;
  const avgColor = !hasSamples
    ? "var(--wd-muted)"
    : p.avg > threshold
      ? "var(--wd-warning)"
      : "var(--wd-primary)";
  return (
    <div className={TOOLTIP_SHELL}>
      <TooltipHeader>
        {label ? `${label} local time` : "Hour of day"}
      </TooltipHeader>
      {!hasSamples ? (
        <div className="text-[11px] text-wd-muted">
          No samples in this window
        </div>
      ) : (
        <>
          <TooltipRow
            color={avgColor}
            label="Average"
            value={p.avg}
            unit="ms"
            valueColor={avgColor}
          />
          <TooltipRow
            color="var(--wd-muted)"
            label="Samples"
            value={p.samples}
          />
        </>
      )}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-[12px] text-wd-muted gap-2">
      <Icon icon="solar:chart-square-outline" width={16} />
      {label}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      className={cn(
        "h-full w-full rounded-md animate-pulse",
        "bg-wd-surface-hover/60",
      )}
    />
  );
}

export default memo(MetricsTabBase);
