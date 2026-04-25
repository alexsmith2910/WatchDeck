/**
 * Incidents tab — summary strip + filterable list scoped to this endpoint.
 *
 * Rows reuse the shared TableRow/TableHeader from IncidentsTable so the visual
 * vocabulary matches the main Incidents page (status pill, cause chip, live
 * duration, channel chips, response-time sparkline). The endpoint column is
 * hidden because this view is already scoped to a single endpoint.
 */
import { memo, useMemo, useState } from "react";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { DateValue, RangeValue } from "react-aria-components";
import { getLocalTimeZone } from "@internationalized/date";
import type { ApiIncident } from "../../types/api";
import type { ApiChannel } from "../../types/notifications";
import {
  fmtDuration,
  metaFor,
  severityOf,
  type EndpointLite,
  type EndpointSparkline,
  type Severity,
} from "../incidents/incidentHelpers";
import { TableHeader, TableRow } from "../incidents/IncidentsTable";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
  Segmented,
} from "./primitives";

type StatusFilter = "all" | "active" | "resolved";

interface Filters {
  status: StatusFilter;
  severity: Severity | "all";
  cause: string;
  customRange: RangeValue<DateValue> | null;
  q: string;
}

const DEFAULTS: Filters = {
  status: "all",
  severity: "all",
  cause: "all",
  customRange: null,
  q: "",
};

interface Props {
  endpointId: string;
  incidents: ApiIncident[];
  loading: boolean;
  endpointById: Map<string, EndpointLite>;
  channelById: Map<string, ApiChannel>;
  sparklineByIncidentId: Map<string, EndpointSparkline>;
}

