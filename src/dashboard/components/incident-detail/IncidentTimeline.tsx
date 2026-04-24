/**
 * Compact rail-style incident timeline — a single dot per event on a
 * vertical rail, chronological. Driven from a pre-compressed row list built
 * in the orchestrator (see `buildCompressedTimeline`). Long runs of
 * identical check events render as a single "N failing checks" summary so
 * the user isn't scrolling through 200 identical rows — the check log at
 * the bottom of the page still holds every probe.
 */
import { memo } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useFormat } from "../../hooks/useFormat";
import type { TimelineDisplayRow } from "./incidentDetailHelpers";

interface Props {
  rows: TimelineDisplayRow[];
}

interface KindMeta {
  icon: string;
  dotClass: string;
  title: string;
}

const KIND_META: Record<string, KindMeta> = {
  opened: {
    icon: "solar:danger-triangle-bold",
    dotClass: "bg-wd-surface text-wd-danger border-wd-danger",
    title: "Incident opened",
  },
  notification_sent: {
    icon: "solar:bell-bing-bold",
    dotClass: "bg-wd-surface text-wd-primary border-wd-primary/70",
    title: "Notifications fired",
  },
  escalated: {
    icon: "solar:double-alt-arrow-up-bold",
    dotClass: "bg-wd-surface text-wd-warning border-wd-warning",
    title: "Escalated",
  },
  check: {
    icon: "solar:pulse-bold",
    dotClass: "bg-wd-surface text-wd-muted border-wd-border/70",
    title: "Health check",
  },
  resolved: {
    icon: "solar:check-circle-bold",
    dotClass: "bg-wd-surface text-wd-success border-wd-success",
    title: "Incident resolved",
  },
};

function metaFor(event: string): KindMeta {
  return (
    KIND_META[event] ?? {
      icon: "solar:info-circle-linear",
      dotClass: "bg-wd-surface text-wd-muted border-wd-border/70",
      title: event.replace(/_/g, " "),
    }
  );
}

function IncidentTimelineBase({ rows }: Props) {
  const fmt = useFormat();
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4">
        <Head />
        <div className="text-[11.5px] text-wd-muted text-center py-6">
          No timeline events yet.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <Head />
      <div className="flex flex-col">
        {rows.map((row, i) => {
          const isLast = i === rows.length - 1;
          if (row.event === "collapsed_checks") {
            return <CollapsedRow key={row.key} row={row} isLast={isLast} />;
          }
          const meta = metaFor(row.event);
          return (
            <div
              key={row.key}
              className="grid grid-cols-[32px_1fr] gap-3"
            >
              <div className="relative flex flex-col items-center">
                <div
                  className={cn(
                    "w-[30px] h-[30px] rounded-full border-[1.5px] inline-flex items-center justify-center z-10",
                    meta.dotClass,
                  )}
                >
                  <Icon icon={meta.icon} width={16} />
                </div>
                {!isLast && (
                  <div className="flex-1 w-[2px] bg-wd-border/50 mt-0.5 min-h-[18px]" />
                )}
              </div>
              <div className="min-w-0 pb-3 pt-1">
                <div className="flex items-baseline justify-between gap-2.5">
                  <span className="text-[12.5px] font-semibold leading-tight">
                    {meta.title}
                  </span>
                  <span className="text-[11px] font-mono text-wd-muted/80 shrink-0">
                    {fmt.time(row.at)}
                  </span>
                </div>
                {row.detail && (
                  <div className="text-[11.5px] text-wd-muted leading-snug mt-0.5 break-words">
                    {row.detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CollapsedRow({
  row,
  isLast,
}: {
  row: TimelineDisplayRow;
  isLast: boolean;
}) {
  const fmt = useFormat();
  const status = row.collapsedStatus ?? "down";
  const count = row.collapsedCount ?? 0;
  const statusColor =
    status === "healthy"
      ? "text-wd-success"
      : status === "degraded"
        ? "text-wd-warning"
        : "text-wd-danger";
  const dotBg =
    status === "healthy"
      ? "bg-wd-success"
      : status === "degraded"
        ? "bg-wd-warning"
        : "bg-wd-danger";
  const span = (() => {
    if (!row.spanFrom || !row.spanTo) return null;
    const ms =
      new Date(row.spanTo).getTime() - new Date(row.spanFrom).getTime();
    const sec = Math.max(1, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  })();
  return (
    <div className="grid grid-cols-[32px_1fr] gap-3">
      <div className="relative flex flex-col items-center">
        <div className="w-[30px] h-[30px] rounded-full border-dashed border-[1.5px] border-wd-border/60 bg-wd-surface-hover/30 inline-flex items-center justify-center z-10">
          <span className={cn("h-2.5 w-2.5 rounded-full", dotBg)} />
        </div>
        {!isLast && (
          <div className="flex-1 w-[2px] bg-wd-border/50 mt-0.5 min-h-[14px]" />
        )}
      </div>
      <div className="min-w-0 pb-3 pt-1">
        <div className="flex items-baseline justify-between gap-2.5">
          <span
            className={cn(
              "text-[12.5px] font-semibold leading-tight capitalize",
              statusColor,
            )}
          >
            {count} {status} check{count === 1 ? "" : "s"}
          </span>
          <span className="text-[11px] font-mono text-wd-muted/80 shrink-0">
            {row.spanFrom && fmt.time(row.spanFrom)}
            {row.spanTo && row.spanTo !== row.spanFrom && (
              <> → {fmt.time(row.spanTo)}</>
            )}
          </span>
        </div>
        <div className="text-[11px] text-wd-muted/80 leading-snug mt-0.5">
          Sustained {status} state{span ? ` over ${span}` : ""}
          <span className="text-wd-muted/60"> · see check log below for each probe</span>
        </div>
      </div>
    </div>
  );
}

function Head() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
        <Icon icon="solar:clock-circle-linear" width={14} />
      </div>
      <div>
        <div className="text-[13px] font-semibold">Timeline</div>
        <div className="text-[11px] font-mono text-wd-muted">
          Chronological incident events
        </div>
      </div>
    </div>
  );
}

export default memo(IncidentTimelineBase);
