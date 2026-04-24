/**
 * Fleet-wide Overview page.
 *
 * Data flow:
 *   • fetchCore() loads endpoints + incident history + per-endpoint 30d uptime
 *     once on mount. SSE events update endpoints/incidents state in place.
 *   • A separate "chart fetch" effect loads hourly or daily summaries for the
 *     current scope + range. Its dep key is `effectiveIdKey` (a sorted, comma-
 *     joined id string) — so SSE updates that mutate `endpoints` without
 *     adding/removing rows do NOT trigger a refetch.
 *   • Derived datasets (fleet buckets, heatmap rows, rankings, per-endpoint
 *     comparison) are computed via useMemo from the raw hourly/daily maps so
 *     the user-visible numbers stay live without thrashing the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import { useFormat } from "../hooks/useFormat";
import { useSlo } from "../hooks/useSlo";
import KpiCard from "../components/KpiCard";
import OverviewChart from "../components/OverviewChart";
import { FleetHero } from "../components/overview/FleetHero";
import { OverviewFilterBar } from "../components/overview/OverviewFilterBar";
import { StatusBarChart } from "../components/overview/StatusBarChart";
import { EndpointHeatmap } from "../components/overview/EndpointHeatmap";
import { ActiveIncidentsList } from "../components/overview/ActiveIncidentsList";
import { LiveActivityFeed } from "../components/overview/LiveActivityFeed";
import {
  SLOCompliance,
  type SLOItem,
} from "../components/overview/SLOCompliance";
import { RankCard } from "../components/overview/RankCards";
import {
  RANGE_CONFIG,
  aggregateDailies,
  aggregateHourlies,
  buildEndpointScores,
  buildHeatmapRows,
  buildPerEndpointSeries,
  canonicalBucketKeys,
  type FleetRange,
} from "../components/overview/fleetData";
import type {
  ApiEndpoint,
  ApiIncident,
  ApiPagination,
  DailySummary,
  HourlySummary,
  UptimeStats,
} from "../types/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RANGE_LABEL: Record<FleetRange, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

const PER_ENDPOINT_PALETTE = [
  "var(--wd-primary)",
  "var(--wd-warning)",
  "var(--wd-success)",
  "var(--wd-danger)",
  "var(--wd-info)",
  "#b18df0",
  "#e8a252",
  "#6ea8d8",
  "#5ac08a",
  "#d76ea8",
];

export default function OverviewPage() {
  const navigate = useNavigate();
  const { request } = useApi();
  const { subscribe } = useSSE();
  const fmt = useFormat();
  const { slo } = useSlo();

  // Core data (refreshed on manual refresh; kept live via SSE)
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  const [activeIncidents, setActiveIncidents] = useState<ApiIncident[]>([]);
  const [recentIncidents, setRecentIncidents] = useState<ApiIncident[]>([]);
  const [uptimeByEp, setUptimeByEp] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);

  // Scope + range
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [range, setRange] = useState<FleetRange>("24h");
  const [refreshing, setRefreshing] = useState(false);

  // Live response-time from SSE
  const [responseTimes, setResponseTimes] = useState<Map<string, number>>(
    new Map(),
  );

  // Raw time-series data per endpoint; derived data (buckets, heatmap,
  // rankings, per-endpoint comparison) is computed from these via useMemo.
  const [rawHourlyByEp, setRawHourlyByEp] = useState<
    Map<string, HourlySummary[]>
  >(new Map());
  const [rawDailyByEp, setRawDailyByEp] = useState<Map<string, DailySummary[]>>(
    new Map(),
  );
  const [chartLoading, setChartLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // Effective scope + stable id key
  // ---------------------------------------------------------------------------

  const effective = useMemo(() => {
    if (selectedIds.length === 0) return endpoints;
    const s = new Set(selectedIds);
    return endpoints.filter((ep) => s.has(ep._id));
  }, [endpoints, selectedIds]);

  // Stable key that only changes when the SET of effective endpoint ids
  // changes (add/remove/scope change) — NOT when SSE mutates status/response
  // time on an existing endpoint. This is what keeps the chart-fetch effect
  // from re-running on every live check result.
  const effectiveIdKey = useMemo(
    () =>
      effective
        .map((e) => e._id)
        .sort()
        .join(","),
    [effective],
  );

  // ---------------------------------------------------------------------------
  // Core fetch (endpoints + incidents + uptime)
  // ---------------------------------------------------------------------------

  const fetchCore = useCallback(async () => {
    setLoading(true);
    try {
      const [epRes, activeRes, historyRes] = await Promise.all([
        request<{ data: ApiEndpoint[]; pagination: ApiPagination }>(
          "/endpoints?limit=200",
        ),
        request<{ data: ApiIncident[] }>("/incidents/active"),
        request<{ data: ApiIncident[]; pagination: ApiPagination }>(
          "/incidents?limit=30",
        ),
      ]);

      const eps = epRes.data.data;
      setEndpoints(eps);
      setActiveIncidents(activeRes.data.data);
      setRecentIncidents(historyRes.data.data);

      if (eps.length > 0) {
        const uptimeResults = await Promise.allSettled(
          eps.map((ep) =>
            request<{ data: UptimeStats }>(`/endpoints/${ep._id}/uptime`).then(
              (r) => r.data.data,
            ),
          ),
        );
        const map = new Map<string, number | null>();
        for (let i = 0; i < eps.length; i++) {
          const ep = eps[i];
          const r = uptimeResults[i];
          if (r.status === "fulfilled") {
            const s = r.value;
            map.set(ep._id, s["30d"] ?? s["7d"] ?? s["24h"] ?? null);
          } else {
            map.set(ep._id, null);
          }
        }
        setUptimeByEp(map);
      }
    } catch {
      // Leave at defaults on failure; empty state handles the zero-endpoints case
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void fetchCore();
  }, [fetchCore]);

  // ---------------------------------------------------------------------------
  // Chart fetch — stable deps so SSE updates don't trigger refetches
  // ---------------------------------------------------------------------------

  const fetchTick = useRef(0);

  useEffect(() => {
    if (!effectiveIdKey) {
      setRawHourlyByEp(new Map());
      setRawDailyByEp(new Map());
      return;
    }
    const tick = ++fetchTick.current;
    let cancelled = false;

    async function run() {
      setChartLoading(true);
      try {
        const cfg = RANGE_CONFIG[range];
        const ids = effectiveIdKey.split(",");

        if (cfg.hourly) {
          const results = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: HourlySummary[] }>(
                `/endpoints/${id}/hourly?limit=${cfg.limit}`,
              ).then((r) => r.data.data),
            ),
          );
          if (cancelled || tick !== fetchTick.current) return;
          const map = new Map<string, HourlySummary[]>();
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const r = results[i];
            map.set(id, r.status === "fulfilled" ? r.value : []);
          }
          setRawHourlyByEp(map);
          setRawDailyByEp(new Map());
        } else {
          const results = await Promise.allSettled(
            ids.map((id) =>
              request<{ data: DailySummary[] }>(
                `/endpoints/${id}/daily?limit=${cfg.limit}`,
              ).then((r) => r.data.data),
            ),
          );
          if (cancelled || tick !== fetchTick.current) return;
          const map = new Map<string, DailySummary[]>();
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const r = results[i];
            map.set(id, r.status === "fulfilled" ? r.value : []);
          }
          setRawDailyByEp(map);
          setRawHourlyByEp(new Map());
        }
      } finally {
        if (!cancelled && tick === fetchTick.current) setChartLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [effectiveIdKey, range, request]);

  // ---------------------------------------------------------------------------
  // SSE subscriptions (live status updates, don't trigger refetches)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return subscribe("check:complete", (raw) => {
      const evt = raw as {
        endpointId: string;
        status: string;
        responseTime: number;
      };
      setEndpoints((prev) =>
        prev.map((ep) =>
          ep._id === evt.endpointId
            ? {
                ...ep,
                lastStatus: evt.status as ApiEndpoint["lastStatus"],
                lastResponseTime: evt.responseTime,
              }
            : ep,
        ),
      );
      setResponseTimes((prev) => {
        const next = new Map(prev);
        next.set(evt.endpointId, evt.responseTime);
        return next;
      });
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe("endpoint:created", (raw) => {
      const evt = raw as { endpoint: ApiEndpoint };
      setEndpoints((prev) => [...prev, evt.endpoint]);
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe("endpoint:deleted", (raw) => {
      const evt = raw as { endpointId: string };
      setEndpoints((prev) => prev.filter((ep) => ep._id !== evt.endpointId));
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe("incident:opened", (raw) => {
      const evt = raw as { incident?: ApiIncident };
      const inc = evt.incident;
      if (inc) setActiveIncidents((prev) => [inc, ...prev]);
    });
  }, [subscribe]);

  useEffect(() => {
    return subscribe("incident:resolved", (raw) => {
      const evt = raw as { incidentId: string };
      setActiveIncidents((prev) =>
        prev.filter((i) => i._id !== evt.incidentId),
      );
    });
  }, [subscribe]);

  // ---------------------------------------------------------------------------
  // Derived datasets
  // ---------------------------------------------------------------------------

  const bucketKeys = useMemo(() => canonicalBucketKeys(range), [range]);

  const labelFor = useCallback(
    (iso: string): string => {
      const cfg = RANGE_CONFIG[range];
      if (cfg.hourly) return fmt.hour(iso);
      return fmt.dateShort(iso);
    },
    [range, fmt],
  );

  const buckets = useMemo(() => {
    const cfg = RANGE_CONFIG[range];
    return cfg.hourly
      ? aggregateHourlies(rawHourlyByEp, bucketKeys, labelFor)
      : aggregateDailies(rawDailyByEp, bucketKeys, labelFor);
  }, [rawHourlyByEp, rawDailyByEp, bucketKeys, labelFor, range]);

  const heatmap = useMemo(
    () =>
      buildHeatmapRows(
        effective,
        rawHourlyByEp,
        rawDailyByEp,
        uptimeByEp,
        range,
        bucketKeys,
        labelFor,
      ),
    [
      effective,
      rawHourlyByEp,
      rawDailyByEp,
      uptimeByEp,
      range,
      bucketKeys,
      labelFor,
    ],
  );

  const rankings = useMemo(() => {
    const incidentCountByEp = new Map<string, number>();
    for (const inc of recentIncidents) {
      incidentCountByEp.set(
        inc.endpointId,
        (incidentCountByEp.get(inc.endpointId) ?? 0) + 1,
      );
    }
    return buildEndpointScores(
      effective,
      rawHourlyByEp,
      rawDailyByEp,
      incidentCountByEp,
      range,
    );
  }, [effective, rawHourlyByEp, rawDailyByEp, recentIncidents, range]);

  const perEndpoint = useMemo(
    () =>
      buildPerEndpointSeries(
        effective,
        rawHourlyByEp,
        rawDailyByEp,
        range,
        bucketKeys,
        labelFor,
      ),
    [effective, rawHourlyByEp, rawDailyByEp, range, bucketKeys, labelFor],
  );

  // ---------------------------------------------------------------------------
  // Derived summaries
  // ---------------------------------------------------------------------------

  const statusCounts = useMemo(() => {
    let healthy = 0;
    let degraded = 0;
    let down = 0;
    let paused = 0;
    for (const ep of effective) {
      if (ep.status === "paused") paused++;
      else if (ep.lastStatus === "down") down++;
      else if (ep.lastStatus === "degraded") degraded++;
      else if (ep.lastStatus === "healthy") healthy++;
    }
    return { healthy, degraded, down, paused, total: effective.length };
  }, [effective]);

  const avgResponseTime = useMemo(() => {
    if (responseTimes.size === 0) return null;
    const values: number[] = [];
    for (const ep of effective) {
      const v = responseTimes.get(ep._id);
      if (v != null) values.push(v);
    }
    if (values.length === 0) return null;
    return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  }, [responseTimes, effective]);

  const fleetUptime = useMemo(() => {
    const vals: number[] = [];
    for (const ep of effective) {
      const v = uptimeByEp.get(ep._id);
      if (v != null) vals.push(v);
    }
    if (vals.length === 0) return null;
    return (
      Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100
    );
  }, [uptimeByEp, effective]);

  const avgP95 = useMemo(() => {
    const vals = buckets
      .map((b) => b.p95)
      .filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }, [buckets]);

  const avgErrRate = useMemo(() => {
    const vals = buckets
      .map((b) => b.errRate)
      .filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return (
      Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100
    );
  }, [buckets]);

  const totalChecks = useMemo(
    () => buckets.reduce((s, b) => s + b.throughput, 0),
    [buckets],
  );
  const totalChecksDisplay = useMemo(() => {
    if (totalChecks >= 1_000_000)
      return `${(totalChecks / 1_000_000).toFixed(1)}M`;
    if (totalChecks >= 1_000) return `${(totalChecks / 1_000).toFixed(1)}k`;
    return `${totalChecks}`;
  }, [totalChecks]);

  const budgetRemaining = useMemo(() => {
    if (fleetUptime == null) return null;
    const allowedDown = 100 - slo.target;
    const actualDown = 100 - fleetUptime;
    if (allowedDown <= 0) return null;
    return Math.max(
      0,
      Math.round(((allowedDown - actualDown) / allowedDown) * 1000) / 10,
    );
  }, [fleetUptime, slo.target]);

  // ---------------------------------------------------------------------------
  // Derived datasets for charts
  // ---------------------------------------------------------------------------

  const percentileData = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        p50: b.p50,
        p95: b.p95,
        p99: b.p99,
      })),
    [buckets],
  );

  const uptimeData = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        uptime: b.uptime,
        downPercent: b.uptime == null ? null : Math.max(0, 100 - b.uptime),
        fails: b.down,
      })),
    [buckets],
  );

  const errorData = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        err: b.errRate,
        fails: b.down,
        degraded: b.degraded,
      })),
    [buckets],
  );

  const statusBarData = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        healthy: b.healthy,
        degraded: b.degraded,
        down: b.down,
      })),
    [buckets],
  );

  const perEndpointSeriesConfig = useMemo(
    () =>
      perEndpoint.series.map((s, i) => ({
        key: `rt-${s.id}`,
        label: s.name,
        color:
          PER_ENDPOINT_PALETTE[i % PER_ENDPOINT_PALETTE.length] ??
          "var(--wd-primary)",
        icon: "solar:server-square-outline",
        value: "",
        change: "",
        changeType: "neutral" as const,
      })),
    [perEndpoint.series],
  );

  const sloItems = useMemo<SLOItem[]>(
    () =>
      effective.map((ep) => ({
        id: ep._id,
        name: ep.name,
        current: uptimeByEp.get(ep._id) ?? null,
        sampleSize: 1,
      })),
    [effective, uptimeByEp],
  );

  const topSlow = useMemo(
    () =>
      [...rankings]
        .filter((r) => r.p95 > 0)
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, 5),
    [rankings],
  );
  const topFlaky = useMemo(
    () =>
      [...rankings]
        .filter((r) => r.flaps > 0)
        .sort((a, b) => b.flaps - a.flaps)
        .slice(0, 5),
    [rankings],
  );
  const topErr = useMemo(
    () =>
      [...rankings]
        .filter((r) => r.errRate > 0)
        .sort((a, b) => b.errRate - a.errRate)
        .slice(0, 5),
    [rankings],
  );

  // Keep the lookup stable across SSE ticks — otherwise LiveActivityFeed's
  // `seeded` memo invalidates every time `endpoints` mutates (which happens
  // on every `check:complete` event), resetting the feed and thrashing GC.
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const endpointName = useCallback(
    (id: string): string =>
      endpointsRef.current.find((e) => e._id === id)?.name ?? "endpoint",
    [],
  );

  // ---------------------------------------------------------------------------
  // Early returns
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-wd-muted">Loading overview…</p>
        </div>
      </div>
    );
  }

  if (endpoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <div className="rounded-full bg-wd-primary/10 p-4">
            <Icon
              icon="solar:server-square-outline"
              width={40}
              className="text-wd-primary"
            />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            No endpoints yet
          </h2>
          <p className="text-sm text-wd-muted">
            Add your first endpoint to start monitoring. WatchDeck will track
            uptime, response times, and alert you when things go wrong.
          </p>
          <Button
            className="!bg-wd-primary !text-wd-primary-foreground !rounded-lg !font-medium"
            onPress={() => navigate("/endpoints/add")}
          >
            <Icon icon="solar:add-circle-outline" width={20} />
            Add Endpoint
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Chart series configs
  // ---------------------------------------------------------------------------

  const percentileSeriesConfig = [
    {
      key: "p99",
      label: "P99",
      color: "var(--wd-danger)",
      icon: "solar:arrow-right-up-linear",
      value: "",
      change: "",
      changeType: "neutral" as const,
    },
    {
      key: "p95",
      label: "P95",
      color: "var(--wd-warning)",
      icon: "solar:graph-outline",
      value: "",
      change: "",
      changeType: "neutral" as const,
    },
    {
      key: "p50",
      label: "P50",
      color: "var(--wd-primary)",
      icon: "solar:minus-circle-outline",
      value: "",
      change: "",
      changeType: "neutral" as const,
    },
  ];

  const uptimeSeriesConfig = [
    {
      key: "uptime",
      label: "Uptime",
      color: "var(--wd-success)",
      icon: "solar:shield-check-outline",
      value: fleetUptime != null ? `${fleetUptime}%` : "—",
      change: "",
      changeType: "neutral" as const,
    },
    {
      key: "downPercent",
      label: "Downtime",
      color: "var(--wd-danger)",
      icon: "solar:close-circle-outline",
      value: fleetUptime != null ? `${(100 - fleetUptime).toFixed(2)}%` : "—",
      change: "",
      changeType: "neutral" as const,
    },
  ];

  const errorSeriesConfig = [
    {
      key: "err",
      label: "Error Rate",
      color: "var(--wd-danger)",
      icon: "solar:danger-triangle-outline",
      value: avgErrRate != null ? `${avgErrRate}%` : "—",
      change: "",
      changeType: "neutral" as const,
    },
  ];

  return (
    <div className="p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      {/* Page head */}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
            Overview
          </h1>
          <div className="text-[12.5px] text-wd-muted mt-1 flex flex-wrap items-center gap-x-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-wd-success animate-pulse" />
              Live
            </span>
            <span className="opacity-40">·</span>
            <span>
              {effective.length} of {endpoints.length} endpoints in scope
            </span>
            <span className="opacity-40">·</span>
            <span>Showing {RANGE_LABEL[range]} rolling window</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="!rounded-lg"
            onPress={() => navigate("/incidents")}
          >
            <Icon icon="solar:clipboard-list-outline" width={16} />
            Incidents
          </Button>
          <Button
            size="sm"
            className="!bg-wd-primary !text-wd-primary-foreground !rounded-lg !font-medium"
            onPress={() => navigate("/endpoints/add")}
          >
            <Icon icon="solar:add-circle-outline" width={16} />
            Add Endpoint
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <OverviewFilterBar
        endpoints={endpoints}
        selectedIds={selectedIds}
        onSelChange={setSelectedIds}
        range={range}
        onRangeChange={setRange}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void fetchCore().finally(() => {
            setRefreshing(false);
          });
        }}
      />

      {/* Waiting-for-data banner */}
      {!chartLoading &&
        effective.length > 0 &&
        buckets.every((b) => b.throughput === 0) && (
          <div className="flex items-center gap-2 rounded-lg border border-wd-border/30 bg-wd-surface-hover/30 px-3 py-2">
            <Icon
              icon="solar:clock-circle-outline"
              width={18}
              className="text-wd-muted shrink-0"
            />
            <span className="text-xs text-wd-muted">
              Waiting for aggregated data — charts populate after the first
              {RANGE_CONFIG[range].hourly ? " hourly" : " daily"} rollup
            </span>
          </div>
        )}

      {/* Hero + KPI rail */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-3">
        <FleetHero
          counts={statusCounts}
          activeIncidents={activeIncidents.length}
        />
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <KpiCard
            index={0}
            title="Fleet Uptime"
            value={fleetUptime != null ? String(fleetUptime) : "—"}
            change={fleetUptime != null ? `Target ${slo.target}%` : undefined}
            changeColor={
              fleetUptime != null
                ? fleetUptime >= slo.target
                  ? "success"
                  : "danger"
                : undefined
            }
            trend={
              fleetUptime != null
                ? fleetUptime >= slo.target
                  ? "up"
                  : "down"
                : undefined
            }
            icon="solar:heart-pulse-outline"
            color={
              fleetUptime == null
                ? "primary"
                : fleetUptime >= slo.target
                  ? "success"
                  : fleetUptime >= 99
                    ? "warning"
                    : "danger"
            }
            chartData={buckets.flatMap((b) =>
              b.uptime != null ? [{ label: b.label, value: b.uptime }] : [],
            )}
            unit="%"
            onClick={() => navigate("/endpoints")}
          />
          <KpiCard
            index={1}
            title="Global P95"
            value={avgP95 != null ? `${avgP95}` : "—"}
            change={avgP95 != null ? "Latency P95" : undefined}
            changeColor={
              avgP95 != null
                ? avgP95 < 200
                  ? "success"
                  : avgP95 < 500
                    ? "warning"
                    : "danger"
                : undefined
            }
            icon="solar:graph-outline"
            color={
              avgP95 == null
                ? "primary"
                : avgP95 < 200
                  ? "success"
                  : avgP95 < 500
                    ? "warning"
                    : "danger"
            }
            chartData={buckets.flatMap((b) =>
              b.p95 != null ? [{ label: b.label, value: b.p95 }] : [],
            )}
            unit="ms"
          />
          <KpiCard
            index={2}
            title="Error Rate"
            value={avgErrRate != null ? `${avgErrRate}` : "—"}
            change={
              avgErrRate != null
                ? avgErrRate > 1
                  ? "Over Threshold"
                  : "Within Target"
                : undefined
            }
            changeColor={
              avgErrRate != null
                ? avgErrRate > 1
                  ? "danger"
                  : "success"
                : undefined
            }
            icon="solar:danger-triangle-outline"
            color={
              avgErrRate == null
                ? "primary"
                : avgErrRate > 1
                  ? "danger"
                  : avgErrRate > 0.5
                    ? "warning"
                    : "success"
            }
            chartData={buckets.flatMap((b) =>
              b.errRate != null ? [{ label: b.label, value: b.errRate }] : [],
            )}
            unit="%"
          />
          <KpiCard
            index={3}
            title="Live Avg Response"
            value={avgResponseTime != null ? `${avgResponseTime}` : "—"}
            change="Realtime Mean"
            changeColor="primary"
            icon="solar:pulse-2-outline"
            color="primary"
            chartData={buckets.flatMap((b) =>
              b.avg != null ? [{ label: b.label, value: b.avg }] : [],
            )}
            unit="ms"
          />
          <KpiCard
            index={4}
            title="Checks Ran"
            value={totalChecksDisplay}
            changeSegments={[
              { text: `${effective.length} Endpoints`, color: "primary" },
              { text: RANGE_LABEL[range], color: "primary" },
            ]}
            icon="solar:plug-circle-outline"
            color="primary"
            chartData={buckets.map((b) => ({
              label: b.label,
              value: b.throughput,
            }))}
          />
          <KpiCard
            index={5}
            title="Active Incidents"
            value={String(activeIncidents.length)}
            changeSegments={
              activeIncidents.length > 0
                ? [
                    {
                      text: `${activeIncidents.length} Open`,
                      color: "danger",
                    },
                  ]
                : [{ text: "All Clear", color: "success" }]
            }
            icon="solar:bell-bing-outline"
            color={activeIncidents.length > 0 ? "danger" : "success"}
            chartData={buckets.map((b) => ({
              label: b.label,
              value: b.down,
            }))}
            onClick={() => navigate("/incidents")}
          />
        </div>
      </div>

      {/* SLO budget banner */}
      {budgetRemaining != null && (
        <div className="rounded-xl border border-wd-border/50 bg-wd-surface px-4 py-3 grid grid-cols-1 md:grid-cols-[auto_1fr_auto] items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-wd-primary/15 text-wd-primary">
              <Icon icon="solar:shield-check-outline" width={16} />
            </div>
            <div>
              <div className="text-[12.5px] font-semibold text-foreground">
                Error Budget Remaining
              </div>
              <div className="text-[11px] text-wd-muted">
                Rolling {slo.windowDays}d · Target {slo.target}%
              </div>
            </div>
          </div>
          <div className="h-2 rounded-full bg-wd-surface-hover overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-wd-danger via-wd-warning to-wd-success rounded-full"
              style={{ width: `${budgetRemaining}%` }}
            />
          </div>
          <div className="text-right font-mono text-[13px] font-semibold tabular-nums text-foreground">
            {budgetRemaining}%{" "}
            <span className="text-wd-muted text-[11px] font-normal">
              remaining
            </span>
          </div>
        </div>
      )}

      {/* Section: Fleet performance */}
      <SectionHead
        title="Fleet Performance"
        hint="Hover charts for per-bucket breakdown"
      />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {chartLoading ? (
          <ChartSkeleton />
        ) : (
          <OverviewChart
            title="Response Time · Percentiles"
            icon="solar:graph-outline"
            series={percentileSeriesConfig}
            data={percentileData}
            unit="ms"
          />
        )}
        {chartLoading ? (
          <ChartSkeleton />
        ) : (
          <OverviewChart
            title="Uptime % vs SLO"
            icon="solar:shield-check-outline"
            series={uptimeSeriesConfig}
            data={uptimeData}
            unit="%"
            defaultHidden={["downPercent"]}
          />
        )}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-3">
        {chartLoading ? (
          <ChartSkeleton />
        ) : (
          <OverviewChart
            title="Error Rate"
            icon="solar:danger-triangle-outline"
            series={errorSeriesConfig}
            data={errorData}
            unit="%"
          />
        )}
        {chartLoading ? (
          <ChartSkeleton />
        ) : (
          <StatusBarChart data={statusBarData} />
        )}
      </div>

      {/* Per-endpoint comparison */}
      <SectionHead
        title="Per-Endpoint Comparison"
        hint={
          selectedIds.length > 0
            ? `${selectedIds.length} selected`
            : `${effective.length} endpoint${effective.length === 1 ? "" : "s"}`
        }
      />
      {chartLoading ? (
        <ChartSkeleton full />
      ) : perEndpoint.rows.length > 0 ? (
        <OverviewChart
          title="Response Time · Per Endpoint"
          icon="solar:server-square-outline"
          series={perEndpointSeriesConfig}
          data={perEndpoint.rows}
          unit="ms"
        />
      ) : null}

      {/* Heatmap */}
      <EndpointHeatmap
        rows={heatmap}
        bucketCount={RANGE_CONFIG[range].limit}
        xLabels={bucketKeys.map((k) => labelFor(k))}
      />

      {/* Incidents / feed / SLO */}
      <SectionHead
        title="Incidents & Compliance"
        hint={
          <button
            type="button"
            onClick={() => navigate("/incidents")}
            className="text-wd-primary hover:underline"
          >
            Go to Incidents →
          </button>
        }
      />
      <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-3">
        <ActiveIncidentsList
          incidents={activeIncidents}
          endpointName={endpointName}
        />
        <LiveActivityFeed
          recentIncidents={recentIncidents}
          endpointName={endpointName}
        />
      </div>
      <SLOCompliance
        items={sloItems}
        target={slo.target}
        windowLabel={`${slo.windowDays}d`}
      />

      {/* Rankings */}
      <SectionHead
        title="Problem Endpoints"
        hint={`Sorted across the last ${RANGE_LABEL[range]}`}
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <RankCard
          title="Slowest (P95)"
          subtitle="Top by tail latency"
          icon="solar:clock-circle-outline"
          accent="warning"
          items={topSlow}
          valueFor={(ep) => `${ep.p95}ms`}
          valueAccent={() => "warning"}
          sparkColor="var(--wd-warning)"
        />
        <RankCard
          title="Flakiest (Incidents)"
          subtitle="Recent incidents in window"
          icon="solar:bolt-outline"
          accent="danger"
          items={topFlaky}
          valueFor={(ep) => `${ep.flaps}×`}
          valueAccent={(ep) => (ep.flaps > 3 ? "danger" : "muted")}
          sparkColor="var(--wd-danger)"
        />
        <RankCard
          title="Highest Error Rate"
          subtitle="Weighted by checks"
          icon="solar:bug-outline"
          accent="danger"
          items={topErr}
          valueFor={(ep) => `${ep.errRate.toFixed(2)}%`}
          valueAccent={() => "danger"}
          sparkColor="var(--wd-primary)"
        />
      </div>

      <div className="h-2" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function SectionHead({
  title,
  hint,
}: {
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-0.5 mt-1">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-wd-muted/80">
        {title}
      </h2>
      {hint && <span className="text-[11px] text-wd-muted/80">{hint}</span>}
    </div>
  );
}

function ChartSkeleton({ full }: { full?: boolean }) {
  return (
    <div
      className={`border border-wd-border/30 rounded-xl p-8 flex items-center justify-center min-h-[300px] ${
        full ? "col-span-full" : ""
      }`}
    >
      <Spinner size="md" />
    </div>
  );
}
