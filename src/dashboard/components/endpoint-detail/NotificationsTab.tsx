/**
 * Notifications tab — routes attached to this endpoint, plus the delivery log
 * scoped to it.
 *
 * Rows expand into a two-column accordion: trigger + delivery metadata on the
 * left, and the four rich expansion cards (payload, response, retry chain,
 * reproduce cURL) on the right — see `LogExpansionCards`. Cards fall back to
 * rainbow shimmer for rows written before payload/request/response capture
 * landed.
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
import { toast } from "../../ui/toast";
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
  buildCurl,
  resolveLiveUrl,
} from "../notifications/LogExpansionCards";
import {
  DateRangeFilter,
  FilterDropdown,
  FilterSearch,
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
            {filtered.map((r) => {
              const rowChannel = channelById.get(r.channelId) ?? null;
              return (
                <LogRow
                  key={r._id}
                  row={r}
                  channel={rowChannel}
                  expanded={expandedId === r._id}
                  onToggle={() =>
                    setExpandedId((prev) =>
                      prev === r._id ? null : r._id,
                    )
                  }
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
  const escalationId = routeChannels.escalation?._id;
  // If the escalation channel is also in the main list, don't render it twice.
  const cards = [...routeChannels.main];
  if (
    routeChannels.escalation &&
    !cards.some((c) => c._id === escalationId)
  ) {
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
              key={c._id}
              channel={c}
              paused={pausedChannelIds.has(c._id)}
              isEscalation={c._id === escalationId}
              onTogglePause={(paused) => onTogglePause(c._id, paused)}
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
      return channel.discordTransport === "bot"
        ? "Discord bot"
        : "Discord webhook";
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
      onClick={() => onChange(!paused)}
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
      {expanded && <LogExpansion row={row} channel={channel} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Accordion body — 2x2 grid of sections:
//
//   Trigger   |  Response
//   Payload   |  Reproduce request
//
// Plain `<h5>`-style headers with key/value lists underneath, no framed
// cards — styling mirrors `temp/endpoint details/Endpoint.tabs.jsx`. Payload
// shows the raw outbound JSON body (what actually went over the wire — for
// Discord that's the embed with fields / footer / author, etc.) in a bordered
// box; it falls back to the abstracted title/summary/markdown when no request
// was captured, then to a plain "not captured" note for pre-schema rows.
// Retry chain inspection lives in the detail drawer; the row header already
// surfaces the attempt status at a glance.
// ---------------------------------------------------------------------------

function LogExpansion({
  row,
  channel,
}: {
  row: ApiNotificationLogRow;
  channel: ApiChannel | null;
}) {
  const firedAt = formatDateTime(row.sentAt);
  const triggerId =
    row.incidentId ??
    row.retryOf ??
    (row.kind === "channel_test" ? "channel test" : "—");

  const triggerItems: Array<[string, ReactNode]> = [
    ["Type", KIND_LABEL[row.kind]],
    ["ID", triggerId],
    [
      "Severity",
      <span key="sev" className="capitalize">
        {row.severity}
      </span>,
    ],
    ["Fired at", firedAt],
  ];
  if (row.retryOf)
    triggerItems.push([
      "Retry of",
      <span key="r" className="truncate">
        {row.retryOf}
      </span>,
    ]);
  if (row.coalescedCount && row.coalescedCount > 1)
    triggerItems.push(["Coalesced", `${row.coalescedCount} events`]);

  const isCoalescedSummary = (row.coalescedCount ?? 0) > 1;
  const isEmailChannel = row.channelType === "email";
  const showReproduce = !isCoalescedSummary && !isEmailChannel;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 px-5 pt-4 pb-[18px] bg-[var(--surface-secondary)] border-t border-wd-border/40">
      {/* Top-left: Trigger */}
      <Section title="Trigger">
        <KvList items={triggerItems} />
      </Section>

      {/* Top-right: Response */}
      <Section title="Response">
        <ResponseSection row={row} />
      </Section>

      {/* Bottom-left: Payload */}
      <Section title="Payload">
        <PayloadSection row={row} />
      </Section>

      {/* Bottom-right: Reproduce request */}
      <Section title="Reproduce request">
        {showReproduce ? (
          <ReproduceSection row={row} channel={channel} />
        ) : (
          <div className="text-[12px] text-wd-muted">
            {isEmailChannel
              ? "Not applicable — email dispatch."
              : "Not applicable — coalesced summary."}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTTP status text for common codes — keeps the Response row self-describing
// without round-tripping to the server or pulling in a dependency.
// ---------------------------------------------------------------------------

const HTTP_STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function prettyJson(body: string | undefined | null): {
  text: string;
  isJson: boolean;
} | null {
  if (!body) return null;
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), isJson: true };
  } catch {
    return { text: body, isJson: false };
  }
}

