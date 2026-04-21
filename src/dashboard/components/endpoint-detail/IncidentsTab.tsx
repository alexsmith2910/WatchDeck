/**
 * Incidents tab — summary strip + filterable list scoped to this endpoint.
 *
 * Rows are React-Router links to `/incidents/:id` so the click target matches
 * what the top-level IncidentsPage does. Filter bar visually matches
 * IncidentsTable (SearchField + range pills + cause/severity dropdowns).
 */
import { memo, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiIncident } from "../../types/api";
import {
  causeKindChipClass,
  fmtDuration,
  metaFor,
  severityChipClass,
  severityDotClass,
  severityOf,
  type Severity,
} from "../incidents/incidentHelpers";
import { formatDateTime, timeAgo } from "../../utils/format";
import { FilterDropdown, FilterSearch, Segmented } from "./primitives";

type StatusFilter = "all" | "active" | "resolved";
type RangeFilter = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<RangeFilter, number | null> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: null,
};

interface Filters {
  status: StatusFilter;
  severity: Severity | "all";
  cause: string;
  range: RangeFilter;
  q: string;
}

const DEFAULTS: Filters = {
  status: "all",
  severity: "all",
  cause: "all",
  range: "30d",
  q: "",
};

interface Props {
  endpointId: string;
  incidents: ApiIncident[];
  loading: boolean;
}

function IncidentsTabBase({ endpointId, incidents, loading }: Props) {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);

  const mine = useMemo(
    () => incidents.filter((i) => i.endpointId === endpointId),
    [incidents, endpointId],
  );

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const cutoff = RANGE_MS[filters.range];
    return mine.filter((inc) => {
      if (
        cutoff != null &&
        Date.now() - new Date(inc.startedAt).getTime() > cutoff
      )
        return false;
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
      <FilterBar
        filters={filters}
        onChange={patchFilters}
        count={filtered.length}
      />

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5">
            <div className="text-[13px] font-semibold text-foreground">
              Timeline
            </div>
            <span className="text-[11px] text-wd-muted font-mono">
              {filtered.length}{" "}
              {filtered.length === 1 ? "incident" : "incidents"}
            </span>
          </div>
          <div className="inline-flex items-center gap-1.5 text-[11px] text-wd-muted">
            <Icon icon="solar:sort-from-top-to-bottom-linear" width={16} />
            Active first · then newest
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
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
          <ul className="divide-y divide-wd-border/40">
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
                <IncidentRow key={inc._id} incident={inc} />
              ))}
          </ul>
        )}
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
  count,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  count: number;
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
      <Segmented<RangeFilter>
        options={[
          { key: "24h", label: "24h" },
          { key: "7d", label: "7d" },
          { key: "30d", label: "30d" },
          { key: "all", label: "All" },
        ]}
        value={filters.range}
        onChange={(range) => onChange({ range })}
        ariaLabel="Incident time range"
      />
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] text-wd-muted font-mono">
          {count} shown
        </span>
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

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function IncidentRow({ incident }: { incident: ApiIncident }) {
  const meta = metaFor(incident.cause);
  const sev = severityOf(incident);
  const isActive = incident.status === "active";
  const durationSecs =
    incident.durationSeconds ??
    (isActive
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(incident.startedAt).getTime()) / 1000,
          ),
        )
      : null);

  return (
    <li>
      <Link
        to={`/incidents/${incident._id}`}
        className="grid grid-cols-[18px_minmax(120px,1fr)_120px_minmax(160px,1.4fr)_100px_130px_20px] items-center gap-2 px-4 py-2.5 hover:bg-wd-surface-hover transition-colors"
      >
        <span
          className={cn("w-2.5 h-2.5 rounded-full", severityDotClass(sev))}
        />
        <span className="min-w-0">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11.5px] font-medium truncate",
              isActive ? "text-wd-danger" : "text-foreground",
            )}
          >
            {isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-wd-danger animate-pulse" />
            )}
            {formatDateTime(incident.startedAt)}
          </span>
          <span className="block text-[10.5px] text-wd-muted font-mono mt-0.5">
            {timeAgo(incident.startedAt)}
          </span>
        </span>
        <span
          className={cn(
            "inline-flex items-center justify-center px-2 h-5 rounded text-[10px] leading-none font-semibold uppercase tracking-wider w-fit pt-[1px]",
            causeKindChipClass(meta.kind),
          )}
        >
          {meta.short}
        </span>
        <span className="text-[12px] text-foreground truncate">
          {meta.label}
          {incident.causeDetail && (
            <span className="text-wd-muted"> · {incident.causeDetail}</span>
          )}
        </span>
        <span className="text-[11.5px] font-mono text-right text-foreground">
          {durationSecs != null ? fmtDuration(durationSecs) : "—"}
        </span>
        <span
          className={cn(
            "inline-flex items-center justify-center px-2 h-5 rounded text-[10px] leading-none font-semibold uppercase tracking-wider w-fit pt-[1px]",
            severityChipClass(sev),
          )}
        >
          {sev}
        </span>
        <Icon
          icon="solar:alt-arrow-right-linear"
          width={14}
          className="text-wd-muted"
        />
      </Link>
    </li>
  );
}

export default memo(IncidentsTabBase);
