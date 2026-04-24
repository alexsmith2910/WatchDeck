/**
 * "Why this incident opened" card.
 *
 * Shows the rule that tripped the gate, a dot-strip visualisation of the
 * failure streak (healthy → failing → threshold-crossed), and a table of
 * evidence (first-failure time, trip-crossing time, representative probe,
 * the endpoint's current policy). The visualisation only makes sense for
 * the threshold-based causes; SSL / body cards still get the rule text.
 */
import { memo } from "react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiEndpoint, ApiIncident } from "../../types/api";
import { useFormat } from "../../hooks/useFormat";
import { metaFor, sevKey } from "../incidents/incidentHelpers";
import type { CheckPoint } from "./incidentDetailHelpers";

interface Props {
  incident: ApiIncident;
  endpoint: ApiEndpoint | null;
  /** Checks around the incident window, including some healthy pre-roll. */
  checks: CheckPoint[];
}

const SEV_TILE: Record<string, string> = {
  crit: "bg-wd-danger/15 text-wd-danger",
  maj: "bg-wd-warning/15 text-wd-warning",
  min: "bg-wd-primary/15 text-wd-primary",
};

function IncidentWhyOpenedBase({ incident, endpoint, checks }: Props) {
  const fmt = useFormat();
  const meta = metaFor(incident.cause);
  const sk = sevKey(meta.severity);
  const failureThreshold = endpoint?.failureThreshold ?? 3;
  const recoveryThreshold = endpoint?.recoveryThreshold ?? 1;
  const startedMs = new Date(incident.startedAt).getTime();

  // The viz is about showing the transition: healthy → failing (trip) →
  // failing → recovering → healthy. For active incidents we only have the
  // first two phases; for resolved ones we also include the recovery tail.
  // Long failing runs in the middle collapse into a "+N" counter.
  type DotCell =
    | { kind: "check"; check: CheckPoint; isTrip: boolean }
    | { kind: "ellipsis"; count: number };

  const { cells } = (() => {
    const sorted = [...checks].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    if (sorted.length === 0) return { cells: [] as DotCell[] };

    const firstBadIdx = sorted.findIndex((c) => c.status !== "healthy");
    // No failures yet — just tail (for the all-healthy pre-incident window).
    if (firstBadIdx < 0) {
      const tail = sorted.slice(-14);
      const cells: DotCell[] = tail.map((c) => ({
        kind: "check",
        check: c,
        isTrip: false,
      }));
      if (sorted.length > tail.length) {
        cells.unshift({
          kind: "ellipsis",
          count: sorted.length - tail.length,
        });
      }
      return { cells };
    }

    // End of the failing run — first healthy check after firstBadIdx, or
    // end of array if still failing.
    let firstRecoveryIdx = -1;
    for (let i = firstBadIdx + 1; i < sorted.length; i++) {
      if (sorted[i].status === "healthy") {
        firstRecoveryIdx = i;
        break;
      }
    }
    const failingEndEx =
      firstRecoveryIdx >= 0 ? firstRecoveryIdx : sorted.length;

    const leadIn = 3;
    const failShow = Math.max(3, failureThreshold);
    const recoveryShow = Math.max(3, recoveryThreshold);

    // Lead-in healthy dots
    const leadStart = Math.max(0, firstBadIdx - leadIn);
    const leadItems = sorted.slice(leadStart, firstBadIdx);
    // Failing region — first `failShow` of the failing run
    const failItems = sorted.slice(
      firstBadIdx,
      Math.min(failingEndEx, firstBadIdx + failShow),
    );
    const hiddenMidFailing = failingEndEx - (firstBadIdx + failItems.length);
    // Recovery tail — last `recoveryShow` healthy after failure
    const recoveryAll =
      firstRecoveryIdx >= 0 ? sorted.slice(firstRecoveryIdx) : [];
    const recoveryItems = recoveryAll.slice(0, recoveryShow);
    const hiddenAfterRecovery = recoveryAll.length - recoveryItems.length;

    // Identify the trip — nearest-by-timestamp failing check to startedAt.
    let tripKey = "";
    if (failItems.length > 0) {
      let best = failItems[0];
      let bestDelta = Math.abs(
        new Date(best.timestamp).getTime() - startedMs,
      );
      for (const c of failItems) {
        const d = Math.abs(new Date(c.timestamp).getTime() - startedMs);
        if (d < bestDelta) {
          best = c;
          bestDelta = d;
        }
      }
      tripKey = best.timestamp;
    }

    const cells: DotCell[] = [];
    if (leadStart > 0) cells.push({ kind: "ellipsis", count: leadStart });
    for (const c of leadItems) {
      cells.push({ kind: "check", check: c, isTrip: false });
    }
    for (const c of failItems) {
      cells.push({
        kind: "check",
        check: c,
        isTrip: c.timestamp === tripKey,
      });
    }
    if (hiddenMidFailing > 0) {
      cells.push({ kind: "ellipsis", count: hiddenMidFailing });
    }
    for (const c of recoveryItems) {
      cells.push({ kind: "check", check: c, isTrip: false });
    }
    if (hiddenAfterRecovery > 0) {
      cells.push({ kind: "ellipsis", count: hiddenAfterRecovery });
    }
    return { cells };
  })();

  const firstFailing = checks
    .filter((c) => c.status !== "healthy")
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )[0];
  // "Trip" check — nearest-by-timestamp failing check to startedAt.
  const tripCheck = (() => {
    const failing = checks.filter((c) => c.status !== "healthy");
    if (failing.length === 0) return undefined;
    let best = failing[0];
    let bestDelta = Math.abs(
      new Date(best.timestamp).getTime() - startedMs,
    );
    for (const c of failing) {
      const d = Math.abs(new Date(c.timestamp).getTime() - startedMs);
      if (d < bestDelta) {
        best = c;
        bestDelta = d;
      }
    }
    return best;
  })();

  const ruleText = (() => {
    switch (meta.kind) {
      case "down":
        return (
          <>
            <b>{failureThreshold}</b> consecutive failed checks returned a
            non-success status
          </>
        );
      case "degraded":
      case "latency":
        return (
          <>
            <b>{failureThreshold}</b> consecutive checks with response time
            above <b>{endpoint?.latencyThreshold ?? "—"}ms</b>
          </>
        );
      case "ssl":
        return (
          <>SSL certificate validity below the warning window</>
        );
      case "body":
        return (
          <>
            <b>{failureThreshold}</b> consecutive checks failed body
            validation
          </>
        );
      case "port":
        return (
          <>
            <b>{failureThreshold}</b> consecutive TCP connection attempts
            were refused
          </>
        );
      default:
        return (
          <>
            <b>{failureThreshold}</b> consecutive failed checks crossed the
            alert threshold
          </>
        );
    }
  })();

  const evidenceBadge = tripCheck
    ? tripCheck.statusCode != null
      ? String(tripCheck.statusCode)
      : (tripCheck.errorMessage ?? "—")
    : "—";

  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface px-4 pt-3.5 pb-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            "w-[26px] h-[26px] rounded-md inline-flex items-center justify-center",
            SEV_TILE[sk],
          )}
        >
          <Icon icon="solar:danger-triangle-bold" width={14} />
        </div>
        <div>
          <div className="text-[13px] font-semibold">
            Why this incident opened
          </div>
          <div className="text-[11px] font-mono text-wd-muted">
            Trigger rule met at {fmt.tsShort(incident.startedAt)}
          </div>
        </div>
      </div>

      {/* Rule row — muted surface, red border + red text so "RULE" stays legible */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2.5 rounded-lg bg-wd-surface-hover/30 border border-wd-danger/35">
        <span className="rounded px-2 py-[3px] text-[9.5px] font-semibold font-mono uppercase tracking-[0.1em] text-wd-danger border border-wd-danger/50 bg-wd-surface">
          Rule
        </span>
        <div className="text-[13px] leading-snug">
          {ruleText} on <b>{endpoint?.name ?? "this endpoint"}</b>
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold font-mono text-wd-success rounded px-2 py-[3px] bg-wd-success/15">
          MET
          <Icon icon="solar:check-circle-bold" width={11} />
        </span>
      </div>

      {/* Threshold viz — fixed-width, windowed, resolves included for resolved incidents */}
      {cells.length > 0 && (
        <div className="rounded-lg bg-wd-surface-hover/40 border border-wd-border/40 px-3 py-4">
          <div className="flex items-center gap-1 py-1 w-full">
            {cells.map((cell, i) =>
              cell.kind === "check" ? (
                <Tooltip
                  key={`${cell.check.timestamp}-${i}`}
                  delay={150}
                  closeDelay={0}
                >
                  <TooltipTrigger>
                    <div className="relative flex items-center justify-center flex-1 min-w-0 h-[30px] cursor-help">
                      <span
                        className={cn(
                          "rounded-full",
                          cell.isTrip
                            ? "h-[14px] w-[14px] bg-wd-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-danger)_30%,transparent),0_0_0_6px_color-mix(in_srgb,var(--wd-danger)_10%,transparent)]"
                            : cell.check.status === "healthy"
                              ? "h-[12px] w-[12px] bg-wd-success/85 shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-success)_18%,transparent)]"
                              : "h-[12px] w-[12px] bg-wd-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--wd-danger)_18%,transparent)]",
                        )}
                      />
                      {cell.isTrip && (
                        <span className="absolute -bottom-[14px] left-1/2 -translate-x-1/2 text-[8.5px] font-bold font-mono tracking-[0.08em] text-wd-danger whitespace-nowrap">
                          TRIP
                        </span>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="!rounded-lg !bg-wd-surface !border !border-wd-border !px-3 !py-2 !shadow-lg">
                    <div className="text-[11px] font-mono text-wd-muted mb-1">
                      {fmt.ts(cell.check.timestamp)}
                    </div>
                    <div className="inline-flex items-center gap-2 text-[12px]">
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full shrink-0",
                          cell.check.status === "down"
                            ? "bg-wd-danger"
                            : cell.check.status === "degraded"
                              ? "bg-wd-warning"
                              : "bg-wd-success",
                        )}
                      />
                      <span className="capitalize text-wd-muted">
                        {cell.check.status}
                      </span>
                      <span className="font-mono text-wd-muted">·</span>
                      <span className="font-mono text-foreground">
                        {cell.check.statusCode ??
                          cell.check.errorMessage ??
                          "—"}
                      </span>
                      <span className="font-mono text-wd-muted">·</span>
                      <span className="font-semibold text-foreground">
                        {cell.check.responseTime}ms
                      </span>
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span
                  key={`el-${i}`}
                  className="shrink-0 inline-flex items-center justify-center font-mono text-[10px] text-wd-muted/80 px-1.5"
                  title={`${cell.count} more check${cell.count === 1 ? "" : "s"}`}
                >
                  +{cell.count}
                </span>
              ),
            )}
          </div>
        </div>
      )}

      {/* Proof rows */}
      <div className="flex flex-col gap-1.5 pt-1.5 border-t border-dashed border-wd-border/50">
        <ProofRow label="First failure">
          {firstFailing ? (
            <span className="font-mono text-[11.5px] tabular-nums">
              {fmt.tsShort(firstFailing.timestamp)}
            </span>
          ) : (
            <span className="text-wd-muted">—</span>
          )}
        </ProofRow>
        <ProofRow label="Threshold crossed">
          <span className="font-mono text-[11.5px] tabular-nums">
            {fmt.tsShort(incident.startedAt)}
          </span>
        </ProofRow>
        {tripCheck && (
          <ProofRow label="Evidence">
            <code className="font-mono text-[11px] font-semibold px-1.5 py-[2px] rounded bg-wd-danger/10 text-wd-danger">
              {evidenceBadge}
            </code>
            <span className="font-mono text-[11.5px] tabular-nums">
              {tripCheck.responseTime}ms
            </span>
            {tripCheck.errorMessage && (
              <span className="text-wd-muted/90 text-[11.5px]">
                — {tripCheck.errorMessage}
              </span>
            )}
          </ProofRow>
        )}
        <ProofRow label="Policy">
          <span className="text-[12px]">
            Check every <b>{endpoint?.checkInterval ?? "—"}s</b> · timeout{" "}
            <b>{endpoint?.timeout ?? "—"}ms</b> · recovery needs{" "}
            <b>{recoveryThreshold}</b> healthy
            {endpoint?.alertCooldown != null && (
              <>
                {" "}· cooldown <b>{endpoint.alertCooldown}s</b>
              </>
            )}
          </span>
        </ProofRow>
      </div>
    </div>
  );
}

function ProofRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-baseline">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-wd-muted/80">
        {label}
      </span>
      <span className="inline-flex items-baseline gap-2 flex-wrap">
        {children}
      </span>
    </div>
  );
}

export default memo(IncidentWhyOpenedBase);
