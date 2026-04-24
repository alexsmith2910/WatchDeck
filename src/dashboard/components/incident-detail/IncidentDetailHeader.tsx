/**
 * Big severity-striped banner at the top of the incident detail page.
 *
 * Layout:
 *   - Left accent stripe coloured by severity.
 *   - Top row: back button · short incident ID + copy.
 *   - Body: severity + status + cause-kind chips, endpoint name, URL, cause
 *     detail, big live-ticking duration on the right.
 *
 * Acknowledge / Resolve / Mute / Runbook actions are intentionally absent —
 * WatchDeck's incident lifecycle is fully automatic (the check engine opens
 * and closes incidents; there are no server endpoints for manual mutation).
 */
import { memo, useEffect, useState } from "react";
import { Button, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiEndpoint, ApiIncident } from "../../types/api";
import { useFormat } from "../../hooks/useFormat";
import {
  metaFor,
  sevKey,
  fmtLiveDuration,
  fmtDuration,
  liveElapsedSec,
} from "../incidents/incidentHelpers";

interface Props {
  incident: ApiIncident;
  endpoint: ApiEndpoint | null;
  onBack: () => void;
  onViewEndpoint: () => void;
}

const SEV_HEADER_BG: Record<string, string> = {
  crit: "bg-wd-danger/[0.03] border-wd-danger/25",
  maj: "bg-wd-warning/[0.03] border-wd-warning/25",
  min: "bg-wd-primary/[0.03] border-wd-primary/20",
};
const SEV_STRIPE: Record<string, string> = {
  crit: "bg-wd-danger",
  maj: "bg-wd-warning",
  min: "bg-wd-primary",
};
const SEV_CHIP: Record<string, string> = {
  crit: "bg-wd-danger/15 text-wd-danger",
  maj: "bg-wd-warning/15 text-wd-warning",
  min: "bg-wd-primary/15 text-wd-primary",
};
const SEV_DUR: Record<string, string> = {
  crit: "text-wd-danger",
  maj: "text-wd-warning",
  min: "text-wd-primary",
};
const KIND_CHIP: Record<string, string> = {
  down: "bg-wd-danger/15 text-wd-danger",
  degraded: "bg-wd-warning/15 text-wd-warning",
  latency: "bg-wd-primary/15 text-wd-primary",
  body: "bg-[color-mix(in_srgb,#6aa6ff_18%,transparent)] text-[#6aa6ff]",
  ssl: "bg-[color-mix(in_srgb,#b19cd9_20%,transparent)] text-[#8a72c4]",
  port: "bg-wd-muted/15 text-wd-muted",
  other: "bg-wd-muted/15 text-wd-muted",
};

