/**
 * Four-cell summary strip under the header.
 *
 * Replaces the older `IncidentKpiStrip` — acknowledgement and escalation
 * levels are deliberately omitted, WatchDeck has no manual ack surface and
 * escalations are surfaced via the timeline + notifications log.
 */
import { memo } from "react";
import { cn } from "@heroui/react";
import type { ApiEndpoint, ApiIncident } from "../../types/api";
import { useFormat } from "../../hooks/useFormat";
import { fmtDuration, liveElapsedSec } from "../incidents/incidentHelpers";
import type { CheckPoint } from "./incidentDetailHelpers";

interface Props {
  incident: ApiIncident;
  endpoint: ApiEndpoint | null;
  /** Every check within the incident window — drives "failed X / N" cell. */
  incidentChecks: CheckPoint[];
  /** Notification log row count — "alerts sent" cell. */
  notificationCount: number;
  /** Count of unique channels that actually received a notification. */
  uniqueChannelCount: number;
}

type Tone = "default" | "danger" | "warning" | "success" | "ok";

interface Item {
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
}

function IncidentSummaryStripBase({
  incident,
  endpoint,
  incidentChecks,
  notificationCount,
  uniqueChannelCount,
}: Props) {
  const fmt = useFormat();
  const isActive = incident.status === "active";

  const failed = incidentChecks.filter((c) => c.status !== "healthy").length;
  const total = incidentChecks.length;
  const failureThreshold = endpoint?.failureThreshold ?? 3;

  // Last check cell — only shown while active.
  let lastCheckValue = "—";
  let lastCheckSub = "—";
  let lastCheckTone: Tone | undefined;
  if (isActive && endpoint?.lastCheckAt) {
    const code = endpoint.lastStatusCode ?? endpoint.lastErrorMessage ?? "—";
    lastCheckValue = `${code} · ${endpoint.lastResponseTime ?? 0}ms`;
    lastCheckSub = fmt.relative(endpoint.lastCheckAt);
    lastCheckTone =
      endpoint.lastStatus === "down"
        ? "danger"
        : endpoint.lastStatus === "degraded"
          ? "warning"
          : "ok";
  }

  const items: Item[] = [
    {
      label: "Started",
      value: fmt.tsShort(incident.startedAt),
      sub: fmt.relative(incident.startedAt),
    },
    isActive
      ? {
          label: "Last check",
          value: lastCheckValue,
          sub: lastCheckSub,
          tone: lastCheckTone,
        }
      : {
          label: "Resolved",
          value: incident.resolvedAt
            ? fmt.tsShort(incident.resolvedAt)
            : "—",
          sub: incident.durationSeconds != null
            ? `after ${fmtDuration(incident.durationSeconds)}`
            : `after ${fmtDuration(liveElapsedSec(incident.startedAt))}`,
          tone: "success",
        },
    {
      label: "Failed checks",
      value: `${failed} / ${total}`,
      sub: `Threshold ${failureThreshold}`,
      tone: failed > 0 ? "danger" : undefined,
    },
    {
      label: "Alerts sent",
      value: String(incident.notificationsSent ?? notificationCount),
      sub:
        uniqueChannelCount > 0
          ? `${uniqueChannelCount} ${uniqueChannelCount === 1 ? "channel" : "channels"}`
          : "no channels",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl border border-wd-border/60 bg-wd-surface overflow-hidden">
      {items.map((it, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-col gap-0.5 px-3.5 py-3 min-w-0",
            i < items.length - 1 && "md:border-r border-wd-border/40",
            i === 0 && "border-r border-wd-border/40",
            i === 2 && "md:border-r border-r border-wd-border/40",
          )}
        >
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80">
            {it.label}
          </div>
          <div
            className={cn(
              "text-[13.5px] font-semibold tabular-nums truncate",
              it.tone === "danger" && "text-wd-danger",
              it.tone === "warning" && "text-wd-warning",
              it.tone === "success" && "text-wd-success",
              it.tone === "ok" && "text-wd-success",
            )}
            title={it.value}
          >
            {it.value}
          </div>
          <div className="text-[10.5px] font-mono text-wd-muted truncate">
            {it.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(IncidentSummaryStripBase);
