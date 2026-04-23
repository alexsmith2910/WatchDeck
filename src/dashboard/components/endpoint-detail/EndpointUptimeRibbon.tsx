/**
 * Uptime ribbon card — title shows "Uptime · {pct}%" coloured by SLO threshold,
 * body uses the existing UptimeBar component so the look matches EndpointsPage
 * and OverviewPage.
 *
 * Window pills (30/60/90) auto-select based on endpoint age: start at 30d,
 * bump to 60d once the endpoint has at least 60 days of data, to 90d after
 * 90 days. The user can still override with the pill group on the right.
 */
import { memo, useMemo } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import UptimeBar, { buildHistory } from "../UptimeBar";
import type { DailySummary } from "../../types/api";
import { uptimeColor } from "../../utils/format";
import { useFormat } from "../../hooks/useFormat";
import { Segmented } from "./primitives";

type Window = 30 | 60 | 90;

interface Props {
  dailies: DailySummary[];
  loading: boolean;
  endpointCreatedAt: string;
  window: Window;
  setWindow: (w: Window) => void;
  latencyThreshold?: number | null;
}

function autoWindowFromAge(createdAt: string): Window {
  const ageDays = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / 86400_000,
  );
  if (ageDays >= 90) return 90;
  if (ageDays >= 60) return 60;
  return 30;
}

function avgUptime(dailies: DailySummary[]): number | null {
  if (dailies.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const d of dailies) {
    sum += d.uptimePercent * d.totalChecks;
    count += d.totalChecks;
  }
  return count > 0 ? sum / count : null;
}

function EndpointUptimeRibbonBase({
  dailies,
  loading,
  window,
  setWindow,
  latencyThreshold,
}: Props) {
  const fmt = useFormat();
  const history = useMemo(
    () => buildHistory(dailies, window),
    [dailies, window],
  );
  const pct = useMemo(
    () => avgUptime(dailies.slice(-window)),
    [dailies, window],
  );
  const pctLabel = pct == null ? "—" : `${pct.toFixed(pct < 100 ? 2 : 1)}%`;
  const pctColor = pct == null ? "text-wd-muted" : uptimeColor(pct);

  const worst = useMemo(() => {
    return history
      .filter(
        (b) =>
          b.status !== "nodata" &&
          b.status !== "paused" &&
          b.uptimePercent != null,
      )
      .reduce<
        (typeof history)[number] | null
      >((a, b) => (a == null || (b.uptimePercent ?? 100) < (a.uptimePercent ?? 100) ? b : a), null);
  }, [history]);

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4">
      <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-primary/10 text-wd-primary shrink-0">
            <Icon icon="solar:calendar-minimalistic-linear" width={14} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground truncate">
              Uptime ·{" "}
              <span className={cn("font-mono font-semibold", pctColor)}>
                {pctLabel}
              </span>
            </div>
            <div className="text-[11px] text-wd-muted mt-0.5 truncate">
              {worst ? (
                <>
                  Worst day:{" "}
                  <b className="font-mono text-foreground">
                    {fmt.dateShort(worst.date)}
                  </b>{" "}
                  at {worst.uptimePercent?.toFixed(2)}%
                </>
              ) : (
                <>last {window} days</>
              )}
            </div>
          </div>
        </div>
        <Segmented<"30" | "60" | "90">
          options={[
            { key: "30", label: "30d" },
            { key: "60", label: "60d" },
            { key: "90", label: "90d" },
          ]}
          value={String(window) as "30" | "60" | "90"}
          onChange={(k) => setWindow(Number(k) as Window)}
          ariaLabel="Uptime window"
        />
      </div>

      <UptimeBar
        history={history}
        loading={loading}
        latencyThreshold={latencyThreshold ?? null}
      />

      <div className="flex items-center justify-between mt-2 text-[10.5px] font-mono text-wd-muted/70">
        <span>{window} days ago</span>
        <span>{Math.round(window / 2)} days</span>
        <span>today</span>
      </div>

      <div className="flex items-center gap-4 mt-3 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-wd-muted">
          <span className="w-2.5 h-2.5 rounded-sm bg-wd-success" /> ≥ 99.9%
        </span>
        <span className="inline-flex items-center gap-1.5 text-wd-muted">
          <span className="w-2.5 h-2.5 rounded-sm bg-wd-warning" /> 99.0 – 99.9%
        </span>
        <span className="inline-flex items-center gap-1.5 text-wd-muted">
          <span className="w-2.5 h-2.5 rounded-sm bg-wd-danger" /> &lt; 99.0%
        </span>
      </div>
    </div>
  );
}

export default memo(EndpointUptimeRibbonBase);
export { autoWindowFromAge, type Window as UptimeWindow };