function IncidentDetailHeaderBase({
  incident,
  endpoint,
  onBack,
  onViewEndpoint,
}: Props) {
  const fmt = useFormat();
  const [copied, setCopied] = useState(false);
  // 1s re-render while the incident is live so the big duration counts up.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (incident.status !== "active") return;
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, [incident.status]);

  const meta = metaFor(incident.cause);
  const sk = sevKey(meta.severity);
  const isActive = incident.status === "active";
  // Use the trailing 8 chars of the ObjectId so the displayed form matches
  // what `navigator.clipboard.writeText` actually copies when the ID is
  // truncated in logs or shared inline. Breadcrumb uses the same slice.
  const shortId = `inc-${incident._id.slice(-8)}`;
  const fullId = incident._id;
  const liveSec = isActive
    ? liveElapsedSec(incident.startedAt)
    : (incident.durationSeconds ?? 0);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(fullId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const endpointKind = endpoint?.type === "port" ? "PORT" : "HTTP";
  const urlText = endpoint
    ? endpoint.type === "http"
      ? (endpoint.url ?? "")
      : `${endpoint.host ?? ""}:${endpoint.port ?? ""}`
    : "";

  return (
    <div
      className={cn(
        "relative rounded-xl border px-5 pt-3.5 pb-4 overflow-hidden",
        isActive ? SEV_HEADER_BG[sk] : "bg-wd-surface border-wd-border/60",
      )}
    >
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1",
          isActive ? SEV_STRIPE[sk] : "bg-wd-success/60",
        )}
      />

      {/* Top strip — back + id */}
      <div className="flex items-center justify-between pl-1.5 mb-2.5">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11.5px] font-mono text-wd-muted hover:bg-wd-surface-hover hover:text-foreground transition-colors cursor-pointer"
        >
          <Icon icon="solar:alt-arrow-left-linear" width={12} />
          <span>All incidents</span>
        </button>
        <div className="inline-flex items-center gap-1.5 font-mono text-[11px]">
          <span
            className={cn(
              "transition-colors",
              copied ? "text-wd-success" : "text-wd-muted/80",
            )}
          >
            {copied ? "Copied!" : shortId}
          </span>
          <button
            onClick={copyId}
            title={copied ? "Copied to clipboard" : `Copy ${fullId}`}
            className={cn(
              "inline-flex items-center justify-center w-[20px] h-[20px] rounded hover:bg-wd-surface-hover cursor-pointer transition-colors",
              copied ? "text-wd-success" : "text-wd-muted/80",
            )}
          >
            <Icon
              icon={copied ? "solar:check-read-bold" : "solar:copy-linear"}
              width={12}
            />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-start pl-1.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded text-[10.5px] font-semibold font-mono uppercase tracking-[0.08em] px-2 py-[2px]",
                SEV_CHIP[sk],
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {meta.severity}
            </span>
            {isActive ? (
              <span className="inline-flex items-center gap-1.5 rounded text-[10.5px] font-semibold font-mono uppercase tracking-[0.08em] px-2 py-[2px] bg-wd-danger/15 text-wd-danger">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wd-danger opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-wd-danger" />
                </span>
                Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded text-[10.5px] font-semibold font-mono uppercase tracking-[0.08em] px-2 py-[2px] bg-wd-success/15 text-wd-success">
                <Icon icon="solar:check-circle-bold" width={11} />
                Resolved
              </span>
            )}
            <span
              className={cn(
                "rounded text-[10.5px] font-semibold font-mono uppercase tracking-[0.08em] px-2 py-[2px]",
                KIND_CHIP[meta.kind] ?? KIND_CHIP.other,
              )}
            >
              {meta.label}
            </span>
          </div>

          <h1 className="text-[22px] font-semibold tracking-[-0.014em] leading-tight mb-1.5 truncate">
            {endpoint?.name ?? "Unknown endpoint"}
          </h1>

          <div className="inline-flex items-center gap-2 font-mono text-[12px] text-wd-muted mb-1.5 max-w-full">
            <Icon
              icon={
                endpoint?.type === "port"
                  ? "solar:plug-circle-linear"
                  : "solar:global-linear"
              }
              width={12}
            />
            <span className="truncate" title={urlText}>
              {urlText}
            </span>
            <span className="shrink-0 inline-flex items-center px-1.5 pt-[3px] pb-[2px] rounded text-[9px] leading-none font-semibold font-mono uppercase tracking-[0.08em] text-wd-muted/80 bg-wd-surface-hover/60 border border-wd-border/50">
              {endpointKind}
            </span>
          </div>

          {incident.causeDetail && (
            <div className="text-[13px] font-medium leading-snug max-w-[620px]">
              {incident.causeDetail}
            </div>
          )}
        </div>

        {/* Big duration */}
        <div className="flex flex-col items-end gap-1 text-right">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80">
            {isActive ? "Down for" : "Total duration"}
          </div>
          <div
            className={cn(
              "font-mono text-[30px] font-semibold tracking-[-0.015em] leading-none tabular-nums",
              isActive ? SEV_DUR[sk] : "text-foreground",
            )}
          >
            {isActive ? fmtLiveDuration(liveSec) : fmtDuration(liveSec)}
          </div>
          <div className="text-[11px] font-mono text-wd-muted">
            {fmt.relative(incident.startedAt)} · {fmt.tsShort(incident.startedAt)}
          </div>
          <div className="mt-1">
            <Button
              size="sm"
              variant="ghost"
              className="!rounded-md !h-7 !min-w-0 !px-2"
              onPress={onViewEndpoint}
            >
              <Icon
                icon="solar:square-arrow-right-up-linear"
                width={13}
              />
              <span className="text-[11.5px]">View endpoint</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(IncidentDetailHeaderBase);
