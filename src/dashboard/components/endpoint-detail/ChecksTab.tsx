/**
 * Checks tab — recent probe results with inline expansion.
 *
 * Each row opens a Request / Response / Assertions detail laid out per the
 * design mock in `temp/endpoint details/Endpoint.tabs.jsx`. Assertion wiring
 * is still TBD in the backend, so the Assertions block renders placeholder
 * rows inside a RainbowPlaceholder until that flow lands.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { DateValue, RangeValue } from "react-aria-components";
import { getLocalTimeZone } from "@internationalized/date";
import { useApi } from "../../hooks/useApi";
import { useRuntimeInfo } from "../../hooks/useRuntimeInfo";
import type {
  ApiCheck,
  ApiEndpoint,
  ApiPagination,
  HourlySummary,
} from "../../types/api";
import { formatDateTime, latencyColor, statusColors } from "../../utils/format";
import { formatBytes } from "../../utils/formatBytes";
import { reasonPhrase } from "../../utils/httpStatus";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
  RainbowPlaceholder,
} from "./primitives";

type StatusFilter = "all" | "healthy" | "degraded" | "down";
type HttpClassFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "err";

interface Props {
  endpoint: ApiEndpoint;
  hourly24h?: HourlySummary[];
}

interface Filters {
  status: StatusFilter;
  httpClass: HttpClassFilter;
  customRange: RangeValue<DateValue> | null;
  q: string;
}

const DEFAULT_FILTERS: Filters = {
  status: "all",
  httpClass: "all",
  customRange: null,
  q: "",
};

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function httpClassOf(check: ApiCheck): HttpClassFilter {
  const code = check.statusCode;
  if (code == null) return "err";
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  if (code >= 200) return "2xx";
  return "err";
}

function ChecksTabBase({ endpoint, hourly24h }: Props) {
  const endpointId = endpoint._id;
  const { request } = useApi();
  const { runtime } = useRuntimeInfo();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [checks, setChecks] = useState<ApiCheck[]>([]);
  const [pagination, setPagination] = useState<ApiPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchChecks = useCallback(
    async (reset = true) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);
      const params = new URLSearchParams();
      params.set("limit", "30");
      if (filters.customRange) {
        const tz = getLocalTimeZone();
        const from = filters.customRange.start.toDate(tz);
        const to = filters.customRange.end.toDate(tz);
        params.set("from", from.toISOString());
        params.set("to", to.toISOString());
      } else {
        const from = new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
        params.set("from", from);
      }
      if (filters.status !== "all") params.set("status", filters.status);
      if (!reset && pagination?.nextCursor)
        params.set("cursor", pagination.nextCursor);
      const res = await request<{
        data: ApiCheck[];
        pagination: ApiPagination;
      }>(`/endpoints/${endpointId}/checks?${params}`);
      if (res.status < 400) {
        if (reset) setChecks(res.data.data ?? []);
        else setChecks((prev) => [...prev, ...(res.data.data ?? [])]);
        setPagination(res.data.pagination);
      }
      if (reset) setLoading(false);
      else setLoadingMore(false);
    },
    [
      endpointId,
      filters.customRange,
      filters.status,
      pagination?.nextCursor,
      request,
    ],
  );

  useEffect(() => {
    void fetchChecks(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointId, filters.customRange, filters.status]);

  const displayed = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return checks.filter((c) => {
      if (filters.httpClass !== "all" && httpClassOf(c) !== filters.httpClass)
        return false;
      if (
        q &&
        !`${c.statusCode ?? ""} ${c.status} ${c.statusReason ?? ""} ${c.errorMessage ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [checks, filters.q, filters.httpClass]);

  const patchFilters = useCallback(
    (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch })),
    [],
  );

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <FilterBar filters={filters} onChange={patchFilters} />

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden flex flex-col min-h-0">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="text-[13px] font-semibold text-foreground">
              Recent checks
            </div>
            <TodayCountChecks hourly24h={hourly24h ?? []} />
          </div>
          <span className="text-[11px] text-wd-muted">
            Click a row to inspect
          </span>
        </div>

        <div className="grid grid-cols-[14px_220px_70px_58px_84px_120px_minmax(140px,1fr)_22px] items-center gap-x-3 px-4 py-2.5 text-[10px] uppercase tracking-[0.08em] text-wd-muted border-b border-wd-border/50 bg-wd-surface-hover/30 font-semibold">
          <span />
          <span>When</span>
          <span>Result</span>
          <span>Code</span>
          <span>Response</span>
          <span>Assertions</span>
          <span>Error</span>
          <span />
        </div>

        <div className="min-h-[520px] flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <Icon
                icon="solar:checklist-minimalistic-linear"
                width={28}
                className="text-wd-muted mb-3"
              />
              <div className="text-[13px] text-foreground font-medium">
                No checks in this window.
              </div>
              <div className="text-[11px] text-wd-muted mt-1">
                Try a wider range or clear filters.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-wd-border/40">
              {displayed.map((c) => (
                <CheckRow
                  key={c._id}
                  check={c}
                  endpoint={endpoint}
                  probeName={runtime.probeName}
                  expanded={expandedId === c._id}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === c._id ? null : c._id))
                  }
                />
              ))}
              {pagination?.hasMore && (
                <div className="flex justify-center py-3">
                  <button
                    onClick={() => void fetchChecks(false)}
                    disabled={loadingMore}
                    className="inline-flex items-center gap-1.5 text-[12px] text-wd-primary hover:underline disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {loadingMore ? (
                      <Spinner size="sm" />
                    ) : (
                      <Icon icon="solar:arrow-down-linear" width={14} />
                    )}
                    Load older
                  </button>
                </div>
              )}
            </div>
          )}
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
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <DateRangeFilter
        value={filters.customRange}
        onChange={(customRange) => onChange({ customRange })}
        ariaLabel="Check date range"
      />
      <FilterDropdown<StatusFilter>
        value={filters.status}
        options={[
          { id: "all", label: "All statuses" },
          { id: "healthy", label: "Healthy", dot: "var(--wd-success)" },
          { id: "degraded", label: "Degraded", dot: "var(--wd-warning)" },
          { id: "down", label: "Down", dot: "var(--wd-danger)" },
        ]}
        onChange={(status) => onChange({ status })}
        ariaLabel="Check status"
      />
      <FilterDropdown<HttpClassFilter>
        value={filters.httpClass}
        options={[
          { id: "all", label: "All HTTP classes" },
          { id: "2xx", label: "2xx success", dot: "var(--wd-success)" },
          { id: "3xx", label: "3xx redirect", dot: "var(--wd-primary)" },
          { id: "4xx", label: "4xx client error", dot: "var(--wd-warning)" },
          { id: "5xx", label: "5xx server error", dot: "var(--wd-danger)" },
          { id: "err", label: "Network error", dot: "var(--wd-danger)" },
        ]}
        onChange={(httpClass) => onChange({ httpClass })}
        ariaLabel="HTTP status class"
      />
      <div className="ml-auto">
        <FilterSearch
          ariaLabel="Search checks"
          value={filters.q}
          onChange={(q) => onChange({ q })}
          placeholder="Status code, error…"
        />
      </div>
    </div>
  );
}

function TodayCountChecks({ hourly24h }: { hourly24h: HourlySummary[] }) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0;
  let healthy = 0;
  let degraded = 0;
  let down = 0;
  for (const h of hourly24h) {
    if (new Date(h.hour).getTime() < cutoff) continue;
    total += h.totalChecks;
    healthy += h.successCount;
    degraded += h.degradedCount;
    down += h.failCount;
  }
  if (total === 0) {
    return (
      <span className="text-[11px] text-wd-muted font-mono">
        no checks in the last 24hrs
      </span>
    );
  }
  return (
    <span className="text-[11px] text-wd-muted font-mono inline-flex items-center gap-1.5 flex-wrap">
      <span className="text-foreground">{total}</span> checks in the last 24hrs
      <span className="text-wd-muted-soft">·</span>
      <span className="text-wd-success">{healthy} healthy</span>
      {degraded > 0 && (
        <>
          <span className="text-wd-muted-soft">·</span>
          <span className="text-wd-warning">{degraded} degraded</span>
        </>
      )}
      {down > 0 && (
        <>
          <span className="text-wd-muted-soft">·</span>
          <span className="text-wd-danger">{down} down</span>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function CheckRow({
  check,
  endpoint,
  probeName,
  expanded,
  onToggle,
}: {
  check: ApiCheck;
  endpoint: ApiEndpoint;
  probeName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const color = statusColors[check.status] ?? statusColors.unknown;
  const isFail = check.status === "down";
  const assertions = check.bodyValidation?.results ?? [];
  const passCount = assertions.filter((a) => !a.error).length;
  const totalCount = assertions.length;

  return (
    <div
      className={cn(
        "transition-colors",
        isFail
          ? "bg-wd-danger/[0.04] hover:bg-wd-danger/[0.08]"
          : "bg-wd-surface hover:bg-wd-surface-hover/60",
      )}
    >
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[14px_220px_70px_58px_84px_120px_minmax(140px,1fr)_22px] items-center gap-x-3 px-4 py-2 text-left cursor-pointer"
      >
        <span className={cn("w-2 h-2 rounded-full shrink-0", color.dot)} />

        <span className="text-[11.5px] font-mono text-foreground truncate">
          {formatDateTime(check.timestamp)}
        </span>

        <span
          className={cn(
            "inline-flex items-center justify-center h-5 px-2 rounded text-[10px] leading-none font-semibold uppercase tracking-wider w-fit pt-[1px]",
            isFail
              ? "bg-wd-danger/15 text-wd-danger"
              : check.status === "degraded"
                ? "bg-wd-warning/15 text-wd-warning"
                : "bg-wd-success/15 text-wd-success",
          )}
        >
          {isFail ? "Fail" : check.status === "degraded" ? "Slow" : "Pass"}
        </span>

        <span
          className={cn("text-[11.5px] font-mono font-semibold", color.text)}
        >
          {check.statusCode ?? "—"}
        </span>

        <span
          className={cn(
            "text-[11.5px] font-mono tabular-nums",
            latencyColor(check.responseTime, endpoint.latencyThreshold),
          )}
        >
          {check.responseTime}
          <span className="text-wd-muted font-normal ml-0.5">ms</span>
        </span>

        <span className="inline-flex items-center gap-1">
          {totalCount > 0 ? (
            <>
              <span className="inline-flex gap-[2px]">
                {assertions.slice(0, 8).map((a, i) => (
                  <span
                    key={i}
                    className={cn(
                      "w-[6px] h-[6px] rounded-[2px]",
                      a.error ? "bg-wd-danger" : "bg-wd-success",
                    )}
                  />
                ))}
              </span>
              <span
                className={cn(
                  "text-[10.5px] font-mono ml-1",
                  passCount === totalCount ? "text-wd-muted" : "text-wd-danger",
                )}
              >
                {passCount}/{totalCount}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-wd-muted-soft">—</span>
          )}
        </span>

        <span
          className={cn(
            "text-[11.5px] truncate",
            check.errorMessage ? "text-wd-danger" : "text-wd-muted",
          )}
        >
          {check.errorMessage ?? check.statusReason ?? "—"}
        </span>

        <Icon
          icon="solar:alt-arrow-down-linear"
          width={14}
          className={cn(
            "text-wd-muted transition-transform justify-self-end",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <CheckDetail check={check} endpoint={endpoint} probeName={probeName} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail — Request / Response kv-lists + Assertions placeholder.
// Layout mirrors `temp/endpoint details/Endpoint.tabs.jsx` ChecksTab expand.
// ---------------------------------------------------------------------------

const KV_ROW = "flex gap-2.5 font-mono text-[12px]";
const KV_KEY = "text-wd-muted min-w-[110px]";
const KV_VAL = "text-foreground tabular-nums break-all";
const H5 =
  "text-[10px] font-semibold uppercase tracking-wider text-wd-muted-soft mb-1.5";

function CheckDetail({
  check,
  endpoint,
  probeName,
}: {
  check: ApiCheck;
  endpoint: ApiEndpoint;
  probeName: string;
}) {
  const requestTarget =
    endpoint.type === "http"
      ? (endpoint.url ?? "—")
      : `${endpoint.host ?? "—"}:${endpoint.port ?? "—"}`;
  const method = endpoint.method ?? (endpoint.type === "port" ? "TCP" : "GET");
  const statusOk = check.status !== "down";
  const derivedReason = reasonPhrase(check.statusCode);
  const statusLabel =
    check.statusReason ?? (derivedReason || (statusOk ? "OK" : "Error"));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 px-5 pt-4 pb-[18px] bg-[var(--surface-secondary)] border-b border-wd-border/40">
      <div>
        <h5 className={H5}>Request</h5>
        <div className="flex flex-col gap-1">
          <div className={KV_ROW}>
            <span className={KV_KEY}>{endpoint.type === "http" ? "URL" : "Target"}</span>
            <span className={KV_VAL}>{requestTarget}</span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>Method</span>
            <span className={KV_VAL}>{method}</span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>Timestamp</span>
            <span className={KV_VAL}>
              {formatDateTime(check.timestamp)}
            </span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>Probe</span>
            <span className={cn(KV_VAL, "text-wd-muted")}>{probeName}</span>
          </div>
        </div>
      </div>

      <div>
        <h5 className={H5}>Response</h5>
        <div className="flex flex-col gap-1">
          <div className={KV_ROW}>
            <span className={KV_KEY}>Status code</span>
            <span
              className={cn(
                KV_VAL,
                "font-semibold",
                statusOk ? "text-wd-success" : "text-wd-danger",
              )}
            >
              {check.statusCode ?? "—"}{" "}
              <span className="text-wd-muted font-normal">{statusLabel}</span>
            </span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>Response time</span>
            <span className={cn(KV_VAL, latencyColor(check.responseTime, endpoint.latencyThreshold))}>
              {check.responseTime}ms
            </span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>Body</span>
            <span
              className={cn(
                KV_VAL,
                check.bodyBytes == null ? "text-wd-muted" : undefined,
              )}
            >
              {check.bodyBytes == null ? (
                "—"
              ) : (
                <>
                  {formatBytes(check.bodyBytes)}
                  {check.bodyBytesTruncated ? "+" : ""}
                </>
              )}
            </span>
          </div>
          <div className={KV_ROW}>
            <span className={KV_KEY}>SSL valid</span>
            <span className={KV_VAL}>
              {check.sslDaysRemaining != null ? (
                <>
                  <span className="text-wd-success">✓</span>{" "}
                  {check.sslDaysRemaining}d remaining
                </>
              ) : (
                <span className="text-wd-muted">—</span>
              )}
            </span>
          </div>
          {endpoint.lastSslIssuer && (endpoint.lastSslIssuer.cn || endpoint.lastSslIssuer.o) && (
            <div className={KV_ROW}>
              <span className={KV_KEY}>SSL issuer</span>
              <span className={cn(KV_VAL, "text-wd-muted")}>
                {endpoint.lastSslIssuer.cn ?? endpoint.lastSslIssuer.o}
                {endpoint.lastSslIssuer.cn && endpoint.lastSslIssuer.o && (
                  <> ({endpoint.lastSslIssuer.o})</>
                )}
              </span>
            </div>
          )}
          {check.errorMessage && (
            <div className={KV_ROW}>
              <span className={KV_KEY}>Error</span>
              <span className={cn(KV_VAL, "text-wd-danger")}>
                {check.errorMessage}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="md:col-span-2">
        <h5 className={H5}>Assertions</h5>
        <RainbowPlaceholder className="min-h-[96px]" rounded="rounded-lg">
          <div className="flex flex-col gap-1">
            <AssertionRow kind="status" op="===" value="200" passed />
            <AssertionRow
              kind="latency"
              op="<"
              value="800ms"
              window="p95 / 5m"
              passed
            />
            <AssertionRow
              kind="body"
              op="contains"
              value={'"status":"ok"'}
              passed
            />
            <AssertionRow
              kind="header"
              op="exists"
              value="x-request-id"
              passed
            />
          </div>
        </RainbowPlaceholder>
      </div>
    </div>
  );
}

function AssertionRow({
  kind,
  op,
  value,
  window,
  passed,
  actual,
}: {
  kind: string;
  op: string;
  value: string;
  window?: string;
  passed: boolean;
  actual?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-[5px] rounded-md font-mono text-[11.5px]",
        passed
          ? "bg-wd-success/[0.08] text-wd-success"
          : "bg-wd-danger/[0.08] text-wd-danger",
      )}
    >
      <Icon
        icon={passed ? "solar:check-circle-bold" : "solar:close-circle-bold"}
        width={12}
      />
      <span>
        <b className="font-semibold">{kind}</b>{" "}
        <span className="text-wd-muted">{op}</span> {value}
      </span>
      {window && <span className="text-wd-muted">· {window}</span>}
      {!passed && actual && (
        <span className="text-wd-muted ml-auto">actual: {actual}</span>
      )}
    </div>
  );
}

export default memo(ChecksTabBase);
