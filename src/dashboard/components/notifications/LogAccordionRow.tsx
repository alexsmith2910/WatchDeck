/**
 * Shared accordion row for the notification delivery log.
 *
 * Renders one row of the delivery log plus its inline expansion (a 2x2 grid:
 * Trigger / Response / Payload / Reproduce). Pure presentation — the parent
 * owns expand/collapse state and passes `expanded` / `onToggle`.
 *
 * Used by both `endpoint-detail/NotificationsTab` (per-endpoint log) and
 * `notifications/DeliveryLog` (cross-endpoint log on the Notifications page).
 */
import { type ReactNode } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "../../ui/toast";
import {
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
  KIND_LABEL,
  SEVERITY_STYLE,
  STATUS_STYLE,
  type ApiChannel,
  type ApiNotificationLogRow,
} from "../../types/notifications";
import { formatDateTime, timeAgo } from "../../utils/format";
import { buildCurl, resolveLiveUrl } from "./notificationCurl";

export const LOG_ROW_GRID =
  "grid grid-cols-[14px_200px_180px_minmax(180px,1fr)_110px_88px_60px_22px] items-center gap-x-3";

// Webhook URLs are stored redacted (e.g. discord → `https://discord.com/api`,
// slack → `https://hooks.slack.com/services`), so showing the target verbatim
// just repeats the channel type. Surface a friendly label instead; raw value
// stays on the parent's `title` for confirmation.
function channelTargetLabel(
  channelType: ApiNotificationLogRow["channelType"],
  target: string,
): string {
  switch (channelType) {
    case "discord":
      return "Discord webhook";
    case "slack":
      return "Slack webhook";
    case "webhook":
      return "Webhook";
    default:
      return target;
  }
}

interface LogRowProps {
  row: ApiNotificationLogRow;
  channel: ApiChannel | null;
  expanded: boolean;
  onToggle: () => void;
}

export function LogRow({ row, channel, expanded, onToggle }: LogRowProps) {
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
        className={cn(
          LOG_ROW_GRID,
          "w-full px-4 py-2 text-left hover:bg-wd-surface-hover/60 transition-colors cursor-pointer",
        )}
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
              → {channelTargetLabel(row.channelType, row.channelTarget)}
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
// Accordion body — 2x2 grid: Trigger | Response / Payload | Reproduce.
// Cards inline (no framed boxes), payload prefers raw outbound HTTP body and
// falls back to the abstracted title/summary/markdown when no request was
// captured.
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

  const triggerItems: [string, ReactNode][] = [
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
      <Section title="Trigger">
        <KvList items={triggerItems} />
      </Section>

      <Section title="Response">
        <ResponseSection row={row} />
      </Section>

      <Section title="Payload">
        <PayloadSection row={row} />
      </Section>

      <Section title="cURL">
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
// without round-tripping to the server.
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

function ResponseSection({ row }: { row: ApiNotificationLogRow }) {
  const res = row.response;
  const sentAt = formatDateTime(row.sentAt);
  const method = row.request?.method;
  const target = res?.url ?? row.request?.url;

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

  const items: [string, ReactNode][] = [];
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
  items.push(["Latency", row.latencyMs != null ? `${row.latencyMs}ms` : "—"]);
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
          <pre className="wd-scroll-thin text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words px-2.5 py-2 max-h-64 overflow-auto">
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
            <span>{CHANNEL_TYPE_LABEL[row.channelType]} request body</span>
            <span className="font-mono normal-case text-[10px] tracking-normal">
              {pretty.isJson ? "json" : "text"}
            </span>
          </div>
          <pre className="wd-scroll-thin text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words px-2.5 py-2 max-h-80 overflow-auto">
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
            <div className="text-[12px] text-wd-muted">{abstract.summary}</div>
          )}
          {abstract.markdown && (
            <pre className="wd-scroll-thin text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words bg-wd-surface/60 rounded px-2 py-1.5 max-h-48 overflow-auto border border-wd-border/30">
              {abstract.markdown}
            </pre>
          )}
          {abstract.fields && abstract.fields.length > 0 && (
            <dl className="flex flex-col gap-1 font-mono text-[11.5px] min-w-0">
              {abstract.fields.map((f, i) => (
                <div key={`${f.label}-${i}`} className="flex gap-2.5 min-w-0">
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
    <div className="flex flex-col gap-2 min-w-0">
      <div className="rounded-md border border-wd-border/50 bg-wd-surface-hover/30 overflow-hidden">
        <div className="flex items-center justify-between px-2.5 py-1 border-b border-wd-border/40 text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold">
          <span>{CHANNEL_TYPE_LABEL[row.channelType]} request</span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 text-[10px] text-wd-primary hover:underline font-mono normal-case tracking-normal cursor-pointer"
          >
            <Icon icon="solar:copy-linear" width={12} />
            Copy cURL
          </button>
        </div>
        <pre className="wd-scroll-thin text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-all px-2.5 py-2 max-h-80 overflow-auto">
          {displayCurl}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared section primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

function KvList({ items }: { items: [string, ReactNode][] }) {
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
