/**
 * Settings tab — sidebar nav (General / Monitoring / Assertions / Access /
 * Danger) and a form panel wired to:
 *   PUT /endpoints/:id          — name, URL, method, expected status codes
 *   PUT /endpoints/:id/settings — the OVERRIDABLE_FIELDS set
 *   PATCH /endpoints/:id/toggle — pause/resume
 *   DELETE /endpoints/:id       — remove
 *
 * Assertions, Access, and the tags/group/owner bits are not yet stored in the
 * data model, so those sections live inside a rainbow placeholder.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { Button, Spinner, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../../hooks/useApi";
import type { ApiEndpoint } from "../../types/api";
import type { ApiChannel } from "../../types/notifications";
import { CHANNEL_TYPE_ICON } from "../../types/notifications";
import { RainbowPlaceholder, SectionHead } from "./primitives";

type Section = "general" | "monitoring" | "assertions" | "access" | "danger";

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: "general", label: "General", icon: "solar:tuning-square-linear" },
  { key: "monitoring", label: "Monitoring", icon: "solar:radar-linear" },
  {
    key: "assertions",
    label: "Assertions",
    icon: "solar:checklist-minimalistic-linear",
  },
  { key: "access", label: "Access", icon: "solar:users-group-rounded-linear" },
  { key: "danger", label: "Danger zone", icon: "solar:danger-triangle-linear" },
];

interface Props {
  endpoint: ApiEndpoint;
  channels: ApiChannel[];
  onEndpointUpdated: (next: ApiEndpoint) => void;
  onDeleted: () => void;
}

function SettingsTabBase({
  endpoint,
  channels,
  onEndpointUpdated,
  onDeleted,
}: Props) {
  const [section, setSection] = useState<Section>("general");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
      <nav className="rounded-xl border border-wd-border/50 bg-wd-surface p-1 self-start">
        {SECTIONS.map((s) => {
          const active = section === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-[12.5px] transition-colors cursor-pointer",
                active
                  ? "bg-wd-primary/10 text-wd-primary font-medium"
                  : "text-wd-muted hover:bg-wd-surface-hover hover:text-foreground",
              )}
            >
              <Icon icon={s.icon} width={15} />
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0">
        {section === "general" && (
          <GeneralPanel
            endpoint={endpoint}
            onEndpointUpdated={onEndpointUpdated}
          />
        )}
        {section === "monitoring" && (
          <MonitoringPanel
            endpoint={endpoint}
            channels={channels}
            onEndpointUpdated={onEndpointUpdated}
          />
        )}
        {section === "assertions" && <AssertionsPanel />}
        {section === "access" && <AccessPanel />}
        {section === "danger" && (
          <DangerPanel
            endpoint={endpoint}
            onEndpointUpdated={onEndpointUpdated}
            onDeleted={onDeleted}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-wd-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full h-9 rounded-lg bg-wd-surface border border-wd-border/60 px-3 text-[12.5px] text-foreground font-mono focus:outline-none focus:border-wd-primary transition-colors";

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralPanel({
  endpoint,
  onEndpointUpdated,
}: {
  endpoint: ApiEndpoint;
  onEndpointUpdated: (e: ApiEndpoint) => void;
}) {
  const { request } = useApi();
  const [name, setName] = useState(endpoint.name);
  const [url, setUrl] = useState(endpoint.url ?? "");
  const [host, setHost] = useState(endpoint.host ?? "");
  const [port, setPort] = useState(
    endpoint.port != null ? String(endpoint.port) : "",
  );
  const [method, setMethod] = useState(endpoint.method ?? "GET");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    name !== endpoint.name ||
    url !== (endpoint.url ?? "") ||
    host !== (endpoint.host ?? "") ||
    port !== (endpoint.port != null ? String(endpoint.port) : "") ||
    method !== (endpoint.method ?? "GET");

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name };
    if (endpoint.type === "http") {
      body.url = url;
      body.method = method;
    } else {
      body.host = host;
      body.port = Number(port);
    }
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint._id}`,
      {
        method: "PUT",
        body,
      },
    );
    setSaving(false);
    if (res.status < 400 && res.data.data) {
      onEndpointUpdated(res.data.data);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } else {
      const e = res.data as unknown as { message?: string };
      setError(e.message ?? "Failed to save");
    }
  }, [name, url, method, host, port, endpoint, request, onEndpointUpdated]);

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:tuning-square-linear"
        title="General"
        sub="Core endpoint identity"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Type" hint="Locked — set at creation">
          <input
            value={endpoint.type === "http" ? "HTTP" : "TCP port"}
            readOnly
            className={cn(inputClass, "text-wd-muted cursor-not-allowed")}
          />
        </Field>
        {endpoint.type === "http" ? (
          <>
            <Field label="URL" hint="Full URL including scheme">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Method">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={inputClass}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Host">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Port">
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                className={inputClass}
              />
            </Field>
          </>
        )}
      </div>

      <div className="mt-5">
        <RainbowPlaceholder className="min-h-[100px]">
          <div className="text-[11.5px] text-white/95 drop-shadow">
            <div className="text-[10px] uppercase tracking-wider mb-1">
              Group, tags, owner
            </div>
            <div>Not yet wired to the data model.</div>
          </div>
        </RainbowPlaceholder>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <Button
          color="primary"
          size="sm"
          onPress={save}
          isDisabled={!dirty || saving}
        >
          {saving ? <Spinner size="sm" className="mr-1.5" /> : null}
          Save
        </Button>
        {saved && <span className="text-[11.5px] text-wd-success">Saved</span>}
        {error && <span className="text-[11.5px] text-wd-danger">{error}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring (overridable fields)
// ---------------------------------------------------------------------------

function MonitoringPanel({
  endpoint,
  channels,
  onEndpointUpdated,
}: {
  endpoint: ApiEndpoint;
  channels: ApiChannel[];
  onEndpointUpdated: (e: ApiEndpoint) => void;
}) {
  const { request } = useApi();
  const [checkInterval, setCheckInterval] = useState(endpoint.checkInterval);
  const [timeoutMs, setTimeoutMs] = useState(endpoint.timeout);
  const [latencyThreshold, setLatencyThreshold] = useState(
    endpoint.latencyThreshold,
  );
  const [sslWarningDays, setSslWarningDays] = useState(endpoint.sslWarningDays);
  const [failureThreshold, setFailureThreshold] = useState(
    endpoint.failureThreshold,
  );
  const [alertCooldown, setAlertCooldown] = useState(endpoint.alertCooldown);
  const [recoveryAlert, setRecoveryAlert] = useState(endpoint.recoveryAlert);
  const [escalationDelay, setEscalationDelay] = useState(
    endpoint.escalationDelay,
  );
  const [escalationChannelId, setEscalationChannelId] = useState(
    endpoint.escalationChannelId ?? "",
  );
  const [notificationChannelIds, setNotificationChannelIds] = useState<
    string[]
  >(endpoint.notificationChannelIds ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    return (
      checkInterval !== endpoint.checkInterval ||
      timeoutMs !== endpoint.timeout ||
      latencyThreshold !== endpoint.latencyThreshold ||
      sslWarningDays !== endpoint.sslWarningDays ||
      failureThreshold !== endpoint.failureThreshold ||
      alertCooldown !== endpoint.alertCooldown ||
      recoveryAlert !== endpoint.recoveryAlert ||
      escalationDelay !== endpoint.escalationDelay ||
      escalationChannelId !== (endpoint.escalationChannelId ?? "") ||
      notificationChannelIds.join(",") !==
        (endpoint.notificationChannelIds ?? []).join(",")
    );
  }, [
    checkInterval,
    timeoutMs,
    latencyThreshold,
    sslWarningDays,
    failureThreshold,
    alertCooldown,
    recoveryAlert,
    escalationDelay,
    escalationChannelId,
    notificationChannelIds,
    endpoint,
  ]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const body = {
      checkInterval,
      timeout: timeoutMs,
      latencyThreshold,
      sslWarningDays,
      failureThreshold,
      alertCooldown,
      recoveryAlert,
      escalationDelay,
      escalationChannelId: escalationChannelId || null,
      notificationChannelIds,
    };
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint._id}/settings`,
      {
        method: "PUT",
        body,
      },
    );
    setSaving(false);
    if (res.status < 400 && res.data.data) {
      onEndpointUpdated(res.data.data);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } else {
      const e = res.data as unknown as { message?: string };
      setError(e.message ?? "Failed to save");
    }
  }, [
    checkInterval,
    timeoutMs,
    latencyThreshold,
    sslWarningDays,
    failureThreshold,
    alertCooldown,
    recoveryAlert,
    escalationDelay,
    escalationChannelId,
    notificationChannelIds,
    endpoint._id,
    request,
    onEndpointUpdated,
  ]);

  const toggleChannel = (id: string) => {
    setNotificationChannelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:radar-linear"
        title="Monitoring"
        sub="Check cadence, thresholds, alert routing"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Check interval" hint="seconds between probes">
          <input
            type="number"
            min={10}
            value={checkInterval}
            onChange={(e) => setCheckInterval(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Timeout" hint="seconds before a probe fails">
          <input
            type="number"
            min={1}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Latency threshold" hint="ms — above this is 'degraded'">
          <input
            type="number"
            min={0}
            value={latencyThreshold}
            onChange={(e) => setLatencyThreshold(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="SSL warning" hint="days before expiry to alert">
          <input
            type="number"
            min={0}
            value={sslWarningDays}
            onChange={(e) => setSslWarningDays(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field
          label="Failure threshold"
          hint="consecutive failures before opening an incident"
        >
          <input
            type="number"
            min={1}
            value={failureThreshold}
            onChange={(e) => setFailureThreshold(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Alert cooldown" hint="seconds between repeat alerts">
          <input
            type="number"
            min={0}
            value={alertCooldown}
            onChange={(e) => setAlertCooldown(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field
          label="Escalation delay"
          hint="seconds before escalation fires (0 = off)"
        >
          <input
            type="number"
            min={0}
            value={escalationDelay}
            onChange={(e) => setEscalationDelay(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Escalation channel">
          <select
            value={escalationChannelId}
            onChange={(e) => setEscalationChannelId(e.target.value)}
            className={inputClass}
          >
            <option value="">— none —</option>
            {channels.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name} · {c.type}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <label className="flex items-center gap-2 mt-4 text-[12.5px]">
        <input
          type="checkbox"
          checked={recoveryAlert}
          onChange={(e) => setRecoveryAlert(e.target.checked)}
          className="accent-wd-primary"
        />
        Send a recovery alert when the endpoint returns to healthy
      </label>

      <div className="mt-5">
        <div className="text-[11.5px] font-medium text-foreground mb-2">
          Notification channels
        </div>
        {channels.length === 0 ? (
          <div className="text-[12px] text-wd-muted">
            No channels configured yet.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => {
              const on = notificationChannelIds.includes(c._id);
              return (
                <button
                  key={c._id}
                  onClick={() => toggleChannel(c._id)}
                  className={cn(
                    "inline-flex items-center gap-2 px-3 h-8 rounded-lg border text-[12px] transition-colors cursor-pointer",
                    on
                      ? "border-wd-primary/50 bg-wd-primary/10 text-wd-primary"
                      : "border-wd-border/50 bg-wd-surface-hover/40 text-wd-muted hover:text-foreground",
                  )}
                >
                  <Icon icon={CHANNEL_TYPE_ICON[c.type]} width={14} />
                  {c.name}
                  {on && <Icon icon="solar:check-read-linear" width={13} />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-5">
        <Button
          color="primary"
          size="sm"
          onPress={save}
          isDisabled={!dirty || saving}
        >
          {saving ? <Spinner size="sm" className="mr-1.5" /> : null}
          Save
        </Button>
        {saved && <span className="text-[11.5px] text-wd-success">Saved</span>}
        {error && <span className="text-[11.5px] text-wd-danger">{error}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assertions — not yet stored in data model
// ---------------------------------------------------------------------------

function AssertionsPanel() {
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:checklist-minimalistic-linear"
        title="Assertions"
        sub="Body validation rules"
      />
      <RainbowPlaceholder className="min-h-[200px]">
        <div className="text-[12px] text-white drop-shadow">
          <div className="font-semibold mb-1">Assertions editor</div>
          <div className="text-white/90">
            Not yet wired — body-validation config will surface here once the
            API exposes CRUD for rules.
          </div>
        </div>
      </RainbowPlaceholder>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access — no permissions model yet
// ---------------------------------------------------------------------------

function AccessPanel() {
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:users-group-rounded-linear"
        title="Access"
        sub="Who can see and edit"
      />
      <RainbowPlaceholder className="min-h-[200px]">
        <div className="text-[12px] text-white drop-shadow">
          <div className="font-semibold mb-1">Access controls</div>
          <div className="text-white/90">
            No permissions model yet — WatchDeck v1 assumes a single operator.
          </div>
        </div>
      </RainbowPlaceholder>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger
// ---------------------------------------------------------------------------

function DangerPanel({
  endpoint,
  onEndpointUpdated,
  onDeleted,
}: {
  endpoint: ApiEndpoint;
  onEndpointUpdated: (e: ApiEndpoint) => void;
  onDeleted: () => void;
}) {
  const { request } = useApi();
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");

  const togglePause = useCallback(async () => {
    setPausing(true);
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint._id}/toggle`,
      {
        method: "PATCH",
      },
    );
    if (res.status < 400 && res.data.data) onEndpointUpdated(res.data.data);
    setPausing(false);
  }, [endpoint._id, request, onEndpointUpdated]);

  const destroy = useCallback(async () => {
    if (confirm !== endpoint.name) return;
    setDeleting(true);
    const res = await request(`/endpoints/${endpoint._id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (res.status < 400) onDeleted();
  }, [confirm, endpoint._id, endpoint.name, request, onDeleted]);

  return (
    <div className="rounded-xl border border-wd-danger/40 bg-wd-danger/5 p-5">
      <SectionHead
        icon="solar:danger-triangle-linear"
        title="Danger zone"
        sub="Irreversible or high-impact actions"
      />

      <div className="flex items-start justify-between gap-4 py-3 border-b border-wd-border/40">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-foreground">
            {endpoint.status === "paused"
              ? "Resume monitoring"
              : "Pause monitoring"}
          </div>
          <div className="text-[11.5px] text-wd-muted">
            {endpoint.status === "paused"
              ? "Re-enable the scheduler for this endpoint."
              : "Stops scheduled checks. No alerts will fire while paused."}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onPress={togglePause}
          isDisabled={pausing}
        >
          {pausing ? <Spinner size="sm" className="mr-1.5" /> : null}
          {endpoint.status === "paused" ? "Resume" : "Pause"}
        </Button>
      </div>

      <div className="flex flex-col gap-3 pt-4">
        <div>
          <div className="text-[12.5px] font-medium text-wd-danger">
            Delete endpoint
          </div>
          <div className="text-[11.5px] text-wd-muted">
            Removes the endpoint, its schedule, and stops future checks.
            Historical data is retained until pruned by aggregation.
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            placeholder={`Type "${endpoint.name}" to confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={cn(inputClass, "max-w-sm")}
          />
          <Button
            color="danger"
            size="sm"
            onPress={destroy}
            isDisabled={confirm !== endpoint.name || deleting}
          >
            {deleting ? <Spinner size="sm" className="mr-1.5" /> : null}
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

export default memo(SettingsTabBase);