// ---------------------------------------------------------------------------
// Section bodies
// ---------------------------------------------------------------------------

function ResponseSection({ row }: { row: ApiNotificationLogRow }) {
  const res = row.response;
  const sentAt = formatDateTime(row.sentAt);
  const method = row.request?.method;
  const target = res?.url ?? row.request?.url;

  // Suppressed row — we never made a request; surface the reason prominently
  // instead of pretending there's response detail to show.
  if (!res && row.deliveryStatus === "suppressed" && row.suppressedReason) {
    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-start gap-1.5 text-[12px] text-wd-warning">
          <Icon
            icon="solar:shield-cross-bold"
            width={13}
            className="shrink-0 mt-0.5"
          />
          <span className="capitalize">
            Suppressed — {row.suppressedReason.replace(/_/g, " ")}. No request
            sent.
          </span>
        </div>
        <KvList items={[["Fired at", sentAt]]} />
      </div>
    );
  }

  const items: Array<[string, ReactNode]> = [];
  if (res && typeof res.statusCode === "number") {
    const text = HTTP_STATUS_TEXT[res.statusCode];
    items.push([
      "HTTP",
      <span
        key="http"
        className={cn(
          "font-semibold",
          res.statusCode < 300
            ? "text-wd-success"
            : res.statusCode < 400
              ? "text-wd-primary"
              : "text-wd-danger",
        )}
      >
        {res.statusCode}
        {text ? ` ${text}` : ""}
      </span>,
    ]);
  } else {
    items.push([
      "Status",
      <span
        key="st"
        className={cn(
          "capitalize",
          row.deliveryStatus === "sent"
            ? "text-wd-success"
            : row.deliveryStatus === "failed"
              ? "text-wd-danger"
              : "text-foreground",
        )}
      >
        {row.deliveryStatus}
      </span>,
    ]);
  }
  if (method) items.push(["Method", method]);
  items.push([
    "Latency",
    row.latencyMs != null ? `${row.latencyMs}ms` : "—",
  ]);
  items.push(["Sent at", sentAt]);
  if (target) {
    items.push([
      "URL",
      <span key="url" className="break-all" title={target}>
        {target}
      </span>,
    ]);
  }
  if (res?.providerId) {
    items.push([
      "Provider ID",
      <span key="pid" className="truncate" title={res.providerId}>
        {res.providerId}
      </span>,
    ]);
  }
  if (row.failureReason) {
    items.push([
      "Failure",
      <span key="fail" className="text-wd-danger break-all">
        {row.failureReason}
      </span>,
    ]);
  }

  const body = prettyJson(res?.bodyExcerpt);
  const hasPreSchemaHole = !res && row.deliveryStatus !== "suppressed";

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <KvList items={items} />
      {body ? (
        <div className="rounded-md border border-wd-border/50 bg-wd-surface-hover/30 overflow-hidden">
          <div className="flex items-center justify-between px-2.5 py-1 border-b border-wd-border/40 text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold">
            <span>Response body</span>
            <span className="font-mono normal-case text-[10px] tracking-normal">
              {body.isJson ? "json" : "text"}
            </span>
          </div>
          <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words px-2.5 py-2 max-h-64 overflow-auto">
            {body.text}
          </pre>
        </div>
      ) : hasPreSchemaHole ? (
        <div className="text-[12px] text-wd-muted italic">
          No response body captured.
        </div>
      ) : null}
    </div>
  );
}

