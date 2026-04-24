/**
 * Compact list of currently-active incidents for the Overview page.
 * Each row → the Incident detail page; the header link goes to /incidents.
 */
import { useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react";
import { Card, cn } from "@heroui/react";
import type { ApiIncident } from "../../types/api";
import {
  metaFor,
  severityOf,
  type Severity,
} from "../incidents/incidentHelpers";
import { LiveDuration } from "../incidents/LiveTime";
import { useFormat } from "../../hooks/useFormat";

interface Props {
  incidents: ApiIncident[];
  endpointName: (endpointId: string) => string;
}

const SEVERITY_TONE: Record<
  Severity,
  { row: string; chip: string; label: string }
> = {
  Critical: {
    row: "bg-wd-danger/5 border-wd-danger/25",
    chip: "bg-wd-danger/15 text-wd-danger",
    label: "P1",
  },
  Major: {
    row: "bg-wd-warning/5 border-wd-warning/22",
    chip: "bg-wd-warning/15 text-wd-warning",
    label: "P2",
  },
  Minor: {
    row: "bg-wd-surface border-wd-border/60",
    chip: "bg-wd-info/15 text-wd-info",
    label: "P3",
  },
};

export function ActiveIncidentsList({ incidents, endpointName }: Props) {
  const navigate = useNavigate();
  const fmt = useFormat();
  const active = incidents.filter((i) => i.status === "active");

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-danger/15 text-wd-danger shrink-0">
              <Icon icon="solar:danger-triangle-outline" width={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-foreground">
                Active Incidents
              </div>
              <div className="text-[11px] text-wd-muted mt-0.5">
                {active.length} open · sorted by severity
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate("/incidents")}
            className="inline-flex items-center gap-1 text-[11.5px] text-wd-muted hover:text-foreground font-medium"
          >
            View All <Icon icon="solar:alt-arrow-right-outline" width={12} />
          </button>
        </div>

        {active.length === 0 ? (
          <div className="py-6 text-center text-[12.5px] text-wd-muted border border-dashed border-wd-border/60 rounded-lg">
            No open incidents. All clear.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((i) => {
              const sev = severityOf(i);
              const tone = SEVERITY_TONE[sev];
              const cause = metaFor(i.cause).label;
              const ep = endpointName(i.endpointId);

              return (
                <button
                  key={i._id}
                  type="button"
                  onClick={() => navigate(`/incidents/${i._id}`)}
                  className={cn(
                    "grid grid-cols-[34px_1fr_auto] gap-3 items-start text-left p-3 rounded-xl border transition-colors",
                    tone.row,
                    "hover:bg-wd-surface-hover/60",
                  )}
                >
                  <div
                    className={cn(
                      "w-[34px] h-[34px] rounded-lg flex items-center justify-center text-[11px] font-bold",
                      tone.chip,
                    )}
                  >
                    {tone.label}
                  </div>
                  <div className="min-w-0 flex flex-col gap-1">
                    <div className="text-[13px] font-semibold text-foreground truncate">
                      {ep} · {cause}
                    </div>
                    {i.causeDetail && (
                      <div className="text-[12px] text-wd-muted truncate">
                        {i.causeDetail}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10.5px] text-wd-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-wd-muted/70">
                          Started
                        </span>
                        <span className="font-mono">
                          {fmt.hour(i.startedAt)}
                        </span>
                      </span>
                      {i.notificationsSent > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-[9.5px] font-semibold uppercase tracking-wider text-wd-muted/70">
                            Alerts
                          </span>
                          <span className="font-mono">
                            {i.notificationsSent}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-wd-danger/10 text-wd-danger border border-wd-danger/25">
                      <span className="w-1.5 h-1.5 rounded-full bg-wd-danger animate-pulse" />
                      Live
                    </span>
                    <span className="font-mono text-[11px] text-wd-muted tabular-nums">
                      <LiveDuration startedAt={i.startedAt} />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
