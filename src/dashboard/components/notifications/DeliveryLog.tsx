/**
 * Delivery log — every dispatch attempt, across every endpoint, in an
 * accordion table. Rows render through the shared `LogRow` so the layout
 * matches the per-endpoint Notifications tab exactly; the only differences on
 * the page version are an extra "Endpoint" filter, the page-only suppressed
 * reason chip wired up by `SuppressionPanel`, and Load-older pagination.
 *
 * Filter state is owned by `NotificationsPage` so cross-wires from the
 * channels grid (`onFilterByChannel`) and suppression panel (`onFilterReason`)
 * keep working.
 */
import { useEffect, useMemo, useState } from "react";
import { Spinner, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { DateValue, RangeValue } from "react-aria-components";
import { getLocalTimeZone } from "@internationalized/date";
import { useApi } from "../../hooks/useApi";
import type { ApiEndpoint, ApiPagination } from "../../types/api";
import type {
  ApiChannel,
  ApiNotificationLogRow,
  DeliveryStatus,
  NotificationKind,
  NotificationSeverity,
} from "../../types/notifications";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
  Segmented,
} from "../endpoint-detail/primitives";
import { LOG_ROW_GRID, LogRow } from "./LogAccordionRow";
import { readableReason } from "./notificationHelpers";

export interface LogFilters {
  channelId?: string;
  endpointId?: string;
  severity?: NotificationSeverity;
  kind?: NotificationKind;
  status?: DeliveryStatus;
  customRange?: RangeValue<DateValue> | null;
  search?: string;
  suppressedReason?: string;
}

interface Props {
  channels: ApiChannel[];
  endpoints: ApiEndpoint[];
  filters: LogFilters;
  onFilterChange: (patch: Partial<LogFilters>) => void;
  refreshKey: number;
}

interface Envelope {
  data: ApiNotificationLogRow[];
  pagination: ApiPagination;
}

type StatusFilter = DeliveryStatus | "all";

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "suppressed", label: "Suppressed" },
  { key: "pending", label: "Pending" },
];

const SEVERITY_OPTIONS: {
  id: NotificationSeverity | "all";
  label: string;
  dot?: string;
}[] = [
  { id: "all", label: "All severities" },
  { id: "critical", label: "Critical", dot: "var(--wd-danger)" },
  { id: "warning", label: "Warning", dot: "var(--wd-warning)" },
  { id: "info", label: "Info", dot: "var(--wd-primary)" },
  { id: "success", label: "Success", dot: "var(--wd-success)" },
];

const KIND_OPTIONS: { id: NotificationKind | "all"; label: string }[] = [
  { id: "all", label: "All event types" },
  { id: "incident_opened", label: "Opened" },
  { id: "incident_resolved", label: "Resolved" },
  { id: "incident_escalated", label: "Escalation" },
  { id: "channel_test", label: "Test" },
  { id: "custom", label: "Custom" },
];

