/**
 * Endpoint × time uptime heatmap. Each row is an endpoint, each cell is a
 * bucket shaded by uptime (green = healthy, amber/red = degraded/down). Cells
 * without data show as a muted "no data" shade so gaps are legible.
 *
 * Hover tooltips are rendered via createPortal so they escape any ancestor
 * overflow clipping — same pattern used by UptimeBar and the health charts.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Card, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { HeatmapCell, HeatmapRow } from "./fleetData";

interface Props {
  rows: HeatmapRow[];
  bucketCount: number;
  xLabels: string[];
}

function heatmapClass(v: number | null): string {
  if (v == null) return "bg-wd-surface-hover/60 border border-wd-border/30";
  if (v >= 0.995) return "bg-wd-success";
  if (v >= 0.98) return "bg-wd-success/70";
  if (v >= 0.95) return "bg-wd-success/40";
  if (v >= 0.85) return "bg-wd-warning/60";
  if (v >= 0.6) return "bg-wd-warning";
  if (v >= 0.3) return "bg-wd-danger/70";
  return "bg-wd-danger";
}

function statusDotClass(status: HeatmapRow["status"]): string {
  switch (status) {
    case "healthy":
      return "bg-wd-success";
    case "degraded":
      return "bg-wd-warning";
    case "down":
      return "bg-wd-danger";
    case "paused":
      return "bg-wd-paused";
    default:
      return "bg-wd-muted/60";
  }
}

function cellTone(v: number | null): {
  label: string;
  tint: string;
  swatch: string;
} {
  if (v == null)
    return {
      label: "No Data",
      tint: "text-wd-muted",
      swatch: "bg-wd-muted/60",
    };
  if (v >= 0.999)
    return {
      label: "Healthy",
      tint: "text-wd-success",
      swatch: "bg-wd-success",
    };
  if (v >= 0.95)
    return {
      label: "Healthy",
      tint: "text-wd-success",
      swatch: "bg-wd-success/70",
    };
  if (v >= 0.85)
    return {
      label: "Degraded",
      tint: "text-wd-warning",
      swatch: "bg-wd-warning/60",
    };
  if (v >= 0.6)
    return {
      label: "Degraded",
      tint: "text-wd-warning",
      swatch: "bg-wd-warning",
    };
  return { label: "Outage", tint: "text-wd-danger", swatch: "bg-wd-danger" };
}

interface HoverState {
  row: HeatmapRow;
  cell: HeatmapCell;
  rect: DOMRect;
}

export function EndpointHeatmap({ rows, bucketCount, xLabels }: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const tickLabels = useMemo(() => {
    if (xLabels.length === 0) return [];
    const picks = new Set<number>();
    const n = xLabels.length;
    [
      0,
      Math.floor(n / 4),
      Math.floor(n / 2),
      Math.floor((n * 3) / 4),
      n - 1,
    ].forEach((i) => picks.add(i));
    return [...picks].sort((a, b) => a - b).map((i) => xLabels[i]);
  }, [xLabels]);

  // Hide tooltip on scroll so it doesn't strand mid-air.
  useEffect(() => {
    if (!hover) return;
    const onScroll = () => setHover(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hover]);

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-warning/15 text-wd-warning shrink-0">
              <Icon icon="solar:widget-outline" width={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-foreground">
                Endpoint Uptime Heatmap
              </div>
              <div className="text-[11px] text-wd-muted mt-0.5">
                {rows.length} endpoint{rows.length === 1 ? "" : "s"} ×{" "}
                {bucketCount} buckets · darker = worse uptime
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-wd-muted shrink-0">
            <span>Down</span>
            <span className="h-2.5 w-[120px] rounded-sm bg-gradient-to-r from-wd-danger via-wd-warning to-wd-success" />
            <span>Healthy</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-wd-muted">
            No endpoints in the current scope.
          </div>
        ) : (
          <>
            <div
              className="grid grid-cols-[200px_1fr] gap-3"
              onMouseLeave={() => setHover(null)}
            >
              <div className="flex flex-col gap-[3px]">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="h-[22px] flex items-center gap-2 text-[11.5px] text-foreground min-w-0"
                  >
                    <span
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full shrink-0",
                        statusDotClass(r.status),
                      )}
                    />
                    <span className="truncate">{r.name}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-wd-muted">
                      {r.uptime30d != null ? `${r.uptime30d.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-[3px] min-w-0">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="grid gap-[2px] h-[22px]"
                    style={{
                      gridTemplateColumns: `repeat(${bucketCount}, 1fr)`,
                    }}
                  >
                    {Array.from({ length: bucketCount }).map((_, ci) => {
                      const cell =
                        ci < r.values.length ? r.values[ci] : undefined;
                      const v = cell ? cell.v : null;
                      return (
                        <div
                          key={ci}
                          className={cn(
                            "rounded-[2px] transition-[outline-color,transform] cursor-pointer",
                            "hover:outline hover:outline-2 hover:outline-wd-primary hover:outline-offset-[1px] hover:scale-y-105",
                            heatmapClass(v),
                          )}
                          onMouseEnter={(e) => {
                            if (!cell) return;
                            const rect = (
                              e.currentTarget as HTMLElement
                            ).getBoundingClientRect();
                            setHover({ row: r, cell, rect });
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-between text-[10.5px] font-mono text-wd-muted pl-[212px]">
              {tickLabels.map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {hover &&
        typeof document !== "undefined" &&
        createPortal(<HeatmapTooltip hover={hover} />, document.body)}
    </Card>
  );
}

function HeatmapTooltip({ hover }: { hover: HoverState }) {
  const { row, cell, rect } = hover;
  const tone = cellTone(cell.v);

  const HALF_WIDTH = 140;
  const MARGIN = 8;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const cellCenter = rect.left + rect.width / 2;
  const clampedLeft = Math.max(
    HALF_WIDTH + MARGIN,
    Math.min(cellCenter, viewportW - HALF_WIDTH - MARGIN),
  );
  const above = rect.top > 140;

  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{
        left: clampedLeft,
        top: above ? rect.top - 8 : rect.bottom + 8,
        transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
    >
      <div className="bg-wd-surface border border-wd-border rounded-lg shadow-lg px-3 py-2.5 text-[11px] min-w-[240px] flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-wider font-mono border-b border-wd-border/50 pb-1.5">
          <span className="text-wd-muted/80 truncate">{row.name}</span>
          <span className={tone.tint}>{tone.label}</span>
        </div>
        <TipRow
          label="Bucket"
          value={cell.label}
          swatch="bg-wd-muted/60"
          valueClass="text-foreground"
          mono
        />
        <TipRow
          label="Uptime"
          value={cell.v == null ? "—" : `${(cell.v * 100).toFixed(2)}%`}
          swatch={tone.swatch}
          valueClass={tone.tint}
          mono
        />
        {row.uptime30d != null && (
          <TipRow
            label="30d Avg"
            value={`${row.uptime30d.toFixed(2)}%`}
            swatch="bg-wd-muted/60"
            valueClass="text-wd-muted"
            mono
          />
        )}
      </div>
    </div>
  );
}

function TipRow({
  label,
  value,
  swatch,
  valueClass,
  mono,
}: {
  label: string;
  value: string;
  swatch: string;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-wd-muted min-w-0">
        <span
          aria-hidden
          className={cn("inline-block w-2 h-2 rounded-sm shrink-0", swatch)}
        />
        <span className="truncate">{label}</span>
      </span>
      <span
        className={cn(
          "text-right shrink-0 tabular-nums",
          mono && "font-mono font-medium",
          valueClass ?? "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
