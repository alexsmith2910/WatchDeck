/**
 * Scope picker + time range selector + refresh button.
 *
 * WatchDeck doesn't have a first-class "group" concept (endpoints live flat),
 * so the picker is search + multi-select endpoint chooser. An empty selection
 * means "fleet-wide".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { ApiEndpoint } from "../../types/api";
import { Segmented } from "../endpoint-detail/primitives";
import type { FleetRange } from "./fleetData";

const RANGE_OPTIONS: { key: FleetRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
];

interface Props {
  endpoints: ApiEndpoint[];
  selectedIds: string[];
  onSelChange: (ids: string[]) => void;
  range: FleetRange;
  onRangeChange: (r: FleetRange) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

function statusDotClass(
  status: ApiEndpoint["lastStatus"] | undefined,
  endpointStatus: ApiEndpoint["status"],
): string {
  if (endpointStatus === "paused") return "bg-wd-paused";
  switch (status) {
    case "healthy":
      return "bg-wd-success";
    case "degraded":
      return "bg-wd-warning";
    case "down":
      return "bg-wd-danger";
    default:
      return "bg-wd-muted/60";
  }
}

export function OverviewFilterBar({
  endpoints,
  selectedIds,
  onSelChange,
  range,
  onRangeChange,
  onRefresh,
  refreshing,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter((ep) => {
      const hay = `${ep.name} ${ep.url ?? ""} ${ep.host ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [endpoints, query]);

  function toggleId(id: string) {
    if (selectedIds.includes(id))
      onSelChange(selectedIds.filter((x) => x !== id));
    else onSelChange([...selectedIds, id]);
  }

  const totalSel = selectedIds.length;
  const pickedEndpoints = useMemo(
    () =>
      selectedIds
        .map((id) => endpoints.find((e) => e.id === id))
        .filter((e): e is ApiEndpoint => !!e),
    [selectedIds, endpoints],
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center rounded-xl border border-wd-border/50 bg-wd-surface px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-wd-muted/80 mr-1">
          Scope
        </span>

        <div
          ref={ref}
          className={cn(
            "relative flex items-center gap-1.5 min-h-[28px] px-2 py-0.5 rounded-md",
            "border border-dashed border-wd-border/70 bg-wd-surface-hover/40",
            "hover:border-wd-primary/50 transition-colors",
            "cursor-pointer",
            "flex-wrap max-w-[720px]",
          )}
          onClick={(e) => {
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).dataset.placeholder === "true"
            )
              setOpen((o) => !o);
          }}
        >
          <Icon
            icon="solar:server-square-outline"
            width={13}
            className="text-wd-muted"
          />
          {totalSel === 0 ? (
            <span
              data-placeholder="true"
              className="text-[11.5px] text-wd-muted"
              onClick={() => {
                setOpen((o) => !o);
              }}
            >
              All endpoints
            </span>
          ) : (
            pickedEndpoints.slice(0, 4).map((ep) => (
              <span
                key={ep.id}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-wd-primary/10 text-wd-primary border border-wd-primary/20 font-mono text-[10.5px]"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                {ep.name}
                <button
                  type="button"
                  className="opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleId(ep.id);
                  }}
                  aria-label={`Remove ${ep.name}`}
                >
                  <Icon icon="solar:close-circle-outline" width={10} />
                </button>
              </span>
            ))
          )}
          {totalSel > 4 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(true);
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-wd-surface-hover border border-wd-border/60 text-wd-muted font-mono text-[10.5px]"
            >
              +{totalSel - 4} more
            </button>
          )}
          {totalSel > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelChange([]);
              }}
              className="ml-auto text-[10.5px] text-wd-muted/80 hover:text-foreground px-1.5 py-0.5 rounded"
            >
              Clear
            </button>
          )}

          {open && (
            <div
              onClick={(e) => {
                e.stopPropagation();
              }}
              className="absolute top-[calc(100%+6px)] left-0 w-[340px] max-h-[360px] bg-wd-surface border border-wd-border rounded-xl shadow-lg z-20 flex flex-col overflow-hidden"
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-wd-border text-wd-muted">
                <Icon icon="solar:magnifer-outline" width={13} />
                <input
                  autoFocus
                  placeholder="Search endpoints…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                  className="flex-1 bg-transparent outline-none text-[12px] text-foreground"
                />
                <span className="font-mono text-[10px] text-wd-muted/80">
                  {totalSel}/{endpoints.length}
                </span>
              </div>
              <div className="overflow-auto p-1 flex-1">
                {filtered.length === 0 ? (
                  <div className="px-2 py-6 text-center text-[12px] text-wd-muted">
                    No matches
                  </div>
                ) : (
                  filtered.map((ep) => {
                    const selected = selectedIds.includes(ep.id);
                    const dot = statusDotClass(ep.lastStatus, ep.status);
                    return (
                      <div
                        key={ep.id}
                        onClick={() => {
                          toggleId(ep.id);
                        }}
                        className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-wd-surface-hover cursor-pointer text-[12px] text-foreground"
                      >
                        <span
                          className={cn(
                            "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                            selected
                              ? "bg-wd-primary border-wd-primary"
                              : "border-wd-border",
                          )}
                        >
                          {selected && (
                            <Icon
                              icon="solar:check-read-outline"
                              width={10}
                              className="text-white"
                            />
                          )}
                        </span>
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            dot,
                          )}
                        />
                        <span className="truncate">{ep.name}</span>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="flex items-center justify-between px-3 py-2 border-t border-wd-border bg-wd-surface-hover/60 text-[11px] text-wd-muted">
                <span>
                  {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSelChange([]);
                    }}
                    className="text-wd-primary font-medium px-1.5 py-0.5 rounded hover:bg-wd-surface-hover"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSelChange(endpoints.map((e) => e.id));
                    }}
                    className="text-wd-primary font-medium px-1.5 py-0.5 rounded hover:bg-wd-surface-hover"
                  >
                    All
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 justify-self-end">
        <Segmented<FleetRange>
          ariaLabel="Time range"
          options={RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
          mono
        />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-wd-border/50 bg-wd-surface hover:bg-wd-surface-hover text-wd-muted hover:text-foreground transition-colors"
          >
            <Icon
              icon="solar:refresh-outline"
              width={14}
              className={refreshing ? "animate-spin" : ""}
            />
          </button>
        )}
      </div>
    </div>
  );
}
