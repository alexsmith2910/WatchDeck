/**
 * Live, streaming fleet activity feed. Seeds from recent incidents on mount,
 * then appends SSE events (incident:opened, incident:resolved, check:complete
 * transitions, endpoint:created, endpoint:deleted) as they arrive.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { Card, cn } from "@heroui/react";
import { useSSE } from "../../hooks/useSSE";
import { useFormat } from "../../hooks/useFormat";
import type { ApiIncident } from "../../types/api";
import { metaFor } from "../incidents/incidentHelpers";

type FeedKind = "down" | "ok" | "warn" | "info" | "neutral";

interface FeedItem {
  id: string;
  kind: FeedKind;
  at: string;
  text: React.ReactNode;
}

interface Props {
  recentIncidents: ApiIncident[];
  endpointName: (endpointId: string) => string;
  maxItems?: number;
}

const iconFor: Record<FeedKind, string> = {
  down: "solar:danger-triangle-bold",
  ok: "solar:check-circle-bold",
  warn: "solar:bell-bing-outline",
  info: "solar:info-circle-outline",
  neutral: "solar:clipboard-list-outline",
};

function classFor(kind: FeedKind): string {
  switch (kind) {
    case "down":
      return "bg-wd-danger/15 text-wd-danger";
    case "ok":
      return "bg-wd-success/15 text-wd-success";
    case "warn":
      return "bg-wd-warning/15 text-wd-warning";
    case "info":
      return "bg-wd-info/15 text-wd-info";
    default:
      return "bg-wd-surface-hover text-wd-muted";
  }
}

export function LiveActivityFeed({
  recentIncidents,
  endpointName,
  maxItems = 40,
}: Props) {
  const { subscribe } = useSSE();
  const fmt = useFormat();
  const [items, setItems] = useState<FeedItem[]>([]);
  const seenIncidentsRef = useRef(new Set<string>());

  // Seed feed from recent incident history so the list has content on mount.
  const seeded = useMemo<FeedItem[]>(() => {
    const seeds: FeedItem[] = [];
    for (const inc of recentIncidents.slice(0, 15)) {
      const name = endpointName(inc.endpointId);
      const cause = metaFor(inc.cause).label;
      seenIncidentsRef.current.add(inc._id);
      if (inc.status === "active") {
        seeds.push({
          id: `seed-inc-open-${inc._id}`,
          kind: "down",
          at: inc.startedAt,
          text: (
            <>
              Incident opened on <strong>{name}</strong> · <code>{cause}</code>
            </>
          ),
        });
      } else {
        seeds.push({
          id: `seed-inc-res-${inc._id}`,
          kind: "ok",
          at: inc.resolvedAt ?? inc.startedAt,
          text: (
            <>
              Incident resolved on <strong>{name}</strong> ·{" "}
              <code>{cause}</code>
            </>
          ),
        });
      }
    }
    return seeds.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [recentIncidents, endpointName]);

  useEffect(() => {
    setItems(seeded);
  }, [seeded]);

  // SSE: incident opened
  useEffect(() => {
    return subscribe("incident:opened", (raw) => {
      const evt = raw as { timestamp?: string; incident?: ApiIncident };
      const inc = evt.incident;
      if (!inc || seenIncidentsRef.current.has(inc._id)) return;
      seenIncidentsRef.current.add(inc._id);
      const name = endpointName(inc.endpointId);
      const cause = metaFor(inc.cause).label;
      setItems((prev) =>
        [
          {
            id: `sse-inc-open-${inc._id}`,
            kind: "down",
            at: evt.timestamp ?? inc.startedAt,
            text: (
              <>
                Incident opened on <strong>{name}</strong> ·{" "}
                <code>{cause}</code>
              </>
            ),
          },
          ...prev,
        ].slice(0, maxItems),
      );
    });
  }, [subscribe, endpointName, maxItems]);

  // SSE: incident resolved
  useEffect(() => {
    return subscribe("incident:resolved", (raw) => {
      const evt = raw as {
        timestamp?: string;
        incidentId: string;
        endpointId?: string;
      };
      const name = evt.endpointId ? endpointName(evt.endpointId) : "endpoint";
      setItems((prev) =>
        [
          {
            id: `sse-inc-res-${evt.incidentId}-${Date.now()}`,
            kind: "ok",
            at: evt.timestamp ?? new Date().toISOString(),
            text: (
              <>
                Incident resolved on <strong>{name}</strong>
              </>
            ),
          },
          ...prev,
        ].slice(0, maxItems),
      );
    });
  }, [subscribe, endpointName, maxItems]);

  // SSE: status transitions — signal only genuine state changes, not every tick.
  const lastStatusRef = useRef(new Map<string, string>());
  useEffect(() => {
    return subscribe("check:complete", (raw) => {
      const evt = raw as {
        timestamp?: string;
        endpointId: string;
        status: "healthy" | "degraded" | "down";
        statusCode?: number | null;
      };
      const prev = lastStatusRef.current.get(evt.endpointId);
      lastStatusRef.current.set(evt.endpointId, evt.status);
      if (prev == null || prev === evt.status) return;

      const name = endpointName(evt.endpointId);
      if (evt.status === "down") {
        setItems((p) =>
          [
            {
              id: `sse-down-${evt.endpointId}-${Date.now()}`,
              kind: "down",
              at: evt.timestamp ?? new Date().toISOString(),
              text: (
                <>
                  <strong>{name}</strong> went <strong>DOWN</strong>
                  {evt.statusCode ? (
                    <>
                      {" "}
                      · <code>HTTP {evt.statusCode}</code>
                    </>
                  ) : null}
                </>
              ),
            },
            ...p,
          ].slice(0, maxItems),
        );
      } else if (evt.status === "degraded") {
        setItems((p) =>
          [
            {
              id: `sse-deg-${evt.endpointId}-${Date.now()}`,
              kind: "warn",
              at: evt.timestamp ?? new Date().toISOString(),
              text: (
                <>
                  <strong>{name}</strong> degraded
                </>
              ),
            },
            ...p,
          ].slice(0, maxItems),
        );
      } else if (prev === "down" || prev === "degraded") {
        setItems((p) =>
          [
            {
              id: `sse-rec-${evt.endpointId}-${Date.now()}`,
              kind: "ok",
              at: evt.timestamp ?? new Date().toISOString(),
              text: (
                <>
                  <strong>{name}</strong> recovered
                </>
              ),
            },
            ...p,
          ].slice(0, maxItems),
        );
      }
    });
  }, [subscribe, endpointName, maxItems]);

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      <div className="p-4 flex flex-col gap-2 max-h-[360px] overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-primary/15 text-wd-primary shrink-0">
              <Icon icon="solar:pulse-2-outline" width={13} />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-foreground">
                Live Activity
              </div>
              <div className="text-[11px] text-wd-muted mt-0.5">
                Fleet-wide events · streaming
              </div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono font-semibold uppercase tracking-wider text-wd-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-wd-success animate-pulse" />
            Live
          </span>
        </div>

        <div className="flex flex-col gap-0 overflow-auto flex-1 pr-1">
          {items.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-wd-muted">
              Listening for fleet events…
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="grid grid-cols-[20px_1fr_auto] gap-2.5 items-start py-2 border-b border-dashed border-wd-border/50 last:border-0"
              >
                <div
                  className={cn(
                    "w-[18px] h-[18px] rounded-[5px] flex items-center justify-center shrink-0 mt-0.5",
                    classFor(it.kind),
                  )}
                >
                  <Icon icon={iconFor[it.kind]} width={10} />
                </div>
                <div className="text-[12px] text-foreground leading-snug min-w-0">
                  <span className="[&_code]:font-mono [&_code]:text-[11px] [&_code]:text-wd-muted [&_code]:bg-wd-surface-hover [&_code]:px-1 [&_code]:py-px [&_code]:rounded [&_code]:border [&_code]:border-wd-border/50 [&_strong]:font-semibold">
                    {it.text}
                  </span>
                </div>
                <div className="font-mono text-[10.5px] text-wd-muted/80 whitespace-nowrap">
                  {fmt.relative(it.at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}
