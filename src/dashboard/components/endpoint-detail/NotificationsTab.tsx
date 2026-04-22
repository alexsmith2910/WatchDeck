/**
 * Notifications tab — routes attached to this endpoint, plus the delivery log
 * scoped to it.
 *
 * Rows expand into a two-column accordion modelled on the design mock at
 * `temp/endpoint details/Endpoint.tabs.jsx`. The API still doesn't persist
 * payload, raw HTTP response, retry timeline, or the original request, so
 * those sections render inside a RainbowPlaceholder while the fields we do
 * have (trigger, target, latency, failure reason, suppression reason) render
 * as plain kv-lists on the left side.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { DateValue, RangeValue } from "react-aria-components";
import { getLocalTimeZone } from "@internationalized/date";
import { useApi } from "../../hooks/useApi";
import type { ApiEndpoint, ApiPagination } from "../../types/api";
import {
  type ApiChannel,
  type ApiNotificationLogRow,
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
  KIND_LABEL,
  STATUS_STYLE,
  SEVERITY_STYLE,
} from "../../types/notifications";
import { formatDateTime, timeAgo } from "../../utils/format";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
  RainbowPlaceholder,
  SectionHead,
  Segmented,
} from "./primitives";

type StatusFilter = "all" | "sent" | "failed" | "suppressed" | "pending";

interface Filters {
  status: StatusFilter;
  channelId: string;
  customRange: RangeValue<DateValue> | null;
  q: string;
}

const DEFAULTS: Filters = {
  status: "all",
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

  const channelById = useMemo(() => {
    const m = new Map<string, ApiChannel>();
    for (const c of channels) m.set(c._id, c);
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

  const fetchLog = useCallback(
    async (reset = true) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filters.status !== "all") params.set("status", filters.status);
      if (filters.channelId !== "all")
        params.set("channelId", filters.channelId);
      if (filters.q.trim()) params.set("search", filters.q.trim());
      if (filters.customRange) {
        const tz = getLocalTimeZone();
        params.set(
          "from",
          filters.customRange.start.toDate(tz).toISOString(),
        );
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
      filters.channelId,
      filters.customRange,
      pagination?.nextCursor,
      request,
    ],
  );

  useEffect(() => {
    const t = setTimeout(() => void fetchLog(true), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    endpointId,
    filters.status,
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

  const patch = (p: Partial<Filters>) =>
    setFilters((prev) => ({ ...prev, ...p }));

  const channelOpts = useMemo<Array<{ id: string; label: string }>>(() => {
    const used = new Set<string>();
    for (const r of log) used.add(r.channelId);
    const opts: Array<{ id: string; label: string }> = [
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
      <RoutesSection routeChannels={routeChannels} />

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
          onChange={(status) => patch({ status })}
          ariaLabel="Delivery status"
        />
        <DateRangeFilter
          value={filters.customRange}
          onChange={(customRange) => patch({ customRange })}
          ariaLabel="Delivery date range"
        />
        <FilterDropdown
          value={filters.channelId}
          options={channelOpts}
          onChange={(channelId) => patch({ channelId })}
          ariaLabel="Notifications channel"
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-wd-muted font-mono">
            {filtered.length} shown
          </span>
          <FilterSearch
            ariaLabel="Search notifications"
            value={filters.q}
            onChange={(q) => patch({ q })}
            placeholder="Summary, target…"
          />
        </div>
      </div>

      <div className="rounded-xl border border-wd-border/50 bg-wd-surface overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-wd-border/50">
          <div className="flex items-center gap-2.5">
            <div className="text-[13px] font-semibold text-foreground">
              Delivery log
            </div>
            <span className="text-[11px] text-wd-muted font-mono">
              {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
            </span>
          </div>
          <span className="text-[11px] text-wd-muted">
            Click a row to inspect
          </span>
        </div>

        <div className="grid grid-cols-[14px_150px_180px_minmax(180px,1fr)_110px_88px_60px_22px] items-center gap-x-3 px-4 py-1.5 text-[10px] uppercase tracking-wider text-wd-muted border-b border-wd-border/40 font-semibold">
          <span />
          <span>When</span>
          <span>Channel</span>
          <span>Event</span>
          <span>Type</span>
          <span>Status</span>
          <span className="text-right">Latency</span>
          <span />
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
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
            {filtered.map((r) => (
              <LogRow
                key={r._id}
                row={r}
                channel={channelById.get(r.channelId) ?? null}
                expanded={expandedId === r._id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === r._id ? null : r._id))
                }
              />
            ))}
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
  );
}

// ---------------------------------------------------------------------------
// Routes section
// ---------------------------------------------------------------------------

function RoutesSection({
  routeChannels,
}: {
  routeChannels: { main: ApiChannel[]; escalation: ApiChannel | null };
}) {
  const hasRoutes = routeChannels.main.length > 0 || routeChannels.escalation;
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
      <SectionHead
        icon="solar:routing-linear"
        title="Routes"
        sub={`${routeChannels.main.length} channel${routeChannels.main.length === 1 ? "" : "s"}${routeChannels.escalation ? " · 1 escalation" : ""}`}
      />
      {hasRoutes ? (
        <div className="flex flex-wrap gap-2">
          {routeChannels.main.map((c) => (
            <RouteChip key={c._id} channel={c} />
          ))}
          {routeChannels.escalation && (
            <RouteChip channel={routeChannels.escalation} escalation />
          )}
        </div>
      ) : (
        <div className="text-[12px] text-wd-muted">
          No channels routed to this endpoint.
        </div>
      )}
    </div>
  );
}

function RouteChip({
  channel,
  escalation = false,
}: {
  channel: ApiChannel;
  escalation?: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 h-8 rounded-lg border text-[12px]",
        escalation
          ? "border-wd-warning/40 bg-wd-warning/5 text-wd-warning"
          : "border-wd-border/50 bg-wd-surface-hover/40 text-foreground",
      )}
    >
      <Icon icon={CHANNEL_TYPE_ICON[channel.type]} width={14} />
      <span className="font-medium">{channel.name}</span>
      <span className="text-[10.5px] text-wd-muted font-mono">
        {CHANNEL_TYPE_LABEL[channel.type]}
      </span>
      {escalation && (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono">
          <Icon icon="solar:escalation-linear" width={12} />
          escalation
        </span>
      )}
      {!channel.enabled && (
        <span className="text-[10px] text-wd-muted uppercase tracking-wider">
          off
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log row
// ---------------------------------------------------------------------------

function LogRow({
  row,
  channel,
  expanded,
  onToggle,
}: {
  row: ApiNotificationLogRow;
  channel: ApiChannel | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const style = STATUS_STYLE[row.deliveryStatus];
  const latency =
    row.latencyMs != null
      ? `${row.latencyMs}ms`
      : row.deliveryStatus === "suppressed"
        ? "—"
        : row.failureReason
          ? "err"
          : "—";
  return (
    <li className="bg-wd-surface">
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[14px_150px_180px_minmax(180px,1fr)_110px_88px_60px_22px] items-center gap-x-3 px-4 py-2 text-left hover:bg-wd-surface-hover/60 transition-colors cursor-pointer"
      >
        <span
          className={cn(
            "w-2 h-2 rounded-full shrink-0",
            SEVERITY_STYLE[row.severity],
          )}
        />
        <span className="text-[11.5px] font-mono text-foreground truncate leading-tight">
          {formatDateTime(row.sentAt)}
          <span className="block text-[10px] text-wd-muted">
            {timeAgo(row.sentAt)}
          </span>
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <Icon
            icon={CHANNEL_TYPE_ICON[row.channelType]}
            width={13}
            className="shrink-0"
          />
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="text-[11.5px] text-foreground truncate">
              {channel?.name ?? CHANNEL_TYPE_LABEL[row.channelType]}
            </span>
            <span
              className="text-[10px] text-wd-muted font-mono truncate"
              title={row.channelTarget}
            >
              → {row.channelTarget}
            </span>
          </span>
        </span>
        <span className="text-[11.5px] text-foreground truncate">
          {row.messageSummary}
        </span>
        <span className="text-[10.5px] font-mono text-wd-muted uppercase tracking-wider">
          {KIND_LABEL[row.kind]}
        </span>
        <span
          className={cn(
            "inline-flex items-center justify-center h-5 px-2 rounded text-[10px] leading-none font-semibold uppercase tracking-wider w-fit pt-[1px]",
            style.className,
          )}
        >
          {style.label}
        </span>
        <span
          className={cn(
            "text-[11px] font-mono text-right tabular-nums",
            row.latencyMs != null ? "text-foreground" : "text-wd-muted-soft",
          )}
        >
          {latency}
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
      {expanded && <LogExpansion row={row} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Accordion body — Trigger + Delivery (real) / Payload + Response + Retries +
// Reproduce request (placeholder, wrapped in the shared RainbowPlaceholder
// shell). Layout mirrors `temp/endpoint details/Endpoint.tabs.jsx`.
// ---------------------------------------------------------------------------

function LogExpansion({ row }: { row: ApiNotificationLogRow }) {
  const firedAt = new Date(row.sentAt).toLocaleString();
  const triggerId =
    row.incidentId ??
    row.retryOf ??
    (row.kind === "channel_test" ? "channel test" : "—");

  const deliveryItems: Array<[string, ReactNode]> = [
    ["Target", row.channelTarget],
    [
      "Status",
      <span key="s" className="capitalize">
        {row.deliveryStatus}
      </span>,
    ],
    ["Latency", row.latencyMs != null ? `${row.latencyMs}ms` : "—"],
  ];
  if (row.failureReason)
    deliveryItems.push([
      "Failure",
      <span key="f" className="text-wd-danger break-all">
        {row.failureReason}
      </span>,
    ]);
  if (row.suppressedReason)
    deliveryItems.push([
      "Suppressed",
      <span key="sup" className="text-wd-warning">
        {row.suppressedReason.replace(/_/g, " ")}
      </span>,
    ]);
  if (row.retryOf)
    deliveryItems.push([
      "Retry of",
      <span key="r" className="truncate">
        {row.retryOf}
      </span>,
    ]);
  if (row.coalescedCount)
    deliveryItems.push(["Coalesced", `${row.coalescedCount} events`]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 px-5 pt-4 pb-[18px] bg-[var(--surface-secondary)] border-t border-wd-border/40">
      {/* Left: Trigger + Delivery (real data) */}
      <div className="flex flex-col gap-4 min-w-0">
        <Section title="Trigger">
          <KvList
            items={[
              ["Type", KIND_LABEL[row.kind]],
              ["ID", triggerId],
              [
                "Severity",
                <span key="sev" className="capitalize">
                  {row.severity}
                </span>,
              ],
              ["Fired at", firedAt],
            ]}
          />
        </Section>
        <Section title="Delivery">
          <KvList items={deliveryItems} />
        </Section>
      </div>

      {/* Right: Payload + Response + Retries + Reproduce (not yet captured) */}
      <div className="min-w-0">
        <RainbowPlaceholder className="min-h-[260px]" rounded="rounded-lg">
          <div className="flex flex-col gap-3">
            <PlaceholderCard
              title="Payload"
              body="— payload not yet captured —"
            />
            <PlaceholderCard
              title="Response"
              body="— response body not yet captured —"
            />
            <PlaceholderCard
              title="Retries"
              body="— retry timeline not yet captured —"
            />
            <PlaceholderCard
              title="Reproduce request"
              body="— request not yet captured —"
              trailing={
                <span className="inline-flex items-center gap-1 text-[10.5px] text-wd-muted-soft font-mono">
                  <Icon icon="solar:copy-outline" width={11} />
                  Copy cURL
                </span>
              }
            />
          </div>
        </RainbowPlaceholder>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

function KvList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="flex flex-col gap-1 font-mono text-[12px] min-w-0">
      {items.map(([k, v]) => (
        <div key={k} className="flex gap-2.5 min-w-0">
          <dt className="text-wd-muted min-w-[90px] shrink-0">{k}</dt>
          <dd className="text-foreground break-all min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlaceholderCard({
  title,
  body,
  trailing,
}: {
  title: string;
  body: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-wd-surface/90 border border-wd-border/50 p-3 text-[12px]">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
          {title}
        </div>
        {trailing}
      </div>
      <div className="font-mono text-wd-muted">{body}</div>
    </div>
  );
}

export default memo(NotificationsTabBase);
