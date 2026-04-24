/**
 * Response-time chart for the incident window (±30m of context), with:
 *   - Optional reference line at the endpoint's `latencyThreshold` (off by
 *     default — a 500ms threshold against 1–3ms data blows out the y-axis)
 *   - Foreground shading for failing ranges
 *   - Vertical markers for notification_sent / escalated timeline events
 *   - Status strip under the chart with per-probe hover tooltips
 *   - Rich Recharts tooltip (time, status, code, RT)
 */
import { memo, useState } from "react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { Icon } from "@iconify/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  useXAxisScale,
  usePlotArea,
} from "recharts";
import type { IncidentRange } from "../../utils/format";
import type { IncidentTimelineEvent } from "../../types/api";
import ForegroundReferenceArea from "../ForegroundReferenceArea";
import { nearestIndexByTimestamp } from "./incidentDetailHelpers";
import { useFormat } from "../../hooks/useFormat";

export interface ChartPoint {
  label: string;
  avg: number;
  fails: number;
  degraded: number;
  status: "healthy" | "degraded" | "down";
  at: string;
  statusCode: number | null;
  errorMessage: string | null;
}

interface Props {
  chartData: ChartPoint[];
  incidentRanges: IncidentRange[];
  timeline: IncidentTimelineEvent[];
  latencyThreshold: number | null;
}

function IncidentResponseChartBase({
  chartData,
  incidentRanges,
  timeline,
  latencyThreshold,
}: Props) {
  const [showLatency, setShowLatency] = useState(false);
  if (chartData.length === 0) return null;
  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
            <Icon icon="solar:graph-linear" width={14} />
          </div>
          <div>
            <div className="text-[13px] font-semibold">
              Response time during incident
            </div>
            <div className="text-[11px] font-mono text-wd-muted">
              {chartData.length} probes · shaded region = failing window
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-wd-muted flex-wrap justify-end">
          <LegendItem swatch="bg-[var(--wd-primary)]" label="Response" />
          {latencyThreshold != null && (
            <button
              onClick={() => setShowLatency((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-1.5 py-[2px] cursor-pointer transition-colors",
                showLatency
                  ? "bg-wd-warning/10 text-wd-warning"
                  : "hover:bg-wd-surface-hover text-wd-muted",
              )}
              title={
                showLatency
                  ? "Hide latency threshold"
                  : "Show latency threshold"
              }
            >
              <span
                className="w-3.5 h-[2px] rounded-sm"
                style={{
                  backgroundImage: `linear-gradient(to right, ${showLatency ? "var(--wd-warning)" : "var(--wd-muted)"} 50%, transparent 50%)`,
                  backgroundSize: "4px 100%",
                }}
              />
              Latency threshold {latencyThreshold}ms
              <Icon
                icon={showLatency ? "solar:eye-linear" : "solar:eye-closed-linear"}
                width={11}
              />
            </button>
          )}
          <LegendItem
            swatch="bg-wd-danger/25 border border-wd-danger/40"
            label="Failing"
            height="h-2"
          />
        </div>
      </div>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient
                id="incidentChartGrad"
                x1="0"
                x2="0"
                y1="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="var(--wd-primary)"
                  stopOpacity={0.18}
                />
                <stop
                  offset="95%"
                  stopColor="var(--wd-primary)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--wd-border)"
              strokeOpacity={0.5}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--wd-muted)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--wd-muted)" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <RechartsTooltip
              content={
                <ChartTooltipContent incidentRanges={incidentRanges} />
              }
              cursor={{ stroke: "var(--wd-border)", strokeWidth: 1 }}
            />
            {latencyThreshold != null && showLatency && (
              <ReferenceLine
                y={latencyThreshold}
                stroke="var(--wd-warning)"
                strokeWidth={1.2}
                strokeDasharray="4 3"
                label={{
                  value: `Latency ${latencyThreshold}ms`,
                  position: "insideTopRight",
                  fill: "var(--wd-warning)",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                }}
                ifOverflow="extendDomain"
              />
            )}
            <Area
              dataKey="avg"
              stroke="var(--wd-primary)"
              strokeWidth={2}
              fill="url(#incidentChartGrad)"
              fillOpacity={1}
              type="monotone"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
            <ForegroundReferenceArea ranges={incidentRanges} />
            <ChartEventMarkers timeline={timeline} chartPoints={chartData} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ChartStatusStrip points={chartData} />
    </div>
  );
}

function LegendItem({
  swatch,
  label,
  dashed,
  height = "h-[2px]",
}: {
  swatch: string;
  label: string;
  dashed?: boolean;
  height?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("w-3.5 rounded-sm", swatch, height)}
        style={
          dashed
            ? {
                backgroundImage:
                  "linear-gradient(to right, var(--wd-warning) 50%, transparent 50%)",
                backgroundSize: "4px 100%",
              }
            : undefined
        }
      />
      {label}
    </span>
  );
}

