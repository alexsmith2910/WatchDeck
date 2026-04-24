/**
 * Per-incident notification delivery log.
 *
 * Fetches `GET /notifications/log?incidentId=<id>` on mount and when the
 * incident resolves (the resolved dispatch fires a fresh row). Each row
 * shows the kind (opened / resolved / escalated / test / custom), channel
 * chip, target, delivery outcome, and latency. Failed rows are red-tinted
 * and show the provider's failure reason.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../../hooks/useApi";
import { useSSE } from "../../hooks/useSSE";
import { useFormat } from "../../hooks/useFormat";
import {
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
  KIND_LABEL,
  STATUS_STYLE,
  type ApiNotificationLogRow,
  type ChannelType,
  type DeliveryStatus,
} from "../../types/notifications";

interface Props {
  incidentId: string;
  endpointId: string;
}

/** Exposed back to the page so the summary-strip stays in sync. */
export interface NotificationCounts {
  total: number;
  uniqueChannels: number;
}

function IncidentNotificationsLogBase({ incidentId, endpointId }: Props) {
  const { request } = useApi();
  const { subscribe } = useSSE();
  const fmt = useFormat();
  const [rows, setRows] = useState<ApiNotificationLogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLog = useCallback(async () => {
    const res = await request<{ data: ApiNotificationLogRow[] }>(
      `/notifications/log?incidentId=${encodeURIComponent(incidentId)}&limit=100`,
    );
    if (res.status < 400 && res.data?.data) {
      setRows(
        [...res.data.data].sort(
          (a, b) =>
            new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
        ),
      );
    }
    setLoading(false);
  }, [incidentId, request]);

  useEffect(() => {
    void fetchLog();
  }, [fetchLog]);

  // Any dispatch-related SSE event concerning our incident or endpoint → refetch.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const refetchOnMatch = (raw: unknown) => {
      const p = raw as { incidentId?: string; endpointId?: string };
      if (p.incidentId === incidentId || p.endpointId === endpointId) {
        void fetchLog();
      }
    };
    offs.push(subscribe("notification:dispatched", refetchOnMatch));
    offs.push(subscribe("notification:failed", refetchOnMatch));
    offs.push(subscribe("notification:suppressed", refetchOnMatch));
    offs.push(subscribe("notification:escalationFired", refetchOnMatch));
    return () => {
      for (const off of offs) off();
    };
  }, [subscribe, fetchLog, incidentId, endpointId]);

  const delivered = useMemo(
    () => rows.filter((r) => r.deliveryStatus === "sent").length,
    [rows],
  );
  const failed = useMemo(
    () => rows.filter((r) => r.deliveryStatus === "failed").length,
    [rows],
  );

  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
          <Icon icon="solar:bell-bing-linear" width={14} />
        </div>
        <div>
          <div className="text-[13px] font-semibold">Notifications fired</div>
          <div className="text-[11px] font-mono text-wd-muted">
            {rows.length} events · {delivered} delivered · {failed} failed
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-[11.5px] text-wd-muted text-center py-6">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-[11.5px] text-wd-muted text-center py-6">
          No notifications dispatched for this incident.
        </div>
      ) : (
        <NotifList rows={rows} fmtTime={fmt.time} />
      )}
    </div>
  );
}

const NOTIF_COLLAPSE_LIMIT = 6;

function NotifList({
  rows,
  fmtTime,
}: {
  rows: ApiNotificationLogRow[];
  fmtTime: (d: string | Date) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible =
    expanded || rows.length <= NOTIF_COLLAPSE_LIMIT
      ? rows
      : rows.slice(-NOTIF_COLLAPSE_LIMIT); // most-recent N when collapsed
  const hidden = rows.length - visible.length;
  return (
    <div className="flex flex-col gap-1.5">
      {hidden > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium text-wd-primary hover:bg-wd-primary/5 border border-dashed border-wd-border/50 cursor-pointer"
        >
          <Icon icon="solar:alt-arrow-up-linear" width={11} />
          Show {hidden} earlier event{hidden === 1 ? "" : "s"}
        </button>
      )}
      {visible.map((n) => (
        <NotifRow key={n._id} row={n} fmtTime={fmtTime} />
      ))}
      {expanded && rows.length > NOTIF_COLLAPSE_LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium text-wd-muted hover:bg-wd-surface-hover cursor-pointer"
        >
          <Icon icon="solar:alt-arrow-down-linear" width={11} />
          Collapse
        </button>
      )}
    </div>
  );
}

