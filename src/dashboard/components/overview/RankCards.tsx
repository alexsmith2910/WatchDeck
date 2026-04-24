/**
 * Three ranked lists — slowest (p95), flakiest (incident count), highest
 * error rate. Each row shows a mini sparkline of recent average response time.
 */
import { useNavigate } from "react-router-dom";
import { Card, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Sparkline } from "../health/HealthCharts";
import type { EndpointScore } from "./fleetData";

type Accent = "primary" | "warning" | "danger" | "success";

interface RankCardProps {
  title: string;
  subtitle: string;
  icon: string;
  accent: Accent;
  items: EndpointScore[];
  valueFor: (ep: EndpointScore) => string;
  valueAccent: (ep: EndpointScore) => Accent | "muted";
  sparkColor: string;
}

const accentBg: Record<Accent, string> = {
  primary: "bg-wd-primary/15 text-wd-primary",
  warning: "bg-wd-warning/15 text-wd-warning",
  danger: "bg-wd-danger/15 text-wd-danger",
  success: "bg-wd-success/15 text-wd-success",
};

const valueAccentClass: Record<Accent | "muted", string> = {
  primary: "text-wd-primary",
  warning: "text-wd-warning",
  danger: "text-wd-danger",
  success: "text-wd-success",
  muted: "text-wd-muted",
};

const statusDot: Record<EndpointScore["status"], string> = {
  healthy: "bg-wd-success",
  degraded: "bg-wd-warning",
  down: "bg-wd-danger",
  paused: "bg-wd-paused",
  nodata: "bg-wd-muted/60",
};

export function RankCard({
  title,
  subtitle,
  icon,
  accent,
  items,
  valueFor,
  valueAccent,
  sparkColor,
}: RankCardProps) {
  const navigate = useNavigate();

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      <div className="p-3.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded-lg shrink-0",
              accentBg[accent],
            )}
          >
            <Icon icon={icon} width={13} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground truncate">
              {title}
            </div>
            <div className="text-[11px] text-wd-muted mt-0.5 truncate">
              {subtitle}
            </div>
          </div>
        </div>

        <div className="flex flex-col">
          {items.length === 0 && (
            <div className="py-4 text-center text-[12px] text-wd-muted">
              Not enough data yet.
            </div>
          )}
          {items.map((ep, i) => {
            const tone = valueAccent(ep);
            return (
              <button
                key={ep.id}
                type="button"
                onClick={() => navigate(`/endpoints/${ep.id}`)}
                className="grid grid-cols-[20px_minmax(0,1fr)_56px_60px] gap-2.5 items-center text-left py-1.5 px-1 rounded-md hover:bg-wd-surface-hover transition-colors"
              >
                <span className="font-mono text-[10.5px] text-wd-muted/80 text-right">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-[12px] font-medium text-foreground flex items-center gap-1.5 truncate">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        statusDot[ep.status],
                      )}
                    />
                    <span className="truncate">{ep.name}</span>
                  </span>
                  {ep.url && (
                    <span className="font-mono text-[10px] text-wd-muted/80 truncate">
                      {ep.url}
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-end">
                  {ep.spark.length >= 2 && (
                    <Sparkline
                      data={ep.spark}
                      color={sparkColor}
                      width={56}
                      height={20}
                    />
                  )}
                </span>
                <span
                  className={cn(
                    "font-mono font-semibold text-[11.5px] tabular-nums text-right",
                    valueAccentClass[tone],
                  )}
                >
                  {valueFor(ep)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
