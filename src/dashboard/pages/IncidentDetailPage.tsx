/**
 * Incident Detail page — orchestrator.
 *
 * Fetches the incident, its owning endpoint, checks (±30m context for the
 * chart / Why-opened viz) and related incidents on the same endpoint
 * (last 30 days). Subscribes to SSE so the page updates live:
 *   - `check:complete`  → append latest probe, refresh the last-check cell
 *   - `incident:resolved` → flip status, stop the live timer
 *   - notification:*    → the Notifications card refetches itself
 *
 * Layout matches the new design:
 *   header · 4-cell strip · [main: why-opened · chart · timeline+notifs · checks-log] · [rail: config · related]
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import type {
  ApiIncident,
  ApiEndpoint,
  ApiCheck,
} from "../types/api";
import type { ApiNotificationLogRow } from "../types/notifications";
import { getIncidentRanges } from "../utils/format";
import { useFormat } from "../hooks/useFormat";
import { formatHour } from "../utils/time";
import IncidentDetailHeader from "../components/incident-detail/IncidentDetailHeader";
import IncidentSummaryStrip from "../components/incident-detail/IncidentSummaryStrip";
import IncidentWhyOpened from "../components/incident-detail/IncidentWhyOpened";
import IncidentResponseChart, {
  type ChartPoint,
} from "../components/incident-detail/IncidentResponseChart";
import IncidentChecksLog from "../components/incident-detail/IncidentChecksLog";
import IncidentNotificationsLog from "../components/incident-detail/IncidentNotificationsLog";
import IncidentTimeline from "../components/incident-detail/IncidentTimeline";
import IncidentEndpointConfig from "../components/incident-detail/IncidentEndpointConfig";
import RelatedIncidents from "../components/incident-detail/RelatedIncidents";
import {
  type CheckPoint,
  type LiveCheck,
  MAX_INCIDENT_CHECKS,
  buildCompressedTimeline,
  toCheckPoint,
} from "../components/incident-detail/incidentDetailHelpers";

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { request } = useApi();
  const { subscribe } = useSSE();
  const fmt = useFormat();

  const [incident, setIncident] = useState<ApiIncident | null>(null);
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null);
  const [checks, setChecks] = useState<ApiCheck[]>([]);
  const [liveChecks, setLiveChecks] = useState<LiveCheck[]>([]);
  const [relatedIncidents, setRelatedIncidents] = useState<ApiIncident[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [notificationUniqueChannels, setNotificationUniqueChannels] =
    useState(0);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Live tick (1s) so the big "Down for" keeps counting up.
  const [, setRuntimeTick] = useState(0);

  const fetchIncident = useCallback(async () => {
    if (!id) return;
    const res = await request<{ data: ApiIncident }>(`/incidents/${id}`);
    if (res.status === 404 || !res.data?.data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setIncident(res.data.data);
    return res.data.data;
  }, [id, request]);

  const fetchDetails = useCallback(
    async (inc: ApiIncident) => {
      // Chart + Why-opened both want ±30m of context around the incident.
      const startMs = new Date(inc.startedAt).getTime();
      const endMs = inc.resolvedAt
        ? new Date(inc.resolvedAt).getTime()
        : Date.now();
      const from = new Date(startMs - 30 * 60_000).toISOString();
      const to = new Date(endMs + 30 * 60_000).toISOString();
      const relatedFrom = new Date(
        startMs - 30 * 24 * 3_600_000,
      ).toISOString();

      const [epRes, chkRes, relRes, notifRes] = await Promise.all([
        request<{ data: ApiEndpoint }>(`/endpoints/${inc.endpointId}`),
        request<{ data: ApiCheck[] }>(
          `/endpoints/${inc.endpointId}/checks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2000`,
        ),
        request<{ data: ApiIncident[] }>(
          `/incidents?endpointId=${inc.endpointId}&from=${encodeURIComponent(relatedFrom)}&limit=20`,
        ),
        request<{ data: ApiNotificationLogRow[] }>(
          `/notifications/log?incidentId=${encodeURIComponent(inc._id)}&limit=100`,
        ),
      ]);

      if (epRes.data?.data) setEndpoint(epRes.data.data);
      if (chkRes.data?.data) setChecks(chkRes.data.data);
      if (relRes.data?.data) {
        setRelatedIncidents(relRes.data.data.filter((r) => r._id !== inc._id));
      } else {
        setRelatedIncidents([]);
      }
      if (notifRes.data?.data) {
        setNotificationCount(notifRes.data.data.length);
        setNotificationUniqueChannels(
          new Set(notifRes.data.data.map((r) => r.channelId)).size,
        );
      }
    },
    [request],
  );

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const inc = await fetchIncident();
      if (cancelled || !inc) return;
      await fetchDetails(inc);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchIncident, fetchDetails]);

  // Live tick for active incidents
  useEffect(() => {
    if (!incident || incident.status === "resolved") return;
    const interval = setInterval(() => {
      setRuntimeTick((t) => t + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [incident]);

  // SSE: incident:resolved
  useEffect(() => {
    return subscribe("incident:resolved", (raw) => {
      const data = raw as {
        incidentId?: string;
        incident?: ApiIncident;
      };
      if (data.incidentId === id || data.incident?._id === id) {
        if (data.incident) {
          setIncident(data.incident);
        } else {
          void fetchIncident();
        }
      }
    });
  }, [subscribe, id, fetchIncident]);

  // SSE: check:complete
  useEffect(() => {
    if (!incident) return;
    return subscribe("check:complete", (raw) => {
      const data = raw as {
        timestamp: string | Date;
        endpointId: string;
        status: "healthy" | "degraded" | "down";
        responseTime: number;
        statusCode: number | null;
        errorMessage: string | null;
      };
      if (data.endpointId !== incident.endpointId) return;
      const normalized: LiveCheck = {
        timestamp:
          typeof data.timestamp === "string"
            ? data.timestamp
            : new Date(data.timestamp).toISOString(),
        endpointId: data.endpointId,
        status: data.status,
        responseTime: data.responseTime,
        statusCode: data.statusCode,
        errorMessage: data.errorMessage,
      };
      setLiveChecks((prev) => {
        const next = [...prev, normalized];
        return next.length > MAX_INCIDENT_CHECKS
          ? next.slice(next.length - MAX_INCIDENT_CHECKS)
          : next;
      });
      setEndpoint((ep) =>
        ep
          ? {
              ...ep,
              lastCheckAt: normalized.timestamp,
              lastStatus: normalized.status,
              lastResponseTime: normalized.responseTime,
              lastStatusCode: normalized.statusCode,
              lastErrorMessage: normalized.errorMessage,
            }
          : ep,
      );
    });
  }, [subscribe, incident]);

  // Merged checks (API + SSE), oldest → newest.
  const allChecks = useMemo<CheckPoint[]>(() => {
    const merged: CheckPoint[] = checks.map(toCheckPoint);
    const latestApiTs = merged.reduce((acc, c) => {
      const t = new Date(c.timestamp).getTime();
      return t > acc ? t : acc;
    }, 0);
    for (const lc of liveChecks) {
      if (new Date(lc.timestamp).getTime() > latestApiTs) {
        merged.push({
          timestamp: lc.timestamp,
          status: lc.status,
          responseTime: lc.responseTime,
          statusCode: lc.statusCode,
          errorMessage: lc.errorMessage,
        });
      }
    }
    return merged.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }, [checks, liveChecks]);

  // Chart data — checks within ±30m of the incident window.
  const chartData = useMemo<ChartPoint[]>(() => {
    if (!incident) return [];
    const startMs = new Date(incident.startedAt).getTime() - 30 * 60_000;
    const endMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime() + 30 * 60_000
      : Date.now() + 30 * 60_000;
    return allChecks
      .filter((c) => {
        const t = new Date(c.timestamp).getTime();
        return t >= startMs && t <= endMs;
      })
      .map((c) => ({
        label: formatHour(c.timestamp, fmt.prefs),
        avg: c.responseTime,
        fails: c.status === "down" ? 1 : 0,
        degraded: c.status === "degraded" ? 1 : 0,
        status: c.status,
        at: c.timestamp,
        statusCode: c.statusCode,
        errorMessage: c.errorMessage ?? null,
      }));
  }, [allChecks, incident, fmt.prefs]);

  const incidentRanges = useMemo(
    () => getIncidentRanges(chartData),
    [chartData],
  );

  // Incident-window-only checks (for why-opened + checks log).
  const windowChecks = useMemo<CheckPoint[]>(() => {
    if (!incident) return [];
    const startMs = new Date(incident.startedAt).getTime() - 10 * 60_000; // a little pre-roll
    const endMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime()
      : Number.POSITIVE_INFINITY;
    return allChecks.filter((c) => {
      const t = new Date(c.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
  }, [allChecks, incident]);

  // Checks strictly inside the incident window — counted for summary strip.
  const incidentChecks = useMemo<CheckPoint[]>(() => {
    if (!incident) return [];
    const startMs = new Date(incident.startedAt).getTime();
    const endMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime()
      : Number.POSITIVE_INFINITY;
    return allChecks.filter((c) => {
      const t = new Date(c.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
  }, [allChecks, incident]);

  // Pre-open failing checks for the timeline pre-roll — everything in
  // windowChecks that failed before the incident started. The helper caps
  // this to `failureThreshold` entries.
  const preOpenFailing = useMemo<CheckPoint[]>(() => {
    if (!incident) return [];
    const startMs = new Date(incident.startedAt).getTime();
    return windowChecks.filter(
      (c) =>
        c.status !== "healthy" &&
        new Date(c.timestamp).getTime() < startMs,
    );
  }, [windowChecks, incident]);

  const compressedTimeline = useMemo(() => {
    if (!incident) return [];
    return buildCompressedTimeline({
      timeline: incident.timeline ?? [],
      preOpenFailing,
      failureThreshold: endpoint?.failureThreshold ?? 3,
      startedAt: incident.startedAt,
    });
  }, [incident, preOpenFailing, endpoint]);

  // Trip-check timestamp — approximated as the check in windowChecks that
  // sits closest to incident.startedAt among the failing ones.
  const tripTimestamp = useMemo(() => {
    if (!incident) return undefined;
    const startMs = new Date(incident.startedAt).getTime();
    let best: CheckPoint | undefined;
    let bestDelta = Infinity;
    for (const c of windowChecks) {
      if (c.status === "healthy") continue;
      const d = Math.abs(new Date(c.timestamp).getTime() - startMs);
      if (d < bestDelta) {
        bestDelta = d;
        best = c;
      }
    }
    return best?.timestamp;
  }, [windowChecks, incident]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-32">
        <Spinner size="lg" />
      </div>
    );
  }

  if (notFound || !incident) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-32 gap-4">
        <Icon
          icon="solar:danger-triangle-linear"
          className="text-wd-muted text-5xl"
        />
        <p className="text-wd-muted text-lg">Incident not found</p>
        <Button variant="flat" onPress={() => navigate("/incidents")}>
          Back to Incidents
        </Button>
      </div>
    );
  }

  const shortId = incident._id.slice(-8);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 max-w-[1440px] mx-auto">
      <div className="flex items-center gap-1.5 text-xs text-wd-muted">
        <Link
          to="/incidents"
          className="hover:text-foreground transition-colors"
        >
          Incidents
        </Link>
        <Icon icon="solar:alt-arrow-right-linear" width={16} />
        <span className="text-foreground truncate">
          {endpoint?.name ?? "Incident"}
        </span>
        <span className="text-wd-muted/50">·</span>
        <span className="font-mono text-wd-muted/70">#{shortId}</span>
      </div>

      <IncidentDetailHeader
        incident={incident}
        endpoint={endpoint}
        onBack={() => navigate("/incidents")}
        onViewEndpoint={() => navigate(`/endpoints/${incident.endpointId}`)}
      />

      <IncidentSummaryStrip
        incident={incident}
        endpoint={endpoint}
        incidentChecks={incidentChecks}
        notificationCount={notificationCount}
        uniqueChannelCount={notificationUniqueChannels}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        <div className="flex flex-col gap-3.5 min-w-0">
          <IncidentWhyOpened
            incident={incident}
            endpoint={endpoint}
            checks={windowChecks}
          />
          {chartData.length > 0 && (
            <IncidentResponseChart
              chartData={chartData}
              incidentRanges={incidentRanges}
              timeline={incident.timeline ?? []}
              latencyThreshold={endpoint?.latencyThreshold ?? null}
            />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            <IncidentTimeline rows={compressedTimeline} />
            <IncidentNotificationsLog
              incidentId={incident._id}
              endpointId={incident.endpointId}
            />
          </div>
          <IncidentChecksLog
            checks={windowChecks}
            tripTimestamp={tripTimestamp}
          />
        </div>

        <div className="flex flex-col gap-3.5 min-w-0">
          <IncidentEndpointConfig endpoint={endpoint} />
          <RelatedIncidents
            incidents={relatedIncidents}
            endpointId={incident.endpointId}
          />
        </div>
      </div>
    </div>
  );
}