function PayloadSection({ row }: { row: ApiNotificationLogRow }) {
  // Preferred source: the real outbound HTTP body — for Discord that's the
  // full embed (fields, footer, author, timestamp, color). Falls back to the
  // abstracted title/summary/markdown when the request wasn't captured (e.g.
  // email, suppressed rows).
  const rawBody = row.request?.body;
  const pretty = prettyJson(rawBody);
  const abstract = row.payload;

  if (!pretty && !abstract) {
    return (
      <div className="text-[12px] text-wd-muted italic">
        No payload captured.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {pretty ? (
        <div className="rounded-md border border-wd-border/50 bg-wd-surface-hover/30 overflow-hidden">
          <div className="flex items-center justify-between px-2.5 py-1 border-b border-wd-border/40 text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold">
            <span>
              {CHANNEL_TYPE_LABEL[row.channelType]} request body
            </span>
            <span className="font-mono normal-case text-[10px] tracking-normal">
              {pretty.isJson ? "json" : "text"}
            </span>
          </div>
          <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words px-2.5 py-2 max-h-80 overflow-auto">
            {pretty.text}
          </pre>
        </div>
      ) : abstract ? (
        <div className="rounded-md border border-wd-border/50 bg-wd-surface-hover/30 p-2.5 flex flex-col gap-1.5">
          {abstract.title && (
            <div className="text-[13px] font-semibold text-foreground">
              {abstract.title}
            </div>
          )}
          {abstract.summary && (
            <div className="text-[12px] text-wd-muted">
              {abstract.summary}
            </div>
          )}
          {abstract.markdown && (
            <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words bg-wd-surface/60 rounded px-2 py-1.5 max-h-48 overflow-auto border border-wd-border/30">
              {abstract.markdown}
            </pre>
          )}
          {abstract.fields && abstract.fields.length > 0 && (
            <dl className="flex flex-col gap-1 font-mono text-[11.5px] min-w-0">
              {abstract.fields.map((f, i) => (
                <div
                  key={`${f.label}-${i}`}
                  className="flex gap-2.5 min-w-0"
                >
                  <dt className="text-wd-muted min-w-[90px] shrink-0">
                    {f.label}
                  </dt>
                  <dd className="text-foreground break-all min-w-0">
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ReproduceSection({
  row,
  channel,
}: {
  row: ApiNotificationLogRow;
  channel: ApiChannel | null;
}) {
  if (!row.request) {
    return (
      <div className="text-[12px] text-wd-muted italic">
        No request captured.
      </div>
    );
  }
  const request = row.request;
  const displayCurl = buildCurl(request);
  const copy = () => {
    const liveUrl = resolveLiveUrl(channel) ?? request.url;
    const payload = buildCurl({ ...request, url: liveUrl });
    void navigator.clipboard.writeText(payload);
    if (liveUrl === request.url) {
      toast.success("Copied as cURL", {
        description:
          "URL secret still redacted — paste your token before running.",
      });
    } else {
      toast.success("Copied as cURL");
    }
  };
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] text-wd-primary hover:underline font-mono"
        >
          <Icon icon="solar:copy-linear" width={13} />
          Copy cURL
        </button>
      </div>
      <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-all bg-wd-surface-hover/30 rounded px-2 py-1.5 max-h-48 overflow-auto">
        {displayCurl}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared section primitives
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
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


export default memo(NotificationsTabBase);