function IncidentsTabBase({
  endpointId,
  incidents,
  loading,
  endpointById,
  channelById,
  sparklineByIncidentId,
}: Props) {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);

  const mine = useMemo(
    () => incidents.filter((i) => i.endpointId === endpointId),
    [incidents, endpointId],
  );

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const tz = getLocalTimeZone();
    const customFrom = filters.customRange
      ? filters.customRange.start.toDate(tz).getTime()
      : null;
    const customTo = filters.customRange
      ? filters.customRange.end.toDate(tz).getTime()
      : null;
    return mine.filter((inc) => {
      const started = new Date(inc.startedAt).getTime();
      if (customFrom != null && customTo != null) {
        if (started < customFrom || started > customTo) return false;
      }
      if (filters.status !== "all" && inc.status !== filters.status)
        return false;
      if (filters.severity !== "all" && severityOf(inc) !== filters.severity)
        return false;
      if (filters.cause !== "all" && inc.cause !== filters.cause) return false;
      if (q) {
        const meta = metaFor(inc.cause);
        const hay =
          `${meta.label} ${inc.cause} ${inc.causeDetail ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [mine, filters]);

  const active = mine.filter((i) => i.status === "active");

  const kpi = useMemo(() => {
    const resolved = mine.filter(
      (i) => i.status === "resolved" && i.durationSeconds != null,
    );
    const mttr =
      resolved.length > 0
        ? Math.round(
            resolved.reduce((s, i) => s + (i.durationSeconds ?? 0), 0) /
              resolved.length,
          )
        : null;
    const in30d = mine.filter(
      (i) => Date.now() - new Date(i.startedAt).getTime() <= 30 * 86_400_000,
    ).length;
    return { active: active.length, total: mine.length, mttr, in30d };
  }, [mine, active.length]);

  const patchFilters = (p: Partial<Filters>) =>
    setFilters((prev) => ({ ...prev, ...p }));

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SummaryStrip kpi={kpi} />
      <FilterBar filters={filters} onChange={patchFilters} />

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="text-[13px] font-semibold text-foreground">
              Timeline
            </div>
            <TodayCountIncidents incidents={mine} />
          </div>
          <div className="inline-flex items-center gap-1.5 text-[11px] text-wd-muted">
            <Icon icon="solar:sort-from-top-to-bottom-linear" width={16} />
            Active first · then newest
          </div>
        </div>

        <TableHeader showEndpoint={false} />

        <div className="min-h-[520px] flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <Icon
                icon="solar:shield-check-linear"
                width={28}
                className="text-wd-success mb-3"
              />
              <div className="text-[13px] text-foreground font-medium">
                No incidents match these filters.
              </div>
              <div className="text-[11px] text-wd-muted mt-1">
                Try a wider window or clear filters above.
              </div>
            </div>
          ) : (
            <div>
              {[...filtered]
                .sort((a, b) => {
                  const aActive = a.status === "active" ? 1 : 0;
                  const bActive = b.status === "active" ? 1 : 0;
                  if (aActive !== bActive) return bActive - aActive;
                  return (
                    new Date(b.startedAt).getTime() -
                    new Date(a.startedAt).getTime()
                  );
                })
                .map((inc) => (
                  <TableRow
                    key={inc.id}
                    incident={inc}
                    endpoint={endpointById.get(inc.endpointId)}
                    channelById={channelById}
                    sparkline={sparklineByIncidentId.get(inc.id)}
                    showEndpoint={false}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

function SummaryStrip({
  kpi,
}: {
  kpi: { active: number; total: number; mttr: number | null; in30d: number };
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <SummaryCell
        icon="solar:danger-triangle-linear"
        label="Active"
        value={String(kpi.active)}
        tone={kpi.active > 0 ? "danger" : "success"}
      />
      <SummaryCell
        icon="solar:history-linear"
        label="Total tracked"
        value={String(kpi.total)}
        tone="primary"
      />
      <SummaryCell
        icon="solar:refresh-circle-linear"
        label="MTTR"
        value={kpi.mttr != null ? fmtDuration(kpi.mttr) : "—"}
        tone="primary"
      />
      <SummaryCell
        icon="solar:calendar-minimalistic-linear"
        label="Last 30 days"
        value={String(kpi.in30d)}
        tone={kpi.in30d > 0 ? "warning" : "success"}
      />
    </div>
  );
}

function SummaryCell({
  icon,
  label,
  value,
  tone,
}: {
  icon: string;
  label: string;
  value: string;
  tone: "primary" | "success" | "warning" | "danger";
}) {
  const toneText: Record<typeof tone, string> = {
    primary: "text-wd-primary",
    success: "text-wd-success",
    warning: "text-wd-warning",
    danger: "text-wd-danger",
  };
  const toneBg: Record<typeof tone, string> = {
    primary: "bg-wd-primary/10",
    success: "bg-wd-success/10",
    warning: "bg-wd-warning/10",
    danger: "bg-wd-danger/10",
  };
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-3 flex items-center gap-3">
      <div
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-lg",
          toneBg[tone],
          toneText[tone],
        )}
      >
        <Icon icon={icon} width={18} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-wd-muted">
          {label}
        </div>
        <div className="text-[18px] font-mono font-semibold text-foreground leading-tight">
          {value}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const CAUSE_OPTS: Array<{ id: string; label: string }> = [
    { id: "all", label: "All causes" },
    { id: "endpoint_down", label: "Down" },
    { id: "endpoint_degraded", label: "Degraded" },
    { id: "high_latency", label: "High Latency" },
    { id: "ssl_expiring", label: "SSL Expiring" },
    { id: "ssl_expired", label: "SSL Expired" },
    { id: "body_mismatch", label: "Body Validation" },
    { id: "port_closed", label: "Port Closed" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Segmented<StatusFilter>
        options={[
          { key: "all", label: "All" },
          { key: "active", label: "Active" },
          { key: "resolved", label: "Resolved" },
        ]}
        value={filters.status}
        onChange={(status) => onChange({ status })}
        ariaLabel="Incident status"
      />
      <FilterDropdown<Severity | "all">
        value={filters.severity}
        options={[
          { id: "all", label: "All severities" },
          { id: "Critical", label: "Critical", dot: "var(--wd-danger)" },
          { id: "Major", label: "Major", dot: "var(--wd-warning)" },
          { id: "Minor", label: "Minor", dot: "var(--wd-primary)" },
        ]}
        onChange={(severity) => onChange({ severity })}
        ariaLabel="Incident severity"
      />
      <FilterDropdown
        value={filters.cause}
        options={CAUSE_OPTS}
        onChange={(cause) => onChange({ cause })}
        ariaLabel="Incident cause"
      />
      <DateRangeFilter
        value={filters.customRange}
        onChange={(customRange) => onChange({ customRange })}
        ariaLabel="Incident date range"
      />
      <div className="ml-auto flex items-center gap-3">
        <FilterSearch
          ariaLabel="Search incidents"
          value={filters.q}
          onChange={(q) => onChange({ q })}
          placeholder="Cause, detail…"
        />
      </div>
    </div>
  );
}

function TodayCountIncidents({ incidents }: { incidents: ApiIncident[] }) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = incidents.filter(
    (i) =>
      i.status === "active" || new Date(i.startedAt).getTime() >= cutoff,
  );
  if (recent.length === 0) {
    return (
      <span className="text-[11px] text-wd-muted font-mono">
        no incidents in the last 24hrs
      </span>
    );
  }
  const active = recent.filter((i) => i.status === "active").length;
  const resolved = recent.length - active;
  return (
    <span className="text-[11px] text-wd-muted font-mono inline-flex items-center gap-1.5 flex-wrap">
      <span className="text-foreground">{recent.length}</span>{" "}
      {recent.length === 1 ? "incident" : "incidents"} in the last 24hrs
      {active > 0 && (
        <>
          <span className="text-wd-muted-soft">·</span>
          <span className="text-wd-danger">{active} active</span>
        </>
      )}
      {resolved > 0 && (
        <>
          <span className="text-wd-muted-soft">·</span>
          <span className="text-wd-success">{resolved} resolved</span>
        </>
      )}
    </span>
  );
}

export default memo(IncidentsTabBase);
