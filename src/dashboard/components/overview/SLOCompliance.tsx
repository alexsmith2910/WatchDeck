/**
 * Per-endpoint SLO compliance list — scaled against the globally configured
 * SLO target (from `/slo`). The bar visualises where each endpoint sits on a
 * narrow 98–100% scale so small deviations still read clearly.
 */
import { useMemo } from "react";
import { Card, cn } from "@heroui/react";
import { Icon } from "@iconify/react";

export interface SLOItem {
  id: string;
  name: string;
  /** Current uptime % for the window */
  current: number | null;
  /** Number of checks the reading is based on; used to de-emphasise thin data */
  sampleSize: number;
}

interface Props {
  items: SLOItem[];
  target: number;
  windowLabel: string;
}

export function SLOCompliance({ items, target, windowLabel }: Props) {
  // Fixed 75–100% scale — bars read as "mostly full" for healthy endpoints,
  // with clear differentiation between 75%, 90%, 99%, etc.
  const scaleMin = 75;
  const scaleMax = 100.05;

  const withTone = useMemo(() => {
    return items.map((s) => {
      if (s.current == null) {
        return { ...s, tone: "muted" as const, burn: 0, pctFill: 0 };
      }
      const burn = target - s.current;
      const tone: "success" | "warning" | "danger" =
        s.current >= target
          ? "success"
          : s.current >= target - 0.2
            ? "warning"
            : "danger";
      // Floor at 3% so the tint stays legible for readings right at the
      // scale minimum, and cap at 100 so a 100% reading doesn't overshoot.
      const raw = ((s.current - scaleMin) / (scaleMax - scaleMin)) * 100;
      const pctFill = Math.max(3, Math.min(100, raw));
      return { ...s, tone, burn, pctFill };
    });
  }, [items, target, scaleMin, scaleMax]);

  const budgetBurn = useMemo(() => {
    // Simple fleet-wide burn indicator: % of endpoints below target.
    const sized = items.filter((s) => s.current != null);
    if (sized.length === 0) return null;
    const below = sized.filter((s) => (s.current ?? 0) < target).length;
    return Math.round((1 - below / sized.length) * 1000) / 10;
  }, [items, target]);

  const pctTarget = Math.max(
    0,
    Math.min(100, ((target - scaleMin) / (scaleMax - scaleMin)) * 100),
  );

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-success/15 text-wd-success shrink-0">
              <Icon icon="solar:target-outline" width={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-foreground">
                SLO Compliance
              </div>
              <div className="text-[11px] text-wd-muted mt-0.5 truncate">
                Rolling {windowLabel} · target {target}% · fleet-wide
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {withTone.length === 0 && (
            <div className="py-4 text-center text-[12px] text-wd-muted">
              No endpoints in the current scope.
            </div>
          )}
          {withTone.map((s) => (
            <div
              key={s.id}
              className="grid grid-cols-[140px_1fr_90px] gap-2.5 items-center text-[12px]"
            >
              <div className="text-foreground font-medium truncate">
                {s.name}
              </div>
              <div className="relative h-2.5 rounded-full border border-wd-border/50 bg-wd-surface-hover overflow-hidden">
                {s.current != null && (
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width]",
                      s.tone === "success" && "bg-wd-success",
                      s.tone === "warning" && "bg-wd-warning",
                      s.tone === "danger" && "bg-wd-danger",
                    )}
                    style={{ width: `${s.pctFill}%` }}
                  />
                )}
                <div
                  className="absolute top-[-2px] bottom-[-2px] w-[1.5px] bg-wd-muted opacity-80"
                  style={{ left: `${pctTarget}%` }}
                />
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    "font-mono font-semibold text-[11.5px] tabular-nums",
                    s.tone === "success" && "text-wd-success",
                    s.tone === "warning" && "text-wd-warning",
                    s.tone === "danger" && "text-wd-danger",
                    s.tone === "muted" && "text-wd-muted",
                  )}
                >
                  {s.current != null ? `${s.current.toFixed(2)}%` : "—"}
                </div>
                <div className="text-[9.5px] text-wd-muted mt-0.5">
                  {s.current == null
                    ? "No Data"
                    : s.burn <= 0
                      ? "Over SLO"
                      : `−${s.burn.toFixed(2)}%`}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-dashed border-wd-border/60 text-[11px] text-wd-muted">
          <span>
            <span className="text-[9.5px] font-semibold uppercase tracking-wider text-wd-muted/70 mr-1.5">
              Meeting SLO
            </span>
            <span className="font-mono text-foreground">
              {budgetBurn != null ? `${budgetBurn}%` : "—"}
            </span>
          </span>
          <span>
            <span className="text-[9.5px] font-semibold uppercase tracking-wider text-wd-muted/70 mr-1.5">
              Target
            </span>
            <span className="font-mono text-foreground">{target}%</span>
          </span>
          <span>
            <span className="text-[9.5px] font-semibold uppercase tracking-wider text-wd-muted/70 mr-1.5">
              Scope
            </span>
            <span className="font-mono text-foreground">Fleet-wide</span>
          </span>
        </div>
      </div>
    </Card>
  );
}
