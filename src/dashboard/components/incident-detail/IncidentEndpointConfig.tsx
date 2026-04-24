/**
 * Right-rail endpoint configuration card — a compact KV list of the same
 * monitoring settings that live on the endpoint Settings tab. Read-only;
 * edits happen on the endpoint detail page.
 *
 * Fields from the new-design spec that don't exist on WatchDeck's schema
 * (`owner`, `region`, `tags`, `runbook`, `bodyCheck` literal) are omitted.
 * The assertions count stands in for the "body check" line when present.
 */
import { memo } from "react";
import { Icon } from "@iconify/react";
import type { ApiEndpoint } from "../../types/api";

interface Props {
  endpoint: ApiEndpoint | null;
}

function IncidentEndpointConfigBase({ endpoint }: Props) {
  if (!endpoint) return null;
  const method = endpoint.type === "http" ? (endpoint.method ?? "GET") : "TCP";
  const expected =
    endpoint.type === "http" && endpoint.expectedStatusCodes?.length
      ? endpoint.expectedStatusCodes.join(", ")
      : "—";
  const assertionCount = endpoint.assertions?.length ?? 0;

  const rows: Array<{
    k: string;
    v: React.ReactNode;
    mono?: boolean;
    strong?: boolean;
  }> = [
    { k: "Method", v: method, mono: true },
    {
      k: "Interval",
      v: `every ${endpoint.checkInterval}s`,
      mono: true,
    },
    { k: "Timeout", v: `${endpoint.timeout}ms`, mono: true },
    {
      k: "Checks until failure",
      v: (
        <span>
          <b className="font-mono tabular-nums text-[13px] text-wd-danger">
            {endpoint.failureThreshold}
          </b>{" "}
          consecutive
        </span>
      ),
      strong: true,
    },
    {
      k: "Recovery threshold",
      v: (
        <span>
          <b className="font-mono tabular-nums text-[13px] text-wd-success">
            {endpoint.recoveryThreshold}
          </b>{" "}
          healthy
        </span>
      ),
    },
    {
      k: "Latency threshold",
      v: `< ${endpoint.latencyThreshold}ms`,
      mono: true,
    },
    { k: "Expected codes", v: expected, mono: true },
    {
      k: "Alert cooldown",
      v: `${endpoint.alertCooldown}s`,
      mono: true,
    },
    {
      k: "Escalation delay",
      v:
        endpoint.escalationDelay > 0
          ? `${endpoint.escalationDelay}s`
          : "off",
      mono: true,
    },
    {
      k: "Recovery alert",
      v: endpoint.recoveryAlert ? "on" : "off",
      mono: true,
    },
  ];

  if (endpoint.type === "http" && assertionCount > 0) {
    rows.push({
      k: "Assertions",
      v: `${assertionCount} configured`,
      mono: true,
    });
  }

  return (
    <div className="rounded-xl border border-wd-border/60 bg-wd-surface p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div className="w-[26px] h-[26px] rounded-md inline-flex items-center justify-center bg-wd-primary/12 text-wd-primary">
          <Icon icon="solar:settings-linear" width={14} />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">
            Endpoint configuration
          </div>
          <div className="text-[11px] font-mono text-wd-muted truncate">
            {endpoint.name}
          </div>
        </div>
      </div>
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <div
            key={r.k}
            className="grid grid-cols-[1fr_auto] gap-2.5 py-1.5 text-[11.5px] border-b border-dashed border-wd-border/40 last:border-b-0"
            style={i === 0 ? { paddingTop: 0 } : undefined}
          >
            <span className="text-wd-muted text-[11px]">{r.k}</span>
            <span
              className={
                r.mono
                  ? "font-mono tabular-nums text-foreground"
                  : "text-foreground font-medium"
              }
            >
              {r.v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(IncidentEndpointConfigBase);
