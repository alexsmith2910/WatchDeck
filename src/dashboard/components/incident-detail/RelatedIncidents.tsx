/**
 * Related Incidents — right-rail list of other incidents on the same
 * endpoint (last 30 days). Each row is a click target that navigates to
 * its own detail page.
 */
import { memo } from "react";
import { Link } from "react-router-dom";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiIncident } from "../../types/api";
import { useFormat } from "../../hooks/useFormat";
import {
  metaFor,
  sevKey,
  fmtDuration,
  liveElapsedSec,
} from "../incidents/incidentHelpers";

interface Props {
  incidents: ApiIncident[];
  /** Owning endpoint id — used to link to the filtered incidents page. */
  endpointId?: string;
}

const DOT_FOR_SEV: Record<string, string> = {
  crit: "bg-wd-danger",
  maj: "bg-wd-warning",
  min: "bg-wd-primary",
};

const RELATED_CAP = 5;

function RelatedIncidentsBase({ incidents, endpointId }: Props) {
  const visible = incidents.slice(0, RELATED_CAP);
  const hidden = Math.max(0, incidents.length - RELATED_CAP);
  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
          <Icon icon="solar:history-linear" width={14} />
        </div>
        <div>
          <div className="text-[13px] font-semibold">Related incidents</div>
          <div className="text-[11px] font-mono text-wd-muted">
            Same endpoint, last 30d
          </div>
        </div>
      </div>
      {incidents.length === 0 ? (
        <div className="text-[12px] text-wd-muted text-center py-3">
          No prior incidents
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {visible.map((r) => (
            <Row key={r.id} incident={r} />
          ))}
          {hidden > 0 && endpointId && (
            <Link
              to={`/incidents?endpointId=${endpointId}`}
              className="inline-flex items-center justify-center gap-1.5 py-1.5 mt-1 rounded-md text-[11px] font-medium text-wd-primary hover:bg-wd-primary/5 border border-dashed border-wd-border/50"
            >
              View {hidden} older incident{hidden === 1 ? "" : "s"}
              <Icon icon="solar:alt-arrow-right-linear" width={11} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ incident }: { incident: ApiIncident }) {
  const fmt = useFormat();
  const meta = metaFor(incident.cause);
  const sk = sevKey(meta.severity);
  const active = incident.status === "active";
  const durationSec =
    incident.durationSeconds ?? liveElapsedSec(incident.startedAt);

  return (
    <Link
      to={`/incidents/${incident.id}`}
      className="grid grid-cols-[10px_1fr_11px] gap-2 items-start px-2 py-2 rounded-lg hover:bg-wd-surface-hover/60 transition-colors"
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full mt-1",
          DOT_FOR_SEV[sk] ?? "bg-wd-muted",
        )}
      />
      <div className="min-w-0">
        <div className="inline-flex items-center gap-1.5 text-[11.5px]">
          <span className="font-mono text-[10.5px] text-wd-muted/80">
            inc-{incident.id.slice(-5)}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-[1px] text-[9.5px] font-semibold font-mono uppercase tracking-[0.06em]",
              active
                ? "bg-wd-danger/15 text-wd-danger"
                : "bg-wd-success/15 text-wd-success",
            )}
          >
            {active ? "Active" : "Resolved"}
          </span>
        </div>
        <div className="text-[11.5px] text-foreground mt-0.5 truncate">
          {meta.label}
          {incident.causeDetail ? ` · ${incident.causeDetail}` : ""}
        </div>
        <div className="text-[10px] font-mono text-wd-muted/80 mt-0.5">
          {fmt.tsShort(incident.startedAt)}
          {durationSec > 0 ? ` · ${fmtDuration(durationSec)}` : ""}
        </div>
      </div>
      <Icon
        icon="solar:alt-arrow-right-linear"
        width={11}
        className="text-wd-muted/70 mt-1.5"
      />
    </Link>
  );
}

export default memo(RelatedIncidentsBase);
