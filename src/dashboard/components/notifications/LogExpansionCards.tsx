/**
 * Shared expansion cards for a notification-log row — the four panels the
 * endpoint-detail accordion and the global delivery drawer both render:
 *
 *   1. Payload         — rendered message the provider was asked to format.
 *   2. Response        — provider HTTP status, body excerpt, provider id.
 *   3. Retries         — attempt chain discovered via `?retryOf={id}`.
 *   4. Reproduce cURL  — copy-pasteable request for webhook-style channels.
 *
 * Each card falls back to a `RainbowPlaceholder` when its source field is
 * missing, so rows written before this schema lands still render without
 * error. The four cards render side-by-side inside a common container.
 */

import { useEffect, useState } from "react";
import { cn, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../../hooks/useApi";
import { toast } from "../../ui/toast";
import type { ApiPagination } from "../../types/api";
import type {
  ApiChannel,
  ApiNotificationLogRequest,
  ApiNotificationLogRow,
} from "../../types/notifications";
import { STATUS_STYLE } from "../../types/notifications";
import { RainbowPlaceholder } from "../endpoint-detail/primitives";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function LogExpansionCards({
  row,
  channel,
}: {
  row: ApiNotificationLogRow;
  channel: ApiChannel | null;
}) {
  const isCoalescedSummary = (row.coalescedCount ?? 0) > 1;
  const isEmailChannel = row.channelType === "email";
  const showReproduce = !isCoalescedSummary && !isEmailChannel;

  return (
    <div className="flex flex-col gap-3">
      <PayloadCard payload={row.payload ?? null} />
      <ResponseCard response={row.response ?? null} />
      <RetriesCard row={row} />
      {showReproduce && (
        <ReproduceCard
          request={row.request ?? null}
          channel={channel}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

function PayloadCard({
  payload,
}: {
  payload: ApiNotificationLogRow["payload"] | null;
}) {
  if (!payload) {
    return (
      <CardPlaceholder
        title="Payload"
        body="— payload not yet captured —"
      />
    );
  }
  return (
    <Card title="Payload">
      <div className="flex flex-col gap-2">
        <KvRow label="Title" value={payload.title} />
        <KvRow label="Summary" value={payload.summary} />
        {payload.markdown && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold mb-1">
              Markdown
            </div>
            <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words bg-wd-surface-hover/30 rounded px-2 py-1.5 max-h-48 overflow-auto">
              {payload.markdown}
            </pre>
          </div>
        )}
        {payload.fields && payload.fields.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold mb-1">
              Fields
            </div>
            <dl className="flex flex-col gap-1 font-mono text-[11.5px]">
              {payload.fields.map((f, i) => (
                <div key={`${f.label}-${i}`} className="flex gap-2">
                  <dt className="text-wd-muted min-w-[90px] shrink-0">
                    {f.label}
                  </dt>
                  <dd className="text-foreground break-all">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function ResponseCard({
  response,
}: {
  response: ApiNotificationLogRow["response"] | null;
}) {
  if (!response) {
    return (
      <CardPlaceholder
        title="Response"
        body="— response not yet captured —"
      />
    );
  }
  return (
    <Card title="Response">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {typeof response.statusCode === "number" ? (
            <StatusCodeBadge code={response.statusCode} />
          ) : (
            <span className="text-[11px] text-wd-muted font-mono">
              (no status)
            </span>
          )}
          {response.providerId && (
            <span
              className="text-[11px] font-mono text-wd-muted truncate"
              title={response.providerId}
            >
              id: {response.providerId}
            </span>
          )}
        </div>
        {response.url && (
          <KvRow label="URL" value={response.url} mono />
        )}
        {response.bodyExcerpt && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-wd-muted-soft font-semibold mb-1">
              Body
            </div>
            <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-words bg-wd-surface-hover/30 rounded px-2 py-1.5 max-h-48 overflow-auto">
              {response.bodyExcerpt}
            </pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function StatusCodeBadge({ code }: { code: number }) {
  const tone =
    code >= 200 && code < 300
      ? "bg-wd-success/15 text-wd-success"
      : code >= 300 && code < 400
        ? "bg-wd-primary/15 text-wd-primary"
        : code >= 400
          ? "bg-wd-danger/15 text-wd-danger"
          : "bg-wd-muted/20 text-wd-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-2 rounded text-[11px] font-mono font-semibold",
        tone,
      )}
    >
      HTTP {code}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Retries — fetched on mount using retryOf filter
// ---------------------------------------------------------------------------

function RetriesCard({ row }: { row: ApiNotificationLogRow }) {
  return (
    <Card title="Retries">
      <RetriesBody row={row} />
    </Card>
  );
}

/**
 * The retries list without any wrapping frame/title. Fetches the attempt
 * chain (root row + every row whose `retryOf` points at the root) and
 * renders it oldest-first. Exported so the endpoint-detail accordion can
 * embed it under its own Section header.
 */
export function RetriesBody({ row }: { row: ApiNotificationLogRow }) {
  const { request } = useApi();
  const rootId = row.retryOf ?? row._id;
  const [attempts, setAttempts] = useState<ApiNotificationLogRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("retryOf", rootId);
    params.set("limit", "20");
    request<{ data: ApiNotificationLogRow[]; pagination: ApiPagination }>(
      `/notifications/log?${params.toString()}`,
    )
      .then((res) => {
        if (cancelled) return;
        const children = res?.data?.data ?? [];
        request<{ data: ApiNotificationLogRow }>(
          `/notifications/log/${rootId}`,
        )
          .then((rootRes) => {
            if (cancelled) return;
            const root = rootRes?.data?.data ?? null;
            const merged: ApiNotificationLogRow[] = [];
            if (root) merged.push(root);
            for (const r of [...children].reverse()) merged.push(r);
            setAttempts(merged);
          })
          .catch(() => {
            if (!cancelled) setAttempts(children);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      })
      .catch(() => {
        if (cancelled) return;
        setAttempts([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, rootId]);

  if (loading) {
    return (
      <div className="flex justify-center py-3">
        <Spinner size="sm" />
      </div>
    );
  }
  if (attempts.length === 0) {
    return (
      <div className="text-[12px] text-wd-muted">No attempts recorded.</div>
    );
  }
  if (attempts.length === 1) {
    return (
      <div className="text-[12px] text-wd-muted">
        Single attempt — no retries.
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-1.5">
      {attempts.map((a, i) => {
        const style = STATUS_STYLE[a.deliveryStatus];
        const isCurrent = a._id === row._id;
        return (
          <li
            key={a._id}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 border",
              isCurrent
                ? "bg-wd-primary/5 border-wd-primary/30"
                : "bg-wd-surface-hover/40 border-wd-border/40",
            )}
          >
            <span className="text-[10px] font-mono text-wd-muted w-6 shrink-0">
              #{i + 1}
            </span>
            <span
              className={cn(
                "inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                style.className,
              )}
            >
              {style.label}
            </span>
            <span className="text-[11px] text-foreground flex-1 truncate">
              {a.failureReason ?? a.messageSummary}
            </span>
            <span className="text-[11px] text-wd-muted font-mono tabular-nums">
              {typeof a.latencyMs === "number" ? `${a.latencyMs}ms` : "—"}
            </span>
            <span className="text-[11px] text-wd-muted font-mono">
              {new Date(a.sentAt).toLocaleTimeString()}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Reproduce cURL
// ---------------------------------------------------------------------------

function ReproduceCard({
  request,
  channel,
}: {
  request: ApiNotificationLogRequest | null;
  channel: ApiChannel | null;
}) {
  if (!request) {
    return (
      <CardPlaceholder
        title="Reproduce request"
        body="— request not yet captured —"
        trailing={
          <span className="inline-flex items-center gap-1 text-[10.5px] text-wd-muted-soft font-mono">
            <Icon icon="solar:copy-outline" width={11} />
            Copy cURL
          </span>
        }
      />
    );
  }
  // Reconstruct the real URL from the live channel doc at copy time —
  // storage stays redacted, so the clipboard value matches what the
  // provider actually sent. If the channel has been deleted we fall back
  // to the redacted version.
  const displayCurl = buildCurl(request);
  const copy = () => {
    const liveUrl = resolveLiveUrl(channel) ?? request.url;
    const liveRequest: ApiNotificationLogRequest = { ...request, url: liveUrl };
    const payload = buildCurl(liveRequest);
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
    <Card
      title="Reproduce request"
      trailing={
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] text-wd-primary hover:underline font-mono"
        >
          <Icon icon="solar:copy-linear" width={13} />
          Copy cURL
        </button>
      }
    >
      <pre className="text-[11.5px] font-mono text-foreground whitespace-pre-wrap break-all bg-wd-surface-hover/30 rounded px-2 py-1.5 max-h-48 overflow-auto">
        {displayCurl}
      </pre>
    </Card>
  );
}

export function buildCurl(req: ApiNotificationLogRequest): string {
  const parts: string[] = [`curl -X ${shellEscape(req.method)}`];
  parts.push(`  ${shellEscape(req.url)}`);
  for (const [name, value] of Object.entries(req.headers)) {
    parts.push(`  -H ${shellEscape(`${name}: ${value}`)}`);
  }
  if (req.body) {
    parts.push(`  -d ${shellEscape(req.body)}`);
  }
  return parts.join(" \\\n");
}

function shellEscape(s: string): string {
  // Single-quote for POSIX shells; escape embedded single quotes by closing,
  // inserting a literal quote, and re-opening.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function resolveLiveUrl(channel: ApiChannel | null): string | null {
  if (!channel) return null;
  switch (channel.type) {
    case "discord":
      return channel.discordWebhookUrl ?? null;
    case "slack":
      return channel.slackWebhookUrl ?? null;
    case "webhook":
      return channel.webhookUrl ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared card shells
// ---------------------------------------------------------------------------

function Card({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-wd-surface/90 border border-wd-border/50 p-3 text-[12px]">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
          {title}
        </div>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function CardPlaceholder({
  title,
  body,
  trailing,
}: {
  title: string;
  body: string;
  trailing?: React.ReactNode;
}) {
  return (
    <RainbowPlaceholder rounded="rounded-lg" animated={false}>
      <Card title={title} trailing={trailing}>
        <div className="font-mono text-wd-muted">{body}</div>
      </Card>
    </RainbowPlaceholder>
  );
}

function KvRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="text-wd-muted min-w-[90px] shrink-0 font-mono">
        {label}
      </span>
      <span
        className={cn(
          "text-foreground break-all",
          mono && "font-mono text-[11.5px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}
