/**
 * Fleet status hero banner — title + live pulse icon on the left, ring with
 * legend on the right. Tone shifts (neutral/warning/danger) depending on
 * whether anything is degraded or down.
 */
import { Icon } from "@iconify/react";
import { Card, cn } from "@heroui/react";
import { FleetRing } from "./FleetRing";

interface StatusCounts {
  healthy: number;
  degraded: number;
  down: number;
  paused: number;
  total: number;
}

interface FleetHeroProps {
  counts: StatusCounts;
  activeIncidents: number;
}

export function FleetHero({ counts, activeIncidents }: FleetHeroProps) {
  const { healthy, degraded, down, paused, total } = counts;
  const tone: "success" | "warning" | "danger" =
    down > 0 ? "danger" : degraded > 0 ? "warning" : "success";

  const title =
    total === 0
      ? "No Endpoints Yet"
      : down > 0
        ? `${down} Endpoint${down > 1 ? "s" : ""} Down`
        : degraded > 0
          ? `${degraded} Endpoint${degraded > 1 ? "s" : ""} Degraded`
          : "All Systems Operational";

  const sub =
    total === 0
      ? "Add an endpoint to start monitoring"
      : down > 0
        ? `Active incident · ${activeIncidents} open · responders paged`
        : degraded > 0
          ? `Elevated latency or error rate · ${activeIncidents} open incident${activeIncidents !== 1 ? "s" : ""}`
          : `All ${total} endpoints healthy · ${activeIncidents === 0 ? "no open incidents" : `${activeIncidents} open`}`;

  const icon =
    tone === "danger"
      ? "solar:danger-triangle-bold"
      : tone === "warning"
        ? "solar:bell-bing-outline"
        : "solar:shield-check-bold";

  const toneBg =
    tone === "danger"
      ? "bg-wd-danger/5 border-wd-danger/30"
      : tone === "warning"
        ? "bg-wd-warning/5 border-wd-warning/25"
        : "bg-wd-surface border-wd-border/50";

  const pulseBg =
    tone === "danger"
      ? "bg-wd-danger/15 text-wd-danger"
      : tone === "warning"
        ? "bg-wd-warning/15 text-wd-warning"
        : "bg-wd-success/15 text-wd-success";

  return (
    <Card
      className={cn(
        "relative !shadow-none !border !rounded-xl !p-0 !overflow-visible !h-full",
        toneBg,
      )}
    >
      <div className="px-5 py-5 flex flex-col gap-5 h-full">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              "relative flex items-center justify-center w-12 h-12 rounded-xl shrink-0",
              pulseBg,
            )}
          >
            <Icon icon={icon} width={24} />
            <span
              aria-hidden
              className={cn(
                "absolute inset-[-4px] rounded-[18px] opacity-10 animate-ping",
                tone === "danger"
                  ? "bg-wd-danger"
                  : tone === "warning"
                    ? "bg-wd-warning"
                    : "bg-wd-success",
              )}
            />
          </div>
          <div className="min-w-0">
            <div className="text-[20px] font-semibold tracking-tight leading-tight text-foreground truncate">
              {title}
            </div>
            <div className="text-[12px] text-wd-muted mt-0.5 truncate">
              {sub}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 flex-1">
          <FleetRing
            healthy={healthy}
            degraded={degraded}
            down={down}
            paused={paused}
            size={168}
            thickness={14}
          />
          <div className="flex flex-col gap-2 text-[12px]">
            <LegendRow color="bg-wd-success" label="Healthy" value={healthy} />
            <LegendRow
              color="bg-wd-warning"
              label="Degraded"
              value={degraded}
            />
            <LegendRow color="bg-wd-danger" label="Down" value={down} />
            <LegendRow color="bg-wd-muted" label="Paused" value={paused} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function LegendRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn("h-2 w-2 rounded-full shrink-0", color)} />
      <span className="text-wd-muted min-w-[64px]">{label}</span>
      <span className="font-mono font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}