function NotifRow({
  row,
  fmtTime,
}: {
  row: ApiNotificationLogRow;
  fmtTime: (d: string | Date) => string;
}) {
  const status: DeliveryStatus = row.deliveryStatus;
  const isFailed = status === "failed";
  const isSuppressed = status === "suppressed";
  const tone =
    isFailed
      ? "bg-wd-danger/5 border-wd-danger/25"
      : isSuppressed
        ? "bg-wd-warning/5 border-wd-warning/20"
        : row.kind === "incident_resolved"
          ? "bg-wd-success/5 border-wd-success/20"
          : "bg-wd-surface-hover/30 border-wd-border/30";

  const channelType = row.channelType as ChannelType;
  const channelIcon = CHANNEL_TYPE_ICON[channelType] ?? "solar:bell-linear";
  const channelLabel =
    CHANNEL_TYPE_LABEL[channelType] ?? String(row.channelType);

  return (
    <div
      className={cn(
        "grid grid-cols-[26px_1fr_auto] gap-2.5 items-start px-2.5 py-2 rounded-lg border",
        tone,
      )}
    >
      <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-surface border border-wd-border/50 text-wd-muted">
        <Icon icon={channelIcon} width={14} />
      </div>
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="inline-flex items-center gap-2 text-[12px] flex-wrap">
          <span className="font-semibold">
            {eventLabel(row.kind, row.retryOf != null)}
          </span>
          <span className="rounded px-1.5 py-[1px] text-[10px] font-mono uppercase tracking-[0.08em] bg-wd-surface border border-wd-border/50 text-wd-muted/80">
            {channelLabel}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-[1px] text-[9.5px] font-semibold font-mono uppercase tracking-[0.08em] inline-flex items-center gap-1",
              STATUS_STYLE[status].className,
            )}
          >
            <Icon
              icon={
                status === "sent"
                  ? "solar:check-circle-bold"
                  : status === "failed"
                    ? "solar:close-circle-bold"
                    : status === "suppressed"
                      ? "solar:volume-cross-linear"
                      : "solar:clock-circle-linear"
              }
              width={11}
            />
            {STATUS_STYLE[status].label}
          </span>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11px] font-mono text-wd-muted min-w-0">
          <span className="text-wd-muted/60">→</span>
          <span className="truncate" title={row.channelTarget}>
            {row.channelTarget}
          </span>
        </div>
        {isFailed && row.failureReason && (
          <div className="inline-flex items-center gap-1 text-[10.5px] font-mono text-wd-danger mt-0.5">
            <Icon icon="solar:danger-circle-linear" width={11} />
            {row.failureReason}
            {row.latencyMs != null && ` (after ${row.latencyMs}ms)`}
          </div>
        )}
        {isSuppressed && row.suppressedReason && (
          <div className="inline-flex items-center gap-1 text-[10.5px] font-mono text-wd-warning mt-0.5">
            <Icon icon="solar:volume-cross-linear" width={11} />
            {prettyReason(row.suppressedReason)}
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="text-[11px] font-mono text-foreground">
          {fmtTime(row.sentAt)}
        </div>
        {row.latencyMs != null && (
          <div className="text-[10px] font-mono text-wd-muted/80">
            {row.latencyMs}ms
          </div>
        )}
      </div>
    </div>
  );
}

function eventLabel(kind: string, isRetry: boolean): string {
  if (isRetry) return "Retry delivered";
  return KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind;
}

function prettyReason(r: string): string {
  return r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default memo(IncidentNotificationsLogBase);
