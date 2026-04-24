/**
 * Fleet status distribution over time — stacked bar chart of
 * healthy / degraded / down check counts per bucket.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@heroui/react";
import { Icon } from "@iconify/react";

interface Bucket {
  label: string;
  healthy: number;
  degraded: number;
  down: number;
}

interface Props {
  data: Bucket[];
  height?: number;
}

const LABELS: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
};

// Use literal CSS var tokens so the tooltip dot renders reliably. Recharts
// reports `entry.color` as the Bar's `fill`, which for us is a gradient URL
// (`url(#statusHealthy)`); feeding that to `background:` produces an empty dot.
const DOT_COLORS: Record<string, string> = {
  healthy: "var(--wd-success)",
  degraded: "var(--wd-warning)",
  down: "var(--wd-danger)",
};

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg">
      <div className="text-[11px] font-mono text-wd-muted mb-1.5">{label}</div>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{
                background: DOT_COLORS[entry.dataKey] ?? "var(--wd-muted)",
              }}
            />
            <span className="text-wd-muted">
              {LABELS[entry.dataKey] ?? entry.dataKey}
            </span>
            <span className="font-mono font-semibold text-foreground ml-auto">
              {entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusBarChart({ data, height = 240 }: Props) {
  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible !h-full">
      <div className="p-4 pb-2 flex flex-col gap-3 h-full">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-info/15 text-wd-info shrink-0">
              <Icon icon="solar:layers-minimalistic-outline" width={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-foreground">
                Check Outcomes Over Time
              </div>
              <div className="text-[11px] text-wd-muted mt-0.5">
                Healthy / degraded / failed per bucket
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-wd-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-wd-success" /> Healthy
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-wd-warning" /> Degraded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-wd-danger" /> Down
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0" style={{ minHeight: height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 4, right: 12, bottom: 0, left: -12 }}
            >
              <defs>
                <linearGradient id="statusHealthy" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--wd-success)"
                    stopOpacity={0.9}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--wd-success)"
                    stopOpacity={0.6}
                  />
                </linearGradient>
                <linearGradient id="statusDegraded" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--wd-warning)"
                    stopOpacity={0.9}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--wd-warning)"
                    stopOpacity={0.6}
                  />
                </linearGradient>
                <linearGradient id="statusDown" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--wd-danger)"
                    stopOpacity={0.9}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--wd-danger)"
                    stopOpacity={0.6}
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
              />
              <RechartsTooltip
                content={<TooltipContent />}
                cursor={{ fill: "var(--wd-surface-hover)", fillOpacity: 0.3 }}
              />
              <Bar dataKey="healthy" stackId="s" fill="url(#statusHealthy)" />
              <Bar dataKey="degraded" stackId="s" fill="url(#statusDegraded)" />
              <Bar dataKey="down" stackId="s" fill="url(#statusDown)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
