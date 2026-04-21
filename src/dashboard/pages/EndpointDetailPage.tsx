/**
 * Endpoint detail page.
 *
 * Rebuilt from the ground up against the designs in `temp/endpoint details/`.
 * The page is a thin orchestrator:
 *   1. Phase 1 fetch — endpoint + uptime stats (unblocks render).
 *   2. Phase 2 fetch — 30d dailies + incidents + channels (fills in uptime
 *      ribbon, KPI sparks, and tab data).
 *   3. SSE — `check:complete` updates the endpoint's lastStatus / latency live
 *      so the hero banner + "current RT" KPI reflect the latest probe.
 *
 * The Metrics tab's Response-Time range selector doubles as the master range
 * for all four graphs on that tab (histogram, success rate, hour-of-day),
 * hoisted here so it persists across tab switches.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import type {
  ApiCheck,
  ApiEndpoint,
  ApiIncident,
  DailySummary,
  HourlySummary,
  UptimeStats,
} from "../types/api";
import type { ApiChannel } from "../types/notifications";
import EndpointHero, {
  type HeroStatus,
} from "../components/endpoint-detail/EndpointHero";
import EndpointKpiStrip from "../components/endpoint-detail/EndpointKpiStrip";
import EndpointUptimeRibbon, {
  autoWindowFromAge,
  type UptimeWindow,
} from "../components/endpoint-detail/EndpointUptimeRibbon";
import EndpointTabs, {
  type EndpointTabId,
} from "../components/endpoint-detail/EndpointTabs";
import MetricsTab, {
  type MetricsRange,
} from "../components/endpoint-detail/MetricsTab";
import ChecksTab from "../components/endpoint-detail/ChecksTab";
import IncidentsTab from "../components/endpoint-detail/IncidentsTab";
import NotificationsTab from "../components/endpoint-detail/NotificationsTab";
import SettingsTab from "../components/endpoint-detail/SettingsTab";

const VALID_TABS: EndpointTabId[] = [
  "metrics",
  "checks",
  "incidents",
  "notifications",
  "settings",
];

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { request } = useApi();
  const { subscribe } = useSSE();

  // ── Tab state (URL-synced) ──────────────────────────────────────────────
  const initialTab = (searchParams.get("tab") ?? "metrics") as EndpointTabId;
  const [activeTab, setActiveTabState] = useState<EndpointTabId>(
    VALID_TABS.includes(initialTab) ? initialTab : "metrics",
  );
  const setActiveTab = useCallback(
    (tab: EndpointTabId) => {
      setActiveTabState(tab);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (tab === "metrics") next.delete("tab");
          else next.set("tab", tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // ── Master range shared across all 4 Metrics-tab graphs ────────────────
  const [metricsRange, setMetricsRange] = useState<MetricsRange>("30d");

  // ── Data state ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [aggLoading, setAggLoading] = useState(true);
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null);
  const [latestCheck, setLatestCheck] = useState<ApiCheck | null>(null);
  const [uptimeStats, setUptimeStats] = useState<UptimeStats | null>(null);
  const [daily30d, setDaily30d] = useState<DailySummary[]>([]);
  const [hourly24h, setHourly24h] = useState<HourlySummary[]>([]);
  const [lastHourChecks, setLastHourChecks] = useState<ApiCheck[]>([]);
  const [incidents, setIncidents] = useState<ApiIncident[]>([]);
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [ribbonWindow, setRibbonWindow] = useState<UptimeWindow>(30);

  // ── Fetch ───────────────────────────────────────────────────────────────
  const fetchPhase1 = useCallback(async () => {
    if (!id) return;
    const fromIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const [epRes, uptimeRes, hourlyRes, lastHourRes] = await Promise.all([
      request<{ data: ApiEndpoint; latestCheck: ApiCheck | null }>(
        `/endpoints/${id}`,
      ),
      request<{ data: UptimeStats }>(`/endpoints/${id}/uptime`),
      request<{ data: HourlySummary[] }>(`/endpoints/${id}/hourly?limit=24`),
      request<{ data: ApiCheck[] }>(
        `/endpoints/${id}/checks?from=${encodeURIComponent(fromIso)}&limit=200`,
      ),
    ]);
    if (epRes.status < 400) {
      setEndpoint(epRes.data.data);
      setLatestCheck(epRes.data.latestCheck);
      // Initial ribbon window based on endpoint age (30→60→90).
      if (epRes.data.data.createdAt) {
        setRibbonWindow(autoWindowFromAge(epRes.data.data.createdAt));
      }
    }
    if (uptimeRes.status < 400) setUptimeStats(uptimeRes.data.data);
    if (hourlyRes.status < 400) setHourly24h(hourlyRes.data.data ?? []);
    if (lastHourRes.status < 400) setLastHourChecks(lastHourRes.data.data ?? []);
    setLoading(false);
  }, [id, request]);

  const fetchPhase2 = useCallback(async () => {
    if (!id) return;
    setAggLoading(true);
    const [dailyRes, incRes, chanRes] = await Promise.all([
      request<{ data: DailySummary[] }>(`/endpoints/${id}/daily?limit=90`),
      request<{ data: ApiIncident[] }>(`/incidents?endpointId=${id}&limit=500`),
      request<{ data: ApiChannel[] }>(`/channels`),
    ]);
    if (dailyRes.status < 400) setDaily30d(dailyRes.data.data ?? []);
    if (incRes.status < 400) setIncidents(incRes.data.data ?? []);
    if (chanRes.status < 400) setChannels(chanRes.data.data ?? []);
    setAggLoading(false);
  }, [id, request]);

  useEffect(() => {
    setLoading(true);
    void fetchPhase1();
    void fetchPhase2();
  }, [fetchPhase1, fetchPhase2]);

  // ── SSE live updates ───────────────────────────────────────────────────
  useEffect(() => {
    const unsubCheck = subscribe("check:complete", (data: unknown) => {
      const payload = data as {
        endpointId: string;
        status: ApiCheck["status"];
        responseTime: number;
        statusCode?: number;
        timestamp: string;
        sslDaysRemaining?: number;
      };
      if (payload.endpointId !== id) return;
      setEndpoint((ep) =>
        ep
          ? {
              ...ep,
              lastStatus: payload.status,
              lastResponseTime: payload.responseTime,
              lastStatusCode: payload.statusCode ?? null,
              lastCheckAt: payload.timestamp,
            }
          : ep,
      );
      setLatestCheck((lc) => ({
        _id: `live-${Date.now()}`,
        endpointId: payload.endpointId,
        timestamp: payload.timestamp,
        responseTime: payload.responseTime,
        statusCode: payload.statusCode,
        status: payload.status,
        sslDaysRemaining: payload.sslDaysRemaining ?? lc?.sslDaysRemaining,
        duringMaintenance: false,
      }));
      setLastHourChecks((prev) => {
        const cutoff = Date.now() - 60 * 60_000;
        const next: ApiCheck = {
          _id: `live-${Date.now()}`,
          endpointId: payload.endpointId,
          timestamp: payload.timestamp,
          responseTime: payload.responseTime,
          statusCode: payload.statusCode,
          status: payload.status,
          sslDaysRemaining: payload.sslDaysRemaining,
          duringMaintenance: false,
        };
        return [next, ...prev].filter(
          (c) => new Date(c.timestamp).getTime() >= cutoff,
        );
      });
    });
    const unsubIncOpened = subscribe("incident:opened", (data: unknown) => {
      const payload = data as { incident: ApiIncident };
      if (payload.incident?.endpointId !== id) return;
      setIncidents((prev) => [
        payload.incident,
        ...prev.filter((i) => i._id !== payload.incident._id),
      ]);
    });
    const unsubIncResolved = subscribe("incident:resolved", (data: unknown) => {
      const payload = data as {
        incidentId: string;
        timestamp: string;
        durationSeconds: number;
      };
      setIncidents((prev) =>
        prev.map((i) =>
          i._id === payload.incidentId
            ? {
                ...i,
                status: "resolved",
                resolvedAt: payload.timestamp,
                durationSeconds: payload.durationSeconds,
              }
            : i,
        ),
      );
    });
    return () => {
      unsubCheck();
      unsubIncOpened();
      unsubIncResolved();
    };
  }, [id, subscribe]);

  // ── Derived state ──────────────────────────────────────────────────────
  const heroStatus = useMemo<HeroStatus>(() => {
    if (!endpoint) return "healthy";
    if (endpoint.status === "paused") return "paused";
    return (endpoint.lastStatus ?? "healthy") as HeroStatus;
  }, [endpoint]);

  const tabCounts = useMemo(
    () => ({
      incidents: incidents.length || undefined,
      notifications:
        (endpoint?.notificationChannelIds?.length ?? 0) +
          (endpoint?.escalationChannelId ? 1 : 0) || undefined,
    }),
    [
      incidents.length,
      endpoint?.notificationChannelIds,
      endpoint?.escalationChannelId,
    ],
  );

  // ── Actions ────────────────────────────────────────────────────────────
  const [pausing, setPausing] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  const togglePause = useCallback(async () => {
    if (!endpoint) return;
    setPausing(true);
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint._id}/toggle`,
      {
        method: "PATCH",
      },
    );
    if (res.status < 400 && res.data.data) {
      setEndpoint(res.data.data);
    }
    setPausing(false);
  }, [endpoint, request]);

  const runNow = useCallback(async () => {
    if (!endpoint) return;
    setRunningNow(true);
    await request(`/endpoints/${endpoint._id}/recheck`, { method: "POST" });
    // Result will arrive via SSE.
    setRunningNow(false);
  }, [endpoint, request]);

  const onEdit = useCallback(() => setActiveTab("settings"), [setActiveTab]);

  // ── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-4 lg:p-6 flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!endpoint) {
    return (
      <div className="p-4 lg:p-6 flex flex-col items-center justify-center py-24 gap-3">
        <Icon
          icon="solar:danger-triangle-linear"
          width={32}
          className="text-wd-danger"
        />
        <div className="text-[13px] text-foreground font-medium">
          Endpoint not found.
        </div>
        <Button
          size="sm"
          variant="outline"
          onPress={() => navigate("/endpoints")}
        >
          <Icon icon="solar:arrow-left-linear" width={14} className="mr-1.5" />
          Back to endpoints
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => navigate("/endpoints")}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-wd-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <Icon icon="solar:arrow-left-linear" width={13} />
          All endpoints
        </button>
        {uptimeStats && (
          <div className="flex items-center gap-3 text-[11px] font-mono text-wd-muted">
            {uptimeStats["24h"] != null && (
              <span>
                24h{" "}
                <b className="text-foreground">
                  {uptimeStats["24h"]!.toFixed(2)}%
                </b>
              </span>
            )}
            {uptimeStats["7d"] != null && (
              <span>
                7d{" "}
                <b className="text-foreground">
                  {uptimeStats["7d"]!.toFixed(2)}%
                </b>
              </span>
            )}
            {uptimeStats["30d"] != null && (
              <span>
                30d{" "}
                <b className="text-foreground">
                  {uptimeStats["30d"]!.toFixed(2)}%
                </b>
              </span>
            )}
          </div>
        )}
      </div>

      <EndpointHero
        endpoint={endpoint}
        status={heroStatus}
        currentLatencyMs={
          latestCheck?.responseTime ?? endpoint.lastResponseTime ?? null
        }
        onEdit={onEdit}
        onRunNow={runNow}
        onTogglePause={togglePause}
        pausing={pausing}
        runningNow={runningNow}
      />

      <EndpointKpiStrip
        endpoint={endpoint}
        latestCheck={latestCheck}
        hourly24h={hourly24h}
        daily30d={daily30d}
        lastHourChecks={lastHourChecks}
        incidents={incidents}
      />

      <EndpointUptimeRibbon
        dailies={daily30d}
        loading={aggLoading}
        endpointCreatedAt={endpoint.createdAt}
        window={ribbonWindow}
        setWindow={setRibbonWindow}
      />

      <EndpointTabs
        active={activeTab}
        onSelect={setActiveTab}
        counts={tabCounts}
      />

      <div className="pt-2">
        {activeTab === "metrics" && (
          <MetricsTab
            endpointId={endpoint._id}
            range={metricsRange}
            setRange={setMetricsRange}
            hourly24h={hourly24h}
            daily30d={daily30d}
            latencyThreshold={endpoint.latencyThreshold}
          />
        )}
        {activeTab === "checks" && <ChecksTab endpoint={endpoint} />}
        {activeTab === "incidents" && (
          <IncidentsTab
            endpointId={endpoint._id}
            incidents={incidents}
            loading={aggLoading}
          />
        )}
        {activeTab === "notifications" && (
          <NotificationsTab
            endpointId={endpoint._id}
            endpoint={endpoint}
            channels={channels}
          />
        )}
        {activeTab === "settings" && (
          <SettingsTab
            endpoint={endpoint}
            channels={channels}
            onEndpointUpdated={(next) => setEndpoint(next)}
            onDeleted={() => navigate("/endpoints")}
          />
        )}
      </div>
    </div>
  );
}
