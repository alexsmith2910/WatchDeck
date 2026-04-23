/**
 * 5 KPI cards shown below the hero:
 *   1. Response Time · 1h (wired — avg + per-check spark from last-hour checks)
 *   2. Check Pass Rate · 24h (wired — derived from hourly summaries)
 *   3. Downtime · Nd (wired — incident duration ∩ SLO window, cum. budget spark)
 *   4. Active Incident / Time Since Incident (wired from incidents list)
 *   5. SSL Certificate (wired — time remaining + issuer from endpoint state)
 *
 * Cards follow the vertical pattern used on Incidents / Notifications pages:
 * icon + title → value + delta → full-bleed sparkline at the bottom.
 */
import { memo, useMemo } from "react";
import { cn } from "@heroui/react";
import type {
  ApiCheck,
  ApiEndpoint,
  ApiIncident,
  DailySummary,
  HourlySummary,
} from "../../types/api";
import { formatDuration } from "../../utils/format";
import { WideSpark } from "../health/HealthCharts";
import { useSlo } from "../../hooks/useSlo";
import { useFormat } from "../../hooks/useFormat";
import { Icon } from "@iconify/react";

type Tone = "primary" | "success" | "warning" | "danger" | "muted";

function tileClass(tone: Tone): string {
  switch (tone) {
    case "primary": return "bg-wd-primary/15 text-wd-primary";
    case "success": return "bg-wd-success/15 text-wd-success";
    case "warning": return "bg-wd-warning/15 text-wd-warning";
    case "danger":  return "bg-wd-danger/15 text-wd-danger";
    case "muted":   return "bg-wd-muted/15 text-wd-muted";
  }
}

function toneStroke(tone: Tone): string {
  switch (tone) {
    case "primary": return "var(--wd-primary)";
    case "success": return "var(--wd-success)";
    case "warning": return "var(--wd-warning)";
    case "danger":  return "var(--wd-danger)";
    case "muted":   return "var(--wd-muted)";
  }
}

/**
 * Compact time-until-expiry for the SSL KPI: days under ~2 months, months up
 * to ~2 years, years beyond. Values ≤0 surface as "0d" (expired/today).
 */
function formatSslRemaining(days: number): string {
  if (days <= 0) return "0d";
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

function deltaClass(tone: Tone): string {
  switch (tone) {
    case "success": return "text-wd-success";
    case "warning": return "text-wd-warning";
    case "danger":  return "text-wd-danger";
    case "primary": return "text-wd-primary";
    case "muted":   return "text-wd-muted";
  }
}

interface Props {
  endpoint: ApiEndpoint;
  latestCheck: ApiCheck | null;
  hourly24h: HourlySummary[];
  daily30d: DailySummary[];
  lastHourChecks: ApiCheck[];
  incidents: ApiIncident[];
}

function sortedHourly(hourly: HourlySummary[]): HourlySummary[] {
  return [...hourly]
    .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())
    .slice(-24);
}


