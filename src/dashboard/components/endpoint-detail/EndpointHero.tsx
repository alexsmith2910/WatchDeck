/**
 * Endpoint hero — status banner, name/url/metadata row, quick actions.
 *
 * The left accent bar + icon tile colour to the live status (driven by the
 * SSE-updated ApiEndpoint), so this banner doubles as the "is this thing up
 * right now?" readout at the top of the page.
 *
 * Pieces currently not wired to the database (tags, group, region) render
 * inside a small rainbow placeholder row — visible stand-ins, no overlay copy.
 */
import { memo, useState } from "react";
import { Button, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiEndpoint } from "../../types/api";
import { latencyColor, timeAgo } from "../../utils/format";

type HeroStatus = "healthy" | "degraded" | "down" | "paused";

const statusMeta: Record<
  HeroStatus,
  {
    label: string;
    sub: string;
    accent: string;
    dot: string;
    border: string;
  }
> = {
  healthy: {
    label: "Healthy",
    sub: "All assertions passing",
    accent: "text-wd-success",
    dot: "bg-wd-success",
    border: "border-l-wd-success",
  },
  degraded: {
    label: "Degraded",
    sub: "Latency above threshold or intermittent failures",
    accent: "text-wd-warning",
    dot: "bg-wd-warning",
    border: "border-l-wd-warning",
  },
  down: {
    label: "Down",
    sub: "Endpoint unreachable — consecutive failed checks",
    accent: "text-wd-danger",
    dot: "bg-wd-danger",
    border: "border-l-wd-danger",
  },
  paused: {
    label: "Paused",
    sub: "Monitoring paused — resume to restart checks",
    accent: "text-wd-paused",
    dot: "bg-wd-paused",
    border: "border-l-wd-paused",
  },
};

interface EndpointHeroProps {
  endpoint: ApiEndpoint;
  status: HeroStatus;
  currentLatencyMs?: number | null;
  onEdit?: () => void;
  onRunNow?: () => void;
  onTogglePause?: () => void;
  pausing?: boolean;
  runningNow?: boolean;
}

function EndpointHeroBase({
  endpoint,
  status,
  currentLatencyMs,
  onEdit,
  onRunNow,
  onTogglePause,
  pausing,
  runningNow,
}: EndpointHeroProps) {
  const meta = statusMeta[status];
  const [copied, setCopied] = useState(false);

  const displayTarget =
    endpoint.type === "http"
      ? `${(endpoint.method ?? "GET").toUpperCase()} ${endpoint.url ?? ""}`
      : `${endpoint.host ?? ""}:${endpoint.port ?? ""}`;

  const copyValue =
    endpoint.type === "http"
      ? (endpoint.url ?? "")
      : `${endpoint.host ?? ""}:${endpoint.port ?? ""}`;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard may be blocked in some contexts */
    }
  };

  return (
    <div
      className={cn(
        "relative flex items-center gap-4 p-4 rounded-xl bg-wd-surface border border-wd-border/50 border-l-4",
        meta.border,
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[15px] font-semibold text-foreground truncate">
            {endpoint.name}
          </div>
          <span className="shrink-0 inline-flex items-center px-1.5 pt-[3px] pb-[2px] rounded text-[9.5px] leading-none font-medium font-mono uppercase tracking-[0.08em] text-wd-muted/80 bg-wd-surface-hover/60 border border-wd-border/50">
            {endpoint.type === "http" ? "HTTP" : "TCP"}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-1 text-[12px] font-mono text-wd-muted">
          {endpoint.type === "http" && (
            <span className="inline-flex items-center px-1.5 h-[18px] rounded bg-wd-primary/10 text-wd-primary font-semibold">
              {(endpoint.method ?? "GET").toUpperCase()}
            </span>
          )}
          <span className="truncate max-w-[520px]" title={displayTarget}>
            {endpoint.type === "http"
              ? endpoint.url
              : `${endpoint.host}:${endpoint.port}`}
          </span>
          <button
            onClick={handleCopy}
            className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-wd-surface-hover transition-colors cursor-pointer"
            aria-label="Copy URL"
          >
            <Icon
              icon={copied ? "solar:check-read-linear" : "solar:copy-outline"}
              width={13}
              className="text-wd-muted"
            />
          </button>
        </div>

        <div className="flex items-center gap-4 mt-2 text-[11.5px] text-wd-muted flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0 animate-pulse",
                meta.dot,
              )}
            />
            <span>
              <b className={cn("font-semibold", meta.accent)}>{meta.label}</b>
              <span className="mx-1 text-wd-muted/60">·</span>
              <span>{meta.sub}</span>
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon icon="solar:clock-circle-outline" width={13} />
            every{" "}
            <b className="font-semibold text-foreground">
              {endpoint.checkInterval}s
            </b>
          </span>
          {currentLatencyMs != null && (
            <span className="inline-flex items-center gap-1.5">
              <Icon icon="solar:stopwatch-outline" width={13} />
              <b
                className={cn(
                  "font-semibold font-mono",
                  latencyColor(currentLatencyMs),
                )}
              >
                {currentLatencyMs}ms
              </b>
              <span>current</span>
            </span>
          )}
          {endpoint.lastCheckAt && (
            <span className="inline-flex items-center gap-1.5">
              <Icon icon="solar:history-outline" width={13} />
              last check{" "}
              <b className="font-semibold text-foreground">
                {timeAgo(endpoint.lastCheckAt)}
              </b>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={onRunNow}
          isDisabled={runningNow}
        >
          <Icon icon="solar:refresh-outline" width={16} />
          Recheck
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={onTogglePause}
          isDisabled={pausing}
        >
          <Icon
            icon={
              endpoint.status === "paused"
                ? "solar:play-circle-outline"
                : "solar:pause-circle-outline"
            }
            width={16}
          />
          {endpoint.status === "paused" ? "Resume" : "Pause"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={onEdit}
        >
          <Icon icon="solar:pen-new-square-outline" width={16} />
          Edit
        </Button>
      </div>
    </div>
  );
}

export default memo(EndpointHeroBase);
export type { HeroStatus };
