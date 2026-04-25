/**
 * Notifications tab — routes attached to this endpoint, plus the delivery log
 * scoped to it.
 *
 * Rows render through the shared `LogRow` accordion (also used by the
 * cross-endpoint Delivery Log on the Notifications page) so the row layout
 * and 2x2 expansion stay in lockstep across both surfaces.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { DateValue, RangeValue } from "react-aria-components";
import { getLocalTimeZone } from "@internationalized/date";
import { useApi } from "../../hooks/useApi";
import type { ApiEndpoint, ApiPagination } from "../../types/api";
import {
  type ApiChannel,
  type ApiNotificationLogRow,
  type NotificationKind,
  type NotificationSeverity,
  CHANNEL_TYPE_ICON,
} from "../../types/notifications";
import { LOG_ROW_GRID, LogRow } from "../notifications/LogAccordionRow";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
  SectionHead,
  Segmented,
} from "./primitives";

type StatusFilter = "all" | "sent" | "failed" | "suppressed" | "pending";
type SeverityFilter = "all" | NotificationSeverity;
type KindFilter = "all" | NotificationKind;

interface Filters {
  status: StatusFilter;
  severity: SeverityFilter;
  kind: KindFilter;
  channelId: string;
  customRange: RangeValue<DateValue> | null;
  q: string;
}

const DEFAULTS: Filters = {
  status: "all",
  severity: "all",
  kind: "all",
  channelId: "all",
  customRange: null,
  q: "",
};

interface Props {
  endpointId: string;
  endpoint: ApiEndpoint;
  channels: ApiChannel[];
}

function NotificationsTabBase({ endpointId, endpoint, channels }: Props) {
  const { request } = useApi();
  const [log, setLog] = useState<ApiNotificationLogRow[]>([]);
  const [pagination, setPagination] = useState<ApiPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [todayCount, setTodayCount] = useState<number | null>(null);

  useEffect(() => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    void request<{ data: { endpointTotal: number } }>(
      `/endpoints/${endpointId}/notifications/stats?from=${from}`,
    ).then((res) => {
      if (res?.status != null && res.status < 400) {
        setTodayCount(res.data?.data?.endpointTotal ?? 0);
      }
    });
  }, [endpointId, request]);

  // Local optimistic mirror of `endpoint.pausedNotificationChannelIds`.
  // The PATCH is fire-and-forget — on failure we roll back to the server
  // state from the last `endpoint` prop we received.
  const [pausedIds, setPausedIds] = useState<Set<string>>(
    () => new Set(endpoint.pausedNotificationChannelIds ?? []),
  );
  useEffect(() => {
    setPausedIds(new Set(endpoint.pausedNotificationChannelIds ?? []));
  }, [endpoint.pausedNotificationChannelIds]);

  const channelById = useMemo(() => {
    const m = new Map<string, ApiChannel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const routeChannels = useMemo(() => {
    const main = (endpoint.notificationChannelIds ?? [])
      .map((id) => channelById.get(id))
      .filter(Boolean) as ApiChannel[];
    const esc = endpoint.escalationChannelId
      ? channelById.get(endpoint.escalationChannelId)
      : null;
    return { main, escalation: esc ?? null };
  }, [
    endpoint.notificationChannelIds,
    endpoint.escalationChannelId,
    channelById,
  ]);

  const togglePause = useCallback(
    async (channelId: string, nextPaused: boolean) => {
      const prev = pausedIds;
      const next = new Set(prev);
      if (nextPaused) next.add(channelId);
      else next.delete(channelId);
      setPausedIds(next);

      const res = await request(`/endpoints/${endpointId}`, {
        method: "PUT",
        body: { pausedNotificationChannelIds: Array.from(next) },
      });
      if (res.status >= 400) {
        // Roll back on server failure. No toast — the row visibly flips back.
        setPausedIds(prev);
      }
    },
    [endpointId, pausedIds, request],
  );

  const fetchLog = useCallback(
    async (reset = true) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filters.status !== "all") params.set("status", filters.status);
      if (filters.severity !== "all") params.set("severity", filters.severity);
      if (filters.kind !== "all") params.set("kind", filters.kind);
      if (filters.channelId !== "all")
        params.set("channelId", filters.channelId);
      if (filters.q.trim()) params.set("search", filters.q.trim());
      if (filters.customRange) {
        const tz = getLocalTimeZone();
        params.set("from", filters.customRange.start.toDate(tz).toISOString());
        params.set("to", filters.customRange.end.toDate(tz).toISOString());
      }
      if (!reset && pagination?.nextCursor)
        params.set("cursor", pagination.nextCursor);
      const res = await request<{
        data: ApiNotificationLogRow[];
        pagination: ApiPagination;
      }>(`/endpoints/${endpointId}/notifications/log?${params}`);
      const rows = res?.data?.data ?? [];
      const next = res?.data?.pagination ?? null;
      if (res?.status != null && res.status < 400) {
        if (reset) setLog(rows);
        else setLog((prev) => [...prev, ...rows]);
        setPagination(next);
      } else if (reset) {
        setLog([]);
        setPagination(null);
      }
      if (reset) setLoading(false);
      else setLoadingMore(false);
    },
    [
      endpointId,
      filters.status,
      filters.severity,
      filters.kind,
      filters.channelId,
      filters.customRange,
      pagination?.nextCursor,
      request,
    ],
  );

  useEffect(() => {
    const t = setTimeout(() => void fetchLog(true), 120);
    return () => {
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    endpointId,
    filters.status,
    filters.severity,
    filters.kind,
    filters.channelId,
    filters.customRange,
    filters.q,
  ]);

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    if (!q) return log;
    return log.filter((r) =>
      `${r.messageSummary} ${r.channelTarget}`.toLowerCase().includes(q),
    );
  }, [log, filters.q]);

  const patch = (p: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...p }));
  };

  const channelOpts = useMemo<{ id: string; label: string }[]>(() => {
    const used = new Set<string>();
    for (const r of log) used.add(r.channelId);
    const opts: { id: string; label: string }[] = [
      { id: "all", label: "All channels" },
    ];
    for (const id of used) {
      const c = channelById.get(id);
      opts.push({ id, label: c?.name ?? "Unknown" });
    }
    return opts;
  }, [log, channelById]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <RoutesSection
        routeChannels={routeChannels}
        pausedChannelIds={pausedIds}
        onTogglePause={togglePause}
      />

      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <Segmented<StatusFilter>
          options={[
            { key: "all", label: "All" },
            { key: "sent", label: "Sent" },
            { key: "failed", label: "Failed" },
            { key: "suppressed", label: "Suppressed" },
            { key: "pending", label: "Pending" },
          ]}
          value={filters.status}
          onChange={(status) => {
            patch({ status });
          }}
          ariaLabel="Delivery status"
        />
        <FilterDropdown<SeverityFilter>
          value={filters.severity}
          options={[
            { id: "all", label: "All severities" },
            { id: "critical", label: "Critical", dot: "var(--wd-danger)" },
            { id: "warning", label: "Warning", dot: "var(--wd-warning)" },
            { id: "info", label: "Info", dot: "var(--wd-primary)" },
            { id: "success", label: "Success", dot: "var(--wd-success)" },
          ]}
          onChange={(severity) => {
            patch({ severity });
          }}
          ariaLabel="Notification severity"
        />
        <FilterDropdown<KindFilter>
          value={filters.kind}
          options={[
            { id: "all", label: "All event types" },
            { id: "incident_opened", label: "Opened" },
            { id: "incident_resolved", label: "Resolved" },
            { id: "incident_escalated", label: "Escalation" },
            { id: "channel_test", label: "Test" },
            { id: "custom", label: "Custom" },
          ]}
          onChange={(kind) => {
            patch({ kind });
          }}
          ariaLabel="Notification event type"
        />
        <DateRangeFilter
          value={filters.customRange}
          onChange={(customRange) => {
            patch({ customRange });
          }}
          ariaLabel="Delivery date range"
        />
        <FilterDropdown
          value={filters.channelId}
          options={channelOpts}
          onChange={(channelId) => {
            patch({ channelId });
          }}
          ariaLabel="Notifications channel"
        />
        <div className="ml-auto">
          <FilterSearch
            ariaLabel="Search notifications"
            value={filters.q}
            onChange={(q) => {
              patch({ q });
            }}
            placeholder="Summary, target…"
          />
        </div>
      </div>

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="text-[13px] font-semibold text-foreground">
              Delivery log
            </div>
            <TodayCountNotifications count={todayCount} />
          </div>
          <span className="text-[11px] text-wd-muted">
            Click a row to inspect
          </span>
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
          ) : filtered.length === 0 ? (
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
              {filtered.map((r) => {
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
                    onClick={() => void fetchLog(false)}
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

// ---------------------------------------------------------------------------
// Routes section — mini cards mirroring `.ep-nf-route` in the reference HTML.
//
// Each card lays out:
//   [type icon] [name / subtype]              [severity tag] [priority] [pause]
//
// The pause toggle is per-endpoint: it flips the channel id in/out of the
// endpoint's `pausedNotificationChannelIds` list. The channel itself stays
// enabled and keeps dispatching for other endpoints routed to it.
// ---------------------------------------------------------------------------

function RoutesSection({
  routeChannels,
  pausedChannelIds,
  onTogglePause,
}: {
  routeChannels: { main: ApiChannel[]; escalation: ApiChannel | null };
  pausedChannelIds: Set<string>;
  onTogglePause: (channelId: string, paused: boolean) => void;
}) {
  const hasRoutes = routeChannels.main.length > 0 || routeChannels.escalation;
  const escalationId = routeChannels.escalation?.id;
  // If the escalation channel is also in the main list, don't render it twice.
  const cards = [...routeChannels.main];
  if (routeChannels.escalation && !cards.some((c) => c.id === escalationId)) {
    cards.push(routeChannels.escalation);
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
      <SectionHead
        icon="solar:routing-linear"
        title="Routes"
        sub={`${routeChannels.main.length} channel${routeChannels.main.length === 1 ? "" : "s"}${routeChannels.escalation ? " · 1 escalation" : ""}`}
      />
      {hasRoutes ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
          {cards.map((c) => (
            <RouteCard
              key={c.id}
              channel={c}
              paused={pausedChannelIds.has(c.id)}
              isEscalation={c.id === escalationId}
              onTogglePause={(paused) => {
                onTogglePause(c.id, paused);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-wd-muted">
          No channels routed to this endpoint.
        </div>
      )}
    </div>
  );
}

function channelSubtype(channel: ApiChannel): string {
  switch (channel.type) {
    case "discord":
      return "Discord webhook";
    case "slack":
      return "Slack webhook";
    case "email":
      return "Email";
    case "webhook":
      return `Webhook · ${channel.webhookMethod ?? "POST"}`;
  }
}

const SEVERITY_FILTER_STYLE: Record<
  ApiChannel["severityFilter"],
  { label: string; className: string; tooltip: string }
> = {
  "info+": {
    label: "Info+",
    className: "bg-wd-primary/10 text-wd-primary",
    tooltip: "Sends info, warning, and critical alerts",
  },
  "warning+": {
    label: "Warn+",
    className: "bg-wd-warning/10 text-wd-warning",
    tooltip: "Sends warning and critical alerts only",
  },
  critical: {
    label: "Crit",
    className: "bg-wd-danger/10 text-wd-danger",
    tooltip: "Sends critical alerts only",
  },
};

function RouteCard({
  channel,
  paused,
  isEscalation,
  onTogglePause,
}: {
  channel: ApiChannel;
  paused: boolean;
  isEscalation: boolean;
  onTogglePause: (paused: boolean) => void;
}) {
  const sev = SEVERITY_FILTER_STYLE[channel.severityFilter];
  const isCritical = channel.deliveryPriority === "critical";

  return (
    <div
      className={cn(
        "grid grid-cols-[32px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3.5 py-2.5 rounded-lg border bg-wd-surface transition-colors",
        paused
          ? "border-wd-border/40 opacity-60"
          : isEscalation
            ? "border-wd-warning/40"
            : "border-wd-border/60 hover:border-wd-border",
      )}
    >
      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-wd-surface-hover/70 shrink-0">
        <Icon icon={CHANNEL_TYPE_ICON[channel.type]} width={16} />
      </div>

      <div className="flex flex-col min-w-0 gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-medium text-foreground truncate">
            {channel.name}
          </span>
          {isEscalation && (
            <span className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider font-semibold text-wd-warning shrink-0">
              <Icon icon="solar:double-alt-arrow-up-bold" width={10} />
              Escalation
            </span>
          )}
          {!channel.enabled && (
            <span className="text-[9px] uppercase tracking-wider font-semibold text-wd-muted shrink-0">
              off
            </span>
          )}
        </div>
        <div className="text-[11px] text-wd-muted font-mono truncate">
          {channelSubtype(channel)}
        </div>
      </div>

      <span
        className={cn(
          "inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wider",
          sev.className,
        )}
        title={sev.tooltip}
      >
        {sev.label}
      </span>

      <span
        title={
          isCritical
            ? "Critical delivery priority — bypasses rate limits and quiet hours"
            : "Standard delivery priority"
        }
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 shrink-0",
          isCritical ? "text-wd-danger" : "text-wd-muted-soft",
        )}
      >
        <Icon
          icon={isCritical ? "solar:bolt-bold" : "solar:bolt-outline"}
          width={14}
        />
      </span>

      <PauseToggle
        paused={paused}
        onChange={onTogglePause}
        channelName={channel.name}
      />
    </div>
  );
}

function PauseToggle({
  paused,
  onChange,
  channelName,
}: {
  paused: boolean;
  onChange: (paused: boolean) => void;
  channelName: string;
}) {
  const active = !paused;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={`${active ? "Pause" : "Resume"} notifications to ${channelName} from this endpoint`}
      title={
        active
          ? `Pause dispatch to ${channelName} from this endpoint`
          : `Resume dispatch to ${channelName} from this endpoint`
      }
      onClick={() => {
        onChange(!paused);
      }}
      className={cn(
        "relative inline-flex items-center h-[18px] w-8 rounded-full transition-colors cursor-pointer shrink-0",
        active ? "bg-wd-primary" : "bg-wd-border/70",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-wd-surface shadow transition-transform",
          active ? "translate-x-[16px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

function TodayCountNotifications({ count }: { count: number | null }) {
  if (count == null) {
    return (
      <span className="text-[11px] text-wd-muted font-mono opacity-60">
        loading…
      </span>
    );
  }
  if (count === 0) {
    return (
      <span className="text-[11px] text-wd-muted font-mono">
        no notifications in the last 24hrs
      </span>
    );
  }
  return (
    <span className="text-[11px] text-wd-muted font-mono">
      <span className="text-foreground">{count}</span>{" "}
      {count === 1 ? "notification" : "notifications"} in the last 24hrs
    </span>
  );
}

export default memo(NotificationsTabBase);