function EndpointKpiStripBase({
  endpoint,
  latestCheck,
  hourly24h,
  daily30d,
  lastHourChecks,
  incidents,
}: Props) {
  const { slo } = useSlo();
  const fmt = useFormat();
  const liveStatus = latestCheck?.status ?? endpoint.lastStatus ?? "healthy";

  const sortedHr = useMemo(() => sortedHourly(hourly24h), [hourly24h]);
  const sparkLabels = useMemo(
    () => sortedHr.map((h) => fmt.hour(h.hour)),
    [sortedHr, fmt],
  );
  const successSpark = useMemo(() => sortedHr.map((h) => h.uptimePercent), [sortedHr]);

  // ── Response time · 1h — avg + per-check spark from last-hour raw checks ─
  const lastHourSorted = useMemo(
    () =>
      [...lastHourChecks].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    [lastHourChecks],
  );
  const rtSpark = useMemo(
    () => lastHourSorted.map((c) => c.responseTime),
    [lastHourSorted],
  );
  const rtSparkLabels = useMemo(
    () => lastHourSorted.map((c) => fmt.hour(c.timestamp)),
    [lastHourSorted, fmt],
  );
  const avg1hLatency = useMemo(() => {
    if (lastHourSorted.length === 0) return null;
    const total = lastHourSorted.reduce((s, c) => s + c.responseTime, 0);
    return Math.round(total / lastHourSorted.length);
  }, [lastHourSorted]);
  const displayLatency =
    avg1hLatency ??
    latestCheck?.responseTime ??
    endpoint.lastResponseTime ??
    null;

  // ── Downtime / error budget over the SLO window ───────────────────────────
  // Downtime = sum of incident durations intersecting the last N days.
  // Budget-used % = downtime ÷ allowable downtime. Both the value and the
  // budget% are derived from the same incident-duration source so they stay
  // consistent — check-count aggregates diverge badly when only a few days
  // have data.
  const sloAllowable = Math.max(1e-9, (100 - slo.target) / 100);

  // SLO target expressed as allowable downtime in seconds over the window.
  const budgetAllowableSecs = Math.max(
    1,
    Math.floor(sloAllowable * slo.windowDays * 86_400),
  );

  const sortedDaily = useMemo(
    () =>
      [...daily30d]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-slo.windowDays),
    [daily30d, slo.windowDays],
  );

  // Downtime over the window — sum incident durations that intersect it.
  const downtime30d = useMemo(() => {
    const now = Date.now();
    const windowStart = now - slo.windowDays * 86_400_000;
    let totalMs = 0;
    for (const inc of incidents) {
      const start = new Date(inc.startedAt).getTime();
      const end = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : now;
      if (end < windowStart) continue;
      totalMs += end - Math.max(start, windowStart);
    }
    return Math.max(0, Math.floor(totalMs / 1000));
  }, [incidents, slo.windowDays]);

  const budgetUsedPct = useMemo(
    () => (downtime30d / budgetAllowableSecs) * 100,
    [downtime30d, budgetAllowableSecs],
  );

  // Cumulative budget-used % per day across the window — monotonic, derived
  // from cumulative incident downtime so the spark agrees with the value and
  // label. Clamped to 100 for chart stability once the budget is blown.
  const budgetSpark = useMemo(() => {
    if (sortedDaily.length === 0) return [] as number[];
    const now = Date.now();
    const windowStart = now - slo.windowDays * 86_400_000;
    return sortedDaily.map((d) => {
      const dayEnd = Math.min(
        new Date(d.date).getTime() + 86_400_000,
        now,
      );
      let totalMs = 0;
      for (const inc of incidents) {
        const start = new Date(inc.startedAt).getTime();
        const end = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : now;
        if (end < windowStart || start > dayEnd) continue;
        const s = Math.max(start, windowStart);
        const e = Math.min(end, dayEnd);
        if (e > s) totalMs += e - s;
      }
      const secs = Math.floor(totalMs / 1000);
      return Math.min(100, (secs / budgetAllowableSecs) * 100);
    });
  }, [sortedDaily, incidents, slo.windowDays, budgetAllowableSecs]);

  const budgetSparkLabels = useMemo(
    () => sortedDaily.map((d) => fmt.dateShort(d.date)),
    [sortedDaily, fmt],
  );

  const downtimeTone: Tone =
    downtime30d === 0
      ? "success"
      : budgetUsedPct >= 100
        ? "danger"
        : budgetUsedPct >= 75
          ? "warning"
          : "primary";

  // Check pass rate · 24h — successCount ÷ totalChecks from hourly summaries.
  const pass24h = useMemo(() => {
    if (hourly24h.length === 0) return null;
    const total = hourly24h.reduce((s, h) => s + h.totalChecks, 0);
    if (total === 0) return null;
    const success = hourly24h.reduce((s, h) => s + h.successCount, 0);
    return { pct: (success / total) * 100, pass: success, total };
  }, [hourly24h]);

  // Time since last incident — look at resolved incidents for this endpoint
  const timeSince = useMemo(() => {
    const active = incidents.find((i) => i.status === "active");
    if (active) {
      const mins = Math.floor(
        (Date.now() - new Date(active.startedAt).getTime()) / 60000,
      );
      return {
        active: true,
        value: formatDuration(mins * 60),
        sub: "incident in progress",
      };
    }
    const resolved = incidents
      .filter((i) => i.status === "resolved" && i.resolvedAt)
      .sort(
        (a, b) =>
          new Date(b.resolvedAt!).getTime() - new Date(a.resolvedAt!).getTime(),
      );
    if (resolved.length === 0)
      return { active: false, value: "∞", sub: "no incidents on record" };
    const secs = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(resolved[0].resolvedAt!).getTime()) / 1000,
      ),
    );
    return {
      active: false,
      value: formatDuration(secs),
      sub: `since ${fmt.date(resolved[0].resolvedAt!)}`,
    };
  }, [incidents, fmt]);

  const sslDays = latestCheck?.sslDaysRemaining ?? null;
  const sslTone: Tone =
    sslDays == null
      ? "muted"
      : sslDays < endpoint.sslWarningDays / 2
        ? "danger"
        : sslDays < endpoint.sslWarningDays
          ? "warning"
          : "success";
  const sslValue = sslDays == null ? "—" : formatSslRemaining(sslDays);
  const sslIssuer = endpoint.lastSslIssuer;
  const sslIssuerLabel =
    sslIssuer && (sslIssuer.cn ?? sslIssuer.o)
      ? `issuer ${sslIssuer.cn ?? sslIssuer.o}`
      : "issuer —";

  const rtTone: Tone =
    liveStatus === "down"
      ? "danger"
      : liveStatus === "degraded"
        ? "warning"
        : displayLatency != null && displayLatency >= endpoint.latencyThreshold
          ? "warning"
          : "primary";

  const passTone: Tone =
    pass24h == null
      ? "muted"
      : pass24h.pct >= 99
        ? "success"
        : pass24h.pct >= 95
          ? "warning"
          : "danger";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      <KpiCard
        icon="solar:pulse-2-linear"
        tone={rtTone}
        title="Response Time · 1h"
        value={displayLatency != null ? String(displayLatency) : "—"}
        unit={displayLatency != null ? "ms" : undefined}
        delta={
          displayLatency != null
            ? displayLatency < endpoint.latencyThreshold
              ? "under threshold"
              : "above threshold"
            : "no data"
        }
        deltaTone={
          displayLatency == null
            ? "muted"
            : displayLatency < endpoint.latencyThreshold
              ? "success"
              : "warning"
        }
        deltaLabel={`${endpoint.latencyThreshold}ms`}
        spark={rtSpark}
        sparkLabels={rtSparkLabels}
        sparkFormat={(n) => `${Math.round(n)}ms`}
      />

      <KpiCard
        icon="solar:checklist-minimalistic-linear"
        tone={passTone}
        title="Check Pass Rate · 24h"
        value={pass24h ? pass24h.pct.toFixed(1) : "—"}
        unit={pass24h ? "%" : undefined}
        delta={
          pass24h
            ? `${pass24h.pass}/${pass24h.total}`
            : "awaiting data"
        }
        deltaTone={passTone}
        deltaLabel="checks passing"
        spark={successSpark}
        sparkLabels={sparkLabels}
        sparkFormat={(n) => `${n.toFixed(1)}%`}
        sparkYMin={0}
        sparkYMax={100}
      />

      <KpiCard
        icon="solar:clock-circle-linear"
        tone={downtimeTone}
        title={`Downtime · ${slo.windowDays}d`}
        value={downtime30d === 0 ? "0" : formatDuration(downtime30d)}
        unit={downtime30d === 0 ? "s" : undefined}
        delta={
          budgetUsedPct > 100
            ? "budget exhausted"
            : `${budgetUsedPct.toFixed(0)}% of budget used`
        }
        deltaTone={downtimeTone}
        deltaLabel={`budget ${formatDuration(budgetAllowableSecs)}`}
        spark={budgetSpark}
        sparkLabels={budgetSparkLabels}
        sparkFormat={(n) => (n >= 100 ? "100%+" : `${n.toFixed(0)}%`)}
        sparkYMin={0}
        sparkYMax={100}
      />

      <KpiCard
        icon={
          timeSince.active
            ? "solar:danger-triangle-linear"
            : "solar:calendar-minimalistic-linear"
        }
        tone={timeSince.active ? "danger" : "success"}
        title={timeSince.active ? "Active Incident" : "Time Since Incident"}
        value={timeSince.value}
        delta={timeSince.sub}
        deltaTone={timeSince.active ? "danger" : "muted"}
        spark={null}
      />

      <KpiCard
        icon="solar:lock-keyhole-minimalistic-linear"
        tone={sslTone}
        title="SSL Certificate"
        value={sslValue}
        unit={sslDays != null ? "until renewal" : undefined}
        delta={sslIssuerLabel}
        deltaTone="muted"
        spark={null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local KpiCard — vertical layout with full-bleed sparkline at the bottom.
// Matches the pattern used on IncidentsPage / NotificationsPage.
// ---------------------------------------------------------------------------

function KpiCard({
  icon,
  tone,
  title,
  value,
  unit,
  delta,
  deltaTone = "muted",
  deltaLabel,
  spark,
  sparkLabels,
  sparkFormat,
  sparkYMin,
  sparkYMax,
}: {
  icon: string;
  tone: Tone;
  title: string;
  value: string;
  unit?: string;
  delta?: string;
  deltaTone?: Tone;
  deltaLabel?: string;
  spark?: number[] | null;
  sparkLabels?: string[];
  sparkFormat?: (n: number) => string;
  sparkYMin?: number;
  sparkYMax?: number;
}) {
  return (
    <div className="relative flex flex-col gap-2.5 rounded-xl border border-wd-border/50 bg-wd-surface px-4 py-3.5 min-h-[118px] overflow-hidden">
      <div className="flex items-center gap-2.5">
        <div className={cn("h-7 w-7 rounded-lg flex items-center justify-center", tileClass(tone))}>
          <Icon icon={icon} width={16} />
        </div>
        <div className="text-xs font-medium text-wd-muted">{title}</div>
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold font-mono tracking-tight text-foreground">
            {value}
          </span>
          {unit && <span className="text-[11px] text-wd-muted">{unit}</span>}
        </div>
        {delta && (
          <div className={cn("mt-1.5 text-[11px] font-medium", deltaClass(deltaTone))}>
            {delta}
            {deltaLabel && (
              <span className="ml-1 text-wd-muted/70 font-normal">{deltaLabel}</span>
            )}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-auto -mx-4">
          <WideSpark
            data={spark}
            color={toneStroke(tone)}
            height={46}
            labels={sparkLabels}
            formatValue={sparkFormat}
            yMin={sparkYMin}
            yMax={sparkYMax}
          />
        </div>
      )}
    </div>
  );
}

export default memo(EndpointKpiStripBase);