export function DeliveryLog({
  channels,
  endpoints,
  filters,
  onFilterChange,
  refreshKey,
}: Props) {
  const { request } = useApi();
  const [rows, setRows] = useState<ApiNotificationLogRow[]>([]);
  const [pagination, setPagination] = useState<ApiPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const channelById = useMemo(() => {
    const m = new Map<string, ApiChannel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const endpointOptions = useMemo<{ id: string; label: string }[]>(() => {
    const opts: { id: string; label: string }[] = [
      { id: "all", label: "All endpoints" },
    ];
    for (const e of endpoints) opts.push({ id: e.id, label: e.name });
    return opts;
  }, [endpoints]);

  const channelOptions = useMemo<{ id: string; label: string }[]>(() => {
    const opts: { id: string; label: string }[] = [
      { id: "all", label: "All channels" },
    ];
    for (const c of channels) opts.push({ id: c.id, label: c.name });
    return opts;
  }, [channels]);

  const buildParams = (cursor?: string | null): URLSearchParams => {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (filters.channelId) params.set("channelId", filters.channelId);
    if (filters.endpointId) params.set("endpointId", filters.endpointId);
    if (filters.severity) params.set("severity", filters.severity);
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.status) params.set("status", filters.status);
    if (filters.search) params.set("search", filters.search);
    if (filters.customRange) {
      const tz = getLocalTimeZone();
      params.set("from", filters.customRange.start.toDate(tz).toISOString());
      params.set("to", filters.customRange.end.toDate(tz).toISOString());
    }
    if (cursor) params.set("cursor", cursor);
    return params;
  };

  // Reset list whenever filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedId(null);
    request<Envelope>(`/notifications/log?${buildParams().toString()}`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.data?.data ?? []);
        setPagination(res.data?.pagination ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setPagination(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    request,
    refreshKey,
    filters.channelId,
    filters.endpointId,
    filters.severity,
    filters.kind,
    filters.status,
    filters.search,
    filters.customRange,
  ]);

  const loadMore = async () => {
    if (loadingMore || !pagination?.hasMore || !pagination.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await request<Envelope>(
        `/notifications/log?${buildParams(pagination.nextCursor).toString()}`,
      );
      const next = res.data?.data ?? [];
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...next.filter((r) => !seen.has(r.id))];
      });
      setPagination(res.data?.pagination ?? null);
    } finally {
      setLoadingMore(false);
    }
  };

  // Suppressed-reason chip is page-local: the API doesn't have a dedicated
  // param so we narrow the fetched page client-side. Fine for the small dispatch
  // volumes this tool targets.
  const visibleRows = useMemo(() => {
    if (!filters.suppressedReason) return rows;
    return rows.filter((r) => r.suppressedReason === filters.suppressedReason);
  }, [rows, filters.suppressedReason]);

  // Endpoint filter is also page-local: notifications/log doesn't accept an
  // `endpointId` query, so we filter the fetched page after the fact too.
  const finalRows = useMemo(() => {
    if (!filters.endpointId) return visibleRows;
    return visibleRows.filter((r) => r.endpointId === filters.endpointId);
  }, [visibleRows, filters.endpointId]);

  // Annotate the message summary with endpoint name in the row's expansion?
  // Not needed — the row's Trigger/Reproduce already exposes endpoint context.

  const counts = useMemo(
    () => ({
      sent: rows.filter((r) => r.deliveryStatus === "sent").length,
      failed: rows.filter((r) => r.deliveryStatus === "failed").length,
      suppressed: rows.filter((r) => r.deliveryStatus === "suppressed").length,
      pending: rows.filter((r) => r.deliveryStatus === "pending").length,
    }),
    [rows],
  );

  const activeStatus: StatusFilter = filters.status ?? "all";
  const activeSeverity = filters.severity ?? "all";
  const activeKind = filters.kind ?? "all";
  const activeChannel = filters.channelId ?? "all";
  const activeEndpoint = filters.endpointId ?? "all";

  const hasAnyFilter = !!(
    filters.channelId ||
    filters.endpointId ||
    filters.severity ||
    filters.kind ||
    filters.status ||
    filters.search ||
    filters.customRange ||
    filters.suppressedReason
  );

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <Segmented<StatusFilter>
          ariaLabel="Delivery status"
          options={STATUS_OPTIONS}
          value={activeStatus}
          onChange={(v) => {
            onFilterChange({ status: v === "all" ? undefined : v });
          }}
        />
        <FilterDropdown<NotificationSeverity | "all">
          ariaLabel="Notification severity"
          value={activeSeverity}
          options={SEVERITY_OPTIONS}
          onChange={(v) => {
            onFilterChange({ severity: v === "all" ? undefined : v });
          }}
        />
        <FilterDropdown<NotificationKind | "all">
          ariaLabel="Notification event type"
          value={activeKind}
          options={KIND_OPTIONS}
          onChange={(v) => {
            onFilterChange({ kind: v === "all" ? undefined : v });
          }}
        />
        <DateRangeFilter
          ariaLabel="Delivery date range"
          value={filters.customRange ?? null}
          onChange={(customRange) => {
            onFilterChange({ customRange });
          }}
        />
        <FilterDropdown
          ariaLabel="Notifications channel"
          value={activeChannel}
          options={channelOptions}
          onChange={(v) => {
            onFilterChange({ channelId: v === "all" ? undefined : v });
          }}
        />
        <FilterDropdown
          ariaLabel="Endpoint"
          value={activeEndpoint}
          options={endpointOptions}
          onChange={(v) => {
            onFilterChange({ endpointId: v === "all" ? undefined : v });
          }}
        />
        <div className="ml-auto">
          <FilterSearch
            ariaLabel="Search notifications"
            value={filters.search ?? ""}
            onChange={(v) => {
              onFilterChange({ search: v || undefined });
            }}
            placeholder="Summary, target…"
          />
        </div>
      </div>

      {filters.suppressedReason && (
        <div className="flex items-center gap-2 text-[11px] text-wd-muted">
          Filtering suppressions by:
          <span className="inline-flex items-center gap-1 bg-wd-warning/10 text-wd-warning border border-wd-warning/20 rounded-full px-2 py-0.5 capitalize">
            {readableReason(filters.suppressedReason)}
            <button
              type="button"
              onClick={() => {
                onFilterChange({ suppressedReason: undefined });
              }}
              className="hover:text-foreground"
              aria-label="Remove reason filter"
            >
              <Icon icon="solar:close-circle-linear" width={14} />
            </button>
          </span>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="text-[13px] font-semibold text-foreground">
              Delivery log
            </div>
            <span className="text-[11px] text-wd-muted font-mono">
              <span className="text-wd-success">{counts.sent}</span> sent ·{" "}
              <span className="text-wd-danger">{counts.failed}</span> failed ·{" "}
              <span className="text-wd-warning">{counts.suppressed}</span>{" "}
              suppressed
              {counts.pending > 0 ? ` · ${counts.pending} pending` : ""}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {hasAnyFilter && (
              <button
                type="button"
                onClick={() => {
                  onFilterChange({
                    channelId: undefined,
                    endpointId: undefined,
                    severity: undefined,
                    kind: undefined,
                    status: undefined,
                    search: undefined,
                    customRange: null,
                    suppressedReason: undefined,
                  });
                }}
                className="inline-flex items-center gap-1 text-[11px] text-wd-muted hover:text-foreground cursor-pointer"
              >
                <Icon icon="solar:close-circle-linear" width={14} />
                Clear filters
              </button>
            )}
            <span className="text-[11px] text-wd-muted">
              Click a row to inspect
            </span>
          </div>
        </div>

        <div
          className={cn(
            LOG_ROW_GRID,
            "px-4 py-2.5 text-[10px] uppercase tracking-[0.08em] text-wd-muted border-b border-wd-border/50 bg-wd-surface-hover/30 font-semibold",
          )}
        >
          <span />
          <span>When</span>
          <span>Channel</span>
          <span>Event</span>
          <span>Type</span>
          <span>Status</span>
          <span className="text-right">Latency</span>
          <span />
        </div>

        <div className="min-h-[520px] flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : finalRows.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <Icon
                icon="solar:bell-off-linear"
                width={28}
                className="text-wd-muted mb-3"
              />
              <div className="text-[13px] text-foreground font-medium">
                No deliveries match these filters.
              </div>
              <div className="text-[11px] text-wd-muted mt-1">
                Try a broader status, date range, or clear search.
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-wd-border/40">
              {finalRows.map((r) => {
                const rowChannel = channelById.get(r.channelId) ?? null;
                return (
                  <LogRow
                    key={r.id}
                    row={r}
                    channel={rowChannel}
                    expanded={expandedId === r.id}
                    onToggle={() => {
                      setExpandedId((prev) => (prev === r.id ? null : r.id));
                    }}
                  />
                );
              })}
              {pagination?.hasMore && (
                <li className="flex justify-center py-3">
                  <button
                    onClick={() => void loadMore()}
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
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