function ChartTooltipContent({
  active,
  payload,
  label,
  incidentRanges,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: string;
  incidentRanges?: IncidentRange[];
}) {
  const fmt = useFormat();
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const point = entry.payload as ChartPoint | undefined;
  const matchedRange = incidentRanges?.find(
    (r) => label != null && label >= r.x1 && label <= r.x2,
  );
  const statusBg =
    point?.status === "down"
      ? "bg-wd-danger"
      : point?.status === "degraded"
        ? "bg-wd-warning"
        : "bg-wd-success";
  const code =
    point?.statusCode != null
      ? String(point.statusCode)
      : (point?.errorMessage ?? "—");
  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg max-w-[260px]">
      <div className="text-[11px] text-wd-muted mb-1 font-mono">
        {point?.at ? fmt.ts(point.at) : label}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("h-2 w-2 rounded-full shrink-0", statusBg)} />
        <span className="text-wd-muted capitalize">{point?.status ?? "—"}</span>
        <span className="font-mono text-wd-muted">·</span>
        <span className="font-mono text-foreground">{code}</span>
        <span className="font-mono text-wd-muted">·</span>
        <span className="font-semibold text-foreground">{entry.value}ms</span>
      </div>
      {point?.errorMessage && point.status !== "healthy" && (
        <div className="text-[11px] text-wd-muted/90 mt-1 line-clamp-2">
          {point.errorMessage}
        </div>
      )}
      {matchedRange && (
        <div
          className={cn(
            "flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-wd-border/50 text-[11px] font-medium",
            matchedRange.type === "down" ? "text-wd-danger" : "text-wd-warning",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              matchedRange.type === "down" ? "bg-wd-danger" : "bg-wd-warning",
            )}
          />
          {matchedRange.type === "down"
            ? "Outage detected"
            : "Degraded performance"}
        </div>
      )}
    </div>
  );
}

function ChartEventMarkers({
  timeline,
  chartPoints,
}: {
  timeline: IncidentTimelineEvent[];
  chartPoints: ChartPoint[];
}) {
  const xScale = useXAxisScale();
  const plotArea = usePlotArea();
  if (!xScale || !plotArea || chartPoints.length === 0 || timeline.length === 0)
    return null;

  const chartTs = chartPoints.map((p) => new Date(p.at).getTime());
  const markers: { label: string; event: string; at: string }[] = [];
  for (const evt of timeline) {
    if (evt.event !== "notification_sent" && evt.event !== "escalated")
      continue;
    const target = new Date(evt.at).getTime();
    const idx = nearestIndexByTimestamp(chartTs, target);
    if (idx < 0) continue;
    const atStr =
      typeof evt.at === "string" ? evt.at : new Date(evt.at).toISOString();
    markers.push({
      label: chartPoints[idx].label,
      event: evt.event,
      at: atStr,
    });
  }
  if (markers.length === 0) return null;

  const iconForEvent = (ev: string) =>
    ev === "escalated" ? "solar:double-alt-arrow-up-bold" : "solar:bell-bold";
  const colorForEvent = (ev: string) =>
    ev === "escalated" ? "var(--wd-danger)" : "var(--wd-warning)";

  return (
    <g className="chart-event-markers">
      {markers.map((m, i) => {
        const x = xScale(m.label);
        if (x == null || isNaN(x)) return null;
        const top = plotArea.y;
        const height = plotArea.height;
        const color = colorForEvent(m.event);
        return (
          <g key={`evt-${i}`}>
            <line
              x1={x}
              y1={top}
              x2={x}
              y2={top + height}
              stroke={color}
              strokeWidth={1.2}
              strokeDasharray="2 3"
              strokeOpacity={0.7}
            />
            <foreignObject x={x - 10} y={top - 3} width={20} height={20}>
              <div
                style={{
                  width: 20,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--wd-surface)",
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                }}
              >
                <Icon
                  icon={iconForEvent(m.event)}
                  width={12}
                  style={{ color }}
                />
              </div>
            </foreignObject>
          </g>
        );
      })}
    </g>
  );
}

function ChartStatusStrip({ points }: { points: ChartPoint[] }) {
  const fmt = useFormat();
  if (points.length === 0) return null;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-wd-surface-hover"
      style={{ marginLeft: 40, marginRight: 12 }}
      aria-label="Status per check"
    >
      {points.map((p, i) => (
        <Tooltip key={`strip-${i}`} delay={150} closeDelay={0}>
          <TooltipTrigger>
            <div
              className={cn(
                "h-full cursor-help",
                p.status === "down"
                  ? "bg-wd-danger"
                  : p.status === "degraded"
                    ? "bg-wd-warning"
                    : "bg-wd-success",
              )}
              style={{ flex: 1 }}
            />
          </TooltipTrigger>
          <TooltipContent className="!rounded-lg !bg-wd-surface !border !border-wd-border !px-3 !py-2 !shadow-lg">
            <div className="text-[11px] font-mono text-wd-muted mb-1">
              {fmt.ts(p.at)}
            </div>
            <div className="inline-flex items-center gap-2 text-[12px]">
              <span
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  p.status === "down"
                    ? "bg-wd-danger"
                    : p.status === "degraded"
                      ? "bg-wd-warning"
                      : "bg-wd-success",
                )}
              />
              <span className="capitalize text-wd-muted">{p.status}</span>
              <span className="font-mono text-wd-muted">·</span>
              <span className="font-mono text-foreground">
                {p.statusCode != null
                  ? p.statusCode
                  : (p.errorMessage ?? "—")}
              </span>
              <span className="font-mono text-wd-muted">·</span>
              <span className="font-semibold text-foreground">{p.avg}ms</span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export default memo(IncidentResponseChartBase);
