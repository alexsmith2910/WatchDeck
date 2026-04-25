/**
 * Per-check log — one row per probe that ran inside the incident window,
 * plus a handful of pre-incident rows for context. First 10 rows shown by
 * default with a "show all N" toggle.
 */
import { memo, useState } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useFormat } from "../../hooks/useFormat";
import type { CheckPoint } from "./incidentDetailHelpers";

interface Props {
  /** Every probe within the incident window, oldest → newest. */
  checks: CheckPoint[];
  /** Timestamp of the check that tripped the failure threshold — the row
   *  at or nearest to this time gets the red THRESHOLD flag. */
  tripTimestamp?: string;
}

function IncidentChecksLogBase({ checks, tripTimestamp }: Props) {
  const fmt = useFormat();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? checks : checks.slice(0, 10);
  const failing = checks.filter((c) => c.status !== "healthy").length;
  const healthy = checks.length - failing;

  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
            <Icon icon="solar:list-check-linear" width={14} />
          </div>
          <div>
            <div className="text-[13px] font-semibold">Check log</div>
            <div className="text-[11px] font-mono text-wd-muted">
              {failing} failing · {healthy} healthy
            </div>
          </div>
        </div>
        {checks.length > 10 && (
          <button
            onClick={() => setShowAll((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-wd-primary hover:underline cursor-pointer"
          >
            {showAll ? "Show first 10" : `Show all ${checks.length}`}
            <Icon
              icon={
                showAll
                  ? "solar:alt-arrow-up-linear"
                  : "solar:alt-arrow-down-linear"
              }
              width={11}
            />
          </button>
        )}
      </div>

      <div className="flex flex-col">
        <div className="grid grid-cols-[36px_86px_96px_56px_70px_1fr] gap-2.5 px-1.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80 border-b border-wd-border/40">
          <span>#</span>
          <span>Time</span>
          <span>Status</span>
          <span>Code</span>
          <span>RT</span>
          <span>Detail</span>
        </div>
        {visible.map((c, i) => {
          const idx = i + 1;
          const isFail = c.status !== "healthy";
          const isTrip =
            tripTimestamp != null && c.timestamp === tripTimestamp;
          const statusColor =
            c.status === "down"
              ? "text-wd-danger"
              : c.status === "degraded"
                ? "text-wd-warning"
                : "text-wd-success";
          const dotBg =
            c.status === "down"
              ? "bg-wd-danger"
              : c.status === "degraded"
                ? "bg-wd-warning"
                : "bg-wd-success";
          return (
            <div
              key={c.id ?? c.timestamp}
              className={cn(
                "relative grid grid-cols-[36px_86px_96px_56px_70px_1fr] gap-2.5 items-center px-1.5 py-2 text-[12px] border-b border-wd-border/25 last:border-b-0",
                isFail && !isTrip && "bg-wd-danger/[0.04]",
                isTrip && "bg-wd-danger/[0.08]",
              )}
            >
              {isTrip && (
                <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-wd-danger" />
              )}
              <span className="text-center text-[10.5px] font-mono text-wd-muted/80">
                {idx}
              </span>
              <span className="font-mono tabular-nums">
                {fmt.time(c.timestamp)}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-[11px] font-medium capitalize",
                  statusColor,
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", dotBg)} />
                {c.status}
              </span>
              <span className="font-mono tabular-nums text-[11.5px] font-medium">
                {c.statusCode ?? "—"}
              </span>
              <span
                className={cn(
                  "font-mono tabular-nums text-[11.5px]",
                  c.responseTime > 1000 && isFail
                    ? "text-wd-danger font-semibold"
                    : undefined,
                )}
              >
                {c.responseTime}ms
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-wd-muted min-w-0 overflow-hidden truncate">
                {isTrip && (
                  <span className="shrink-0 px-1.5 py-[2px] rounded text-[8.5px] font-bold font-mono tracking-[0.1em] bg-wd-danger text-white">
                    THRESHOLD
                  </span>
                )}
                <span className="truncate">
                  {c.errorMessage ??
                    (isFail
                      ? `RT ${c.responseTime}ms${c.statusCode ? ` · HTTP ${c.statusCode}` : ""}`
                      : "OK")}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(IncidentChecksLogBase);
