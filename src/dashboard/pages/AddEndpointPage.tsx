/**
 * Add endpoint — mirrors the endpoint-detail Settings tab layout so creating
 * and editing an endpoint look and feel identical. Left sidebar switches
 * between General / Monitoring / Assertions / Alerts panels; the active panel
 * is visible and the rest are mounted + hidden so state persists on switches.
 * Submit pushes one POST /endpoints, then routes to the new endpoint.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Spinner, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../hooks/useApi";
import { useModules } from "../hooks/useModules";
import type { ApiEndpoint } from "../types/api";
import type { ApiChannel } from "../types/notifications";
import { CHANNEL_TYPE_ICON } from "../types/notifications";
import {
  FilterDropdown,
  SectionHead,
} from "../components/endpoint-detail/primitives";
import {
  ALERT_COOLDOWN_PRESETS,
  AddAssertionMenu,
  AssertionEditorRow,
  AssertionPresetsRow,
  AssertionRulesOfUse,
  CHECK_INTERVAL_PRESETS,
  EmptyAssertionsHint,
  ESCALATION_DELAY_PRESETS,
  FAILURE_THRESHOLD_PRESETS,
  Field,
  HeaderRows,
  LATENCY_PRESETS,
  LockedStatusAssertion,
  MAX_ASSERTIONS,
  SSL_WARNING_PRESETS,
  StatusCodeChips,
  TIMEOUT_PRESETS,
  defaultAssertion,
  errorInputClass,
  fmtDays,
  fmtMs,
  fmtSeconds,
  inputClass,
  stripIds,
  withCustomOption,
  type AssertionDraft,
  type AssertionKind,
} from "../components/endpoint-detail/SettingsTab";

type Section = "general" | "monitoring" | "assertions" | "alerts";

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: "general", label: "General", icon: "solar:tuning-square-linear" },
  { key: "monitoring", label: "Monitoring", icon: "solar:radar-linear" },
  {
    key: "assertions",
    label: "Assertions",
    icon: "solar:checklist-minimalistic-linear",
  },
  { key: "alerts", label: "Alerts", icon: "solar:bell-bing-outline" },
];

// Defaults match src/config/defaults.ts — if those change, the Add page will
// fall behind but the backend still falls back to them when a field is
// omitted. We duplicate here so the user can see the defaults in the dropdowns.
const DEFAULTS = {
  checkInterval: 60,
  timeout: 10_000,
  latencyThreshold: 5_000,
  sslWarningDays: 14,
  failureThreshold: 3,
  alertCooldown: 900,
  escalationDelay: 1_800,
} as const;

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export default function AddEndpointPage() {
  const navigate = useNavigate();
  const { request } = useApi();
  const { modules } = useModules();

  const [section, setSection] = useState<Section>("general");

  // ── General ──
  const [type, setType] = useState<"http" | "port">("http");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [statusCodes, setStatusCodes] = useState<number[]>([200]);
  const [headerRows, setHeaderRows] = useState<Array<[string, string]>>([]);

  // ── Monitoring ──
  const [checkInterval, setCheckInterval] = useState<number>(DEFAULTS.checkInterval);
  const [timeoutMs, setTimeoutMs] = useState<number>(DEFAULTS.timeout);
  const [latencyThreshold, setLatencyThreshold] = useState<number>(DEFAULTS.latencyThreshold);
  const [sslWarningDays, setSslWarningDays] = useState<number>(DEFAULTS.sslWarningDays);
  const [failureThreshold, setFailureThreshold] = useState<number>(DEFAULTS.failureThreshold);

  // ── Assertions ──
  const [assertions, setAssertions] = useState<AssertionDraft[]>([]);

  // ── Alerts ──
  const [alertCooldown, setAlertCooldown] = useState<number>(DEFAULTS.alertCooldown);
  const [recoveryAlert, setRecoveryAlert] = useState(true);
  const [escalationDelay, setEscalationDelay] = useState<number>(DEFAULTS.escalationDelay);
  const [escalationChannelId, setEscalationChannelId] = useState("");
  const [notificationChannelIds, setNotificationChannelIds] = useState<string[]>([]);

  // ── Channels for Alerts ──
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const res = await request<{ data: ApiChannel[] }>("/notifications/channels");
      if (!mounted) return;
      if (res.status < 400) setChannels(res.data.data ?? []);
    })();
    return () => {
      mounted = false;
    };
  }, [request]);

  // ── Validation ──
  const nameError = name.trim() === "" ? "Name is required." : null;
  const urlError = useMemo<string | null>(() => {
    if (type !== "http") return null;
    if (url.trim() === "") return "URL is required.";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Must be a valid URL · include protocol (e.g. https://…).";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Only http:// or https:// URLs are supported.";
    }
    return null;
  }, [url, type]);
  const hostError = useMemo<string | null>(() => {
    if (type !== "port") return null;
    if (host.trim() === "") return "Host is required.";
    return null;
  }, [host, type]);
  const portError = useMemo<string | null>(() => {
    if (type !== "port") return null;
    if (port.trim() === "") return "Port is required.";
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "Port must be an integer between 1 and 65535.";
    }
    return null;
  }, [port, type]);

  const generalError = nameError || urlError || hostError || portError;
  const canSubmit = !generalError;

  // ── Submit ──
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!canSubmit) {
      // Flip to the section that has the first problem so the user sees
      // highlighted errors immediately instead of a silent disabled button.
      setSection("general");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = {
      type,
      name: name.trim(),
      ...(description.trim() && { description: description.trim() }),
      checkInterval,
      timeout: timeoutMs,
      latencyThreshold,
      sslWarningDays,
      failureThreshold,
      alertCooldown,
      recoveryAlert,
      escalationDelay,
      ...(escalationChannelId && { escalationChannelId }),
      notificationChannelIds,
      ...(assertions.length > 0 && { assertions: stripIds(assertions) }),
    };

    if (type === "http") {
      body.url = url.trim();
      body.method = method;
      body.expectedStatusCodes = statusCodes;
      const headers: Record<string, string> = {};
      for (const [k, v] of headerRows) {
        const key = k.trim();
        if (key) headers[key] = v;
      }
      body.headers = headers;
    } else {
      body.host = host.trim();
      body.port = Number(port);
    }

    const res = await request<{ data: ApiEndpoint }>("/endpoints", {
      method: "POST",
      body,
    });
    setSubmitting(false);
    if (res.status < 400 && res.data.data) {
      navigate(`/endpoints/${res.data.data._id}`);
    } else {
      const e = res.data as unknown as { message?: string };
      setSubmitError(e.message ?? "Failed to create endpoint");
    }
  }, [
    canSubmit,
    type,
    name,
    description,
    url,
    host,
    port,
    method,
    statusCodes,
    headerRows,
    checkInterval,
    timeoutMs,
    latencyThreshold,
    sslWarningDays,
    failureThreshold,
    assertions,
    alertCooldown,
    recoveryAlert,
    escalationDelay,
    escalationChannelId,
    notificationChannelIds,
    navigate,
    request,
  ]);

  const isHttps = url.startsWith("https://");
  const sslChecksDisabled = !modules.sslChecks;

  return (
    <div className="flex flex-col min-h-full">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2.5 px-6 pt-6 pb-4">
        <button
          onClick={() => navigate("/endpoints")}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-wd-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <Icon icon="solar:arrow-left-linear" width={14} />
          Endpoints
        </button>
        <Icon
          icon="solar:alt-arrow-right-linear"
          width={11}
          className="text-wd-muted/60"
        />
        <span className="text-[12.5px] font-semibold text-foreground">
          Add endpoint
        </span>
      </div>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5 px-6 pb-6">
        <nav className="rounded-xl border border-wd-border/50 bg-wd-surface p-1 self-start">
          {SECTIONS.map((s) => {
            const active = section === s.key;
            const hasError = s.key === "general" && generalError != null;
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
                <span>{s.label}</span>
                {hasError && (
                  <span
                    className="ml-auto h-1.5 w-1.5 rounded-full bg-wd-danger"
                    aria-label="Section has errors"
                    title="Section has errors"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* All panels mounted; hide inactive via display:none so switching
            sections never discards state. */}
        <div className="min-w-0 min-h-[520px]">
          <div className={cn(section !== "general" && "hidden")}>
            <GeneralSection
              type={type}
              setType={setType}
              name={name}
              setName={setName}
              description={description}
              setDescription={setDescription}
              url={url}
              setUrl={setUrl}
              host={host}
              setHost={setHost}
              port={port}
              setPort={setPort}
              method={method}
              setMethod={setMethod}
              statusCodes={statusCodes}
              setStatusCodes={setStatusCodes}
              headerRows={headerRows}
              setHeaderRows={setHeaderRows}
              nameError={nameError}
              urlError={urlError}
              hostError={hostError}
              portError={portError}
            />
          </div>
          <div className={cn(section !== "monitoring" && "hidden")}>
            <MonitoringSection
              checkInterval={checkInterval}
              setCheckInterval={setCheckInterval}
              timeoutMs={timeoutMs}
              setTimeoutMs={setTimeoutMs}
              latencyThreshold={latencyThreshold}
              setLatencyThreshold={setLatencyThreshold}
              sslWarningDays={sslWarningDays}
              setSslWarningDays={setSslWarningDays}
              failureThreshold={failureThreshold}
              setFailureThreshold={setFailureThreshold}
              hasLatencyAssertion={assertions.some((a) => a.kind === "latency")}
              hasSslAssertion={assertions.some((a) => a.kind === "ssl")}
              onJumpToSection={setSection}
            />
          </div>
          <div className={cn(section !== "assertions" && "hidden")}>
            <AssertionsSection
              assertions={assertions}
              setAssertions={setAssertions}
              statusCodes={statusCodes}
              isHttp={type === "http"}
              isHttps={isHttps}
              sslChecksDisabled={sslChecksDisabled}
              onJumpToGeneral={() => setSection("general")}
            />
          </div>
          <div className={cn(section !== "alerts" && "hidden")}>
            <AlertsSection
              channels={channels}
              alertCooldown={alertCooldown}
              setAlertCooldown={setAlertCooldown}
              recoveryAlert={recoveryAlert}
              setRecoveryAlert={setRecoveryAlert}
              escalationDelay={escalationDelay}
              setEscalationDelay={setEscalationDelay}
              escalationChannelId={escalationChannelId}
              setEscalationChannelId={setEscalationChannelId}
              notificationChannelIds={notificationChannelIds}
              setNotificationChannelIds={setNotificationChannelIds}
            />
          </div>
        </div>
      </div>

      {/* Sticky footer — keeps Create reachable regardless of which section
          the user is in, and shows the overall submit state in one place. */}
      <div className="sticky bottom-0 bg-wd-surface/95 backdrop-blur border-t border-wd-border/50 px-6 py-3 flex items-center gap-3 flex-wrap">
        {generalError && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {generalError}
          </span>
        )}
        {submitError && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {submitError}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="!rounded-lg"
            onPress={() => navigate("/endpoints")}
            isDisabled={submitting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="!rounded-lg !border-wd-primary/50 !text-wd-primary hover:!bg-wd-primary/10"
            onPress={submit}
            isDisabled={submitting || !canSubmit}
          >
            {submitting ? (
              <Spinner size="sm" />
            ) : (
              <Icon icon="solar:add-circle-outline" width={16} />
            )}
            Create endpoint
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General section — type toggle, identity, URL/host+port, method, status
// codes, custom headers. Only mandatory fields live here.
// ---------------------------------------------------------------------------

function GeneralSection({
  type,
  setType,
  name,
  setName,
  description,
  setDescription,
  url,
  setUrl,
  host,
  setHost,
  port,
  setPort,
  method,
  setMethod,
  statusCodes,
  setStatusCodes,
  headerRows,
  setHeaderRows,
  nameError,
  urlError,
  hostError,
  portError,
}: {
  type: "http" | "port";
  setType: (t: "http" | "port") => void;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  host: string;
  setHost: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  method: HttpMethod;
  setMethod: (v: HttpMethod) => void;
  statusCodes: number[];
  setStatusCodes: (v: number[]) => void;
  headerRows: Array<[string, string]>;
  setHeaderRows: (v: Array<[string, string]>) => void;
  nameError: string | null;
  urlError: string | null;
  hostError: string | null;
  portError: string | null;
}) {
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:tuning-square-linear"
        title="General"
        sub="Core endpoint identity"
      />

      <Field label="Endpoint type">
        <div className="inline-flex rounded-lg border border-wd-border/60 bg-wd-surface overflow-hidden">
          {(["http", "port"] as const).map((t) => {
            const active = type === t;
            return (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  "px-4 h-9 text-[12px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5",
                  active
                    ? "bg-wd-primary/15 text-wd-primary"
                    : "text-wd-muted hover:bg-wd-surface-hover hover:text-foreground",
                  t === "port" && "border-l border-wd-border/60",
                )}
              >
                <Icon
                  icon={
                    t === "http"
                      ? "solar:global-outline"
                      : "solar:plug-circle-outline"
                  }
                  width={14}
                />
                {t === "http" ? "HTTP" : "TCP port"}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <Field
          label="Name"
          hint={nameError ?? "A short label shown across the dashboard"}
          error={nameError != null}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError != null}
            className={cn(inputClass, nameError && errorInputClass)}
            placeholder="My API"
          />
        </Field>
        {type === "http" ? (
          <>
            <Field
              label="URL"
              hint={urlError ?? "Full URL including scheme"}
              error={urlError != null}
            >
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={urlError != null}
                className={cn(inputClass, urlError && errorInputClass)}
                placeholder="https://example.com/health"
              />
            </Field>
            <Field label="Method">
              <FilterDropdown<HttpMethod>
                value={method}
                options={(
                  ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const
                ).map((m) => ({ id: m, label: m }))}
                onChange={(m) => setMethod(m)}
                ariaLabel="HTTP method"
                fullWidth
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Host"
              hint={hostError ?? undefined}
              error={hostError != null}
            >
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                aria-invalid={hostError != null}
                className={cn(inputClass, hostError && errorInputClass)}
                placeholder="db.internal"
              />
            </Field>
            <Field
              label="Port"
              hint={portError ?? undefined}
              error={portError != null}
            >
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                aria-invalid={portError != null}
                className={cn(inputClass, portError && errorInputClass)}
                placeholder="5432"
              />
            </Field>
          </>
        )}
      </div>

      <div className="mt-4">
        <Field
          label="Description"
          hint={`${description.length}/500 · optional notes`}
          error={description.length > 500}
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="What this endpoint is, who owns it, why it exists…"
            className={cn(
              "w-full rounded-lg bg-wd-surface border border-wd-border/60 px-3 py-2",
              "text-[12.5px] text-foreground placeholder:text-wd-muted/70",
              "focus:outline-none focus:border-wd-primary transition-colors resize-y min-h-[64px]",
            )}
          />
        </Field>
      </div>

      {type === "http" && (
        <div className="mt-6 flex flex-col gap-6">
          <StatusCodeChips value={statusCodes} onChange={setStatusCodes} />
          <HeaderRows value={headerRows} onChange={setHeaderRows} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring section — cadence + thresholds. Mirrors the edit-mode panel,
// minus the save button (create flow saves everything at once at the end).
// ---------------------------------------------------------------------------

function MonitoringSection({
  checkInterval,
  setCheckInterval,
  timeoutMs,
  setTimeoutMs,
  latencyThreshold,
  setLatencyThreshold,
  sslWarningDays,
  setSslWarningDays,
  failureThreshold,
  setFailureThreshold,
  hasLatencyAssertion,
  hasSslAssertion,
  onJumpToSection,
}: {
  checkInterval: number;
  setCheckInterval: (n: number) => void;
  timeoutMs: number;
  setTimeoutMs: (n: number) => void;
  latencyThreshold: number;
  setLatencyThreshold: (n: number) => void;
  sslWarningDays: number;
  setSslWarningDays: (n: number) => void;
  failureThreshold: number;
  setFailureThreshold: (n: number) => void;
  hasLatencyAssertion: boolean;
  hasSslAssertion: boolean;
  onJumpToSection: (s: Section) => void;
}) {
  const checkIntervalOptions = useMemo(
    () => withCustomOption(CHECK_INTERVAL_PRESETS, checkInterval, fmtSeconds),
    [checkInterval],
  );
  const timeoutOptions = useMemo(
    () => withCustomOption(TIMEOUT_PRESETS, timeoutMs, fmtMs),
    [timeoutMs],
  );
  const latencyOptions = useMemo(
    () => withCustomOption(LATENCY_PRESETS, latencyThreshold, fmtMs),
    [latencyThreshold],
  );
  const sslOptions = useMemo(
    () => withCustomOption(SSL_WARNING_PRESETS, sslWarningDays, fmtDays),
    [sslWarningDays],
  );
  const failureOptions = useMemo(
    () =>
      withCustomOption(FAILURE_THRESHOLD_PRESETS, failureThreshold, (n) =>
        String(n),
      ),
    [failureThreshold],
  );

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:radar-linear"
        title="Monitoring"
        sub="Check cadence and health thresholds"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Check interval" hint="How often probes fire">
          <FilterDropdown<string>
            value={String(checkInterval)}
            options={checkIntervalOptions}
            onChange={(id) => setCheckInterval(Number(id))}
            ariaLabel="Check interval"
            fullWidth
          />
        </Field>
        <Field label="Timeout" hint="How long a probe waits for a response">
          <FilterDropdown<string>
            value={String(timeoutMs)}
            options={timeoutOptions}
            onChange={(id) => setTimeoutMs(Number(id))}
            ariaLabel="Timeout"
            fullWidth
          />
        </Field>
        <Field
          label="Latency threshold"
          hint={
            hasLatencyAssertion
              ? "Superseded by a latency assertion"
              : "Response time above this is flagged 'degraded'"
          }
        >
          {hasLatencyAssertion ? (
            <SupersededPill
              currentLabel={fmtMs(latencyThreshold)}
              onJump={() => onJumpToSection("assertions")}
            />
          ) : (
            <FilterDropdown<string>
              value={String(latencyThreshold)}
              options={latencyOptions}
              onChange={(id) => setLatencyThreshold(Number(id))}
              ariaLabel="Latency threshold"
              fullWidth
            />
          )}
        </Field>
        <Field
          label="SSL warning"
          hint={
            hasSslAssertion
              ? "Superseded by an SSL assertion"
              : "Alert before the certificate expires"
          }
        >
          {hasSslAssertion ? (
            <SupersededPill
              currentLabel={fmtDays(sslWarningDays)}
              onJump={() => onJumpToSection("assertions")}
            />
          ) : (
            <FilterDropdown<string>
              value={String(sslWarningDays)}
              options={sslOptions}
              onChange={(id) => setSslWarningDays(Number(id))}
              ariaLabel="SSL warning"
              fullWidth
            />
          )}
        </Field>
        <Field
          label="Failure threshold"
          hint="Consecutive failures before opening an incident"
        >
          <FilterDropdown<string>
            value={String(failureThreshold)}
            options={failureOptions}
            onChange={(id) => setFailureThreshold(Number(id))}
            ariaLabel="Failure threshold"
            fullWidth
          />
        </Field>
      </div>
    </div>
  );
}

function SupersededPill({
  currentLabel,
  onJump,
}: {
  currentLabel: string;
  onJump: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 h-9 px-3 rounded-lg",
        "bg-wd-surface-hover/40 border border-dashed border-wd-border/60",
      )}
    >
      <span className="inline-flex items-center gap-2 text-[11.5px] text-wd-muted min-w-0">
        <Icon
          icon="solar:lock-keyhole-minimalistic-linear"
          width={13}
          className="shrink-0"
        />
        <span className="font-mono truncate">{currentLabel}</span>
        <span className="hidden sm:inline text-[10.5px] text-wd-muted/70">
          · managed in Assertions
        </span>
      </span>
      <button
        type="button"
        onClick={onJump}
        className={cn(
          "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-medium",
          "text-wd-primary bg-wd-primary/10 hover:bg-wd-primary/15",
          "transition-colors cursor-pointer shrink-0",
        )}
      >
        Edit rule
        <Icon icon="solar:alt-arrow-right-linear" width={11} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assertions section — same editor UI as the Settings tab, minus the Save
// and Test-now buttons (both depend on a persisted endpoint ID).
// ---------------------------------------------------------------------------

function AssertionsSection({
  assertions,
  setAssertions,
  statusCodes,
  isHttp,
  isHttps,
  sslChecksDisabled,
  onJumpToGeneral,
}: {
  assertions: AssertionDraft[];
  setAssertions: React.Dispatch<React.SetStateAction<AssertionDraft[]>>;
  statusCodes: number[];
  isHttp: boolean;
  isHttps: boolean;
  sslChecksDisabled: boolean;
  onJumpToGeneral: () => void;
}) {
  const atCap = assertions.length >= MAX_ASSERTIONS;

  const updateAt = useCallback(
    (i: number, next: AssertionDraft) => {
      setAssertions((prev) => prev.map((a, idx) => (idx === i ? next : a)));
    },
    [setAssertions],
  );
  const removeAt = useCallback(
    (i: number) => {
      setAssertions((prev) => prev.filter((_, idx) => idx !== i));
    },
    [setAssertions],
  );
  const addAssertion = useCallback(
    (kind: AssertionKind) => {
      setAssertions((prev) =>
        prev.length >= MAX_ASSERTIONS ? prev : [...prev, defaultAssertion(kind)],
      );
    },
    [setAssertions],
  );

  if (!isHttp) {
    return (
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
        <SectionHead
          icon="solar:checklist-minimalistic-linear"
          title="Assertions"
          sub="Per-check rules · evaluated after the status code gate"
        />
        <div className="rounded-lg border border-dashed border-wd-border/60 bg-wd-surface-hover/30 px-4 py-6 flex items-center gap-3">
          <Icon
            icon="solar:plug-circle-outline"
            width={22}
            className="text-wd-muted shrink-0"
          />
          <div>
            <div className="text-[12.5px] font-medium text-foreground">
              Assertions are HTTP-only
            </div>
            <div className="text-[11.5px] text-wd-muted mt-0.5">
              TCP port checks have no body, headers, or status code — a
              successful connection is the only signal to assert on.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex flex-col gap-5">
      <SectionHead
        icon="solar:checklist-minimalistic-linear"
        title="Assertions"
        sub="Per-check rules · all must pass, evaluated after the status code gate"
        right={
          <span
            className={cn(
              "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-mono",
              atCap
                ? "bg-wd-warning/10 text-wd-warning border border-wd-warning/30"
                : "bg-wd-surface-hover/60 text-wd-muted border border-wd-border/50",
            )}
          >
            {assertions.length}/{MAX_ASSERTIONS}
          </span>
        }
      />

      <div className="flex flex-col gap-2">
        <LockedStatusAssertion
          codes={statusCodes}
          onJumpToGeneral={onJumpToGeneral}
        />

        {assertions.length === 0 ? (
          <EmptyAssertionsHint onAdd={addAssertion} atCap={atCap} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {assertions.map((a, i) => (
              <AssertionEditorRow
                key={a.id}
                index={i + 1}
                value={a}
                isHttps={isHttps}
                sslChecksDisabled={sslChecksDisabled}
                onChange={(next) => updateAt(i, next)}
                onRemove={() => removeAt(i)}
              />
            ))}
          </div>
        )}

        {assertions.length > 0 && (
          <AddAssertionMenu onAdd={addAssertion} atCap={atCap} />
        )}
      </div>

      <AssertionPresetsRow
        atCap={atCap}
        onApply={(draft) =>
          setAssertions((prev) =>
            prev.length >= MAX_ASSERTIONS ? prev : [...prev, draft],
          )
        }
      />

      <AssertionRulesOfUse />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts section — delivery routing and escalation policy.
// ---------------------------------------------------------------------------

function AlertsSection({
  channels,
  alertCooldown,
  setAlertCooldown,
  recoveryAlert,
  setRecoveryAlert,
  escalationDelay,
  setEscalationDelay,
  escalationChannelId,
  setEscalationChannelId,
  notificationChannelIds,
  setNotificationChannelIds,
}: {
  channels: ApiChannel[];
  alertCooldown: number;
  setAlertCooldown: (n: number) => void;
  recoveryAlert: boolean;
  setRecoveryAlert: (b: boolean) => void;
  escalationDelay: number;
  setEscalationDelay: (n: number) => void;
  escalationChannelId: string;
  setEscalationChannelId: (v: string) => void;
  notificationChannelIds: string[];
  setNotificationChannelIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const cooldownOptions = useMemo(
    () => withCustomOption(ALERT_COOLDOWN_PRESETS, alertCooldown, fmtSeconds),
    [alertCooldown],
  );
  const escalationDelayOptions = useMemo(
    () =>
      withCustomOption(ESCALATION_DELAY_PRESETS, escalationDelay, fmtSeconds),
    [escalationDelay],
  );

  const NONE_SENTINEL = "__none__";
  const escalationOptions = useMemo(
    () => [
      { id: NONE_SENTINEL, label: "— none —" },
      ...channels.map((c) => ({ id: c._id, label: `${c.name} · ${c.type}` })),
    ],
    [channels],
  );

  const toggleChannel = (id: string) => {
    setNotificationChannelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:bell-bing-outline"
        title="Alerts"
        sub="Delivery routing and escalation policy"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field
          label="Alert cooldown"
          hint="Quiet period between repeat alerts on the same incident"
        >
          <FilterDropdown<string>
            value={String(alertCooldown)}
            options={cooldownOptions}
            onChange={(id) => setAlertCooldown(Number(id))}
            ariaLabel="Alert cooldown"
            fullWidth
          />
        </Field>
        <Field
          label="Escalation delay"
          hint="How long to wait before escalation fires"
        >
          <FilterDropdown<string>
            value={String(escalationDelay)}
            options={escalationDelayOptions}
            onChange={(id) => setEscalationDelay(Number(id))}
            ariaLabel="Escalation delay"
            fullWidth
          />
        </Field>
        <Field
          label="Escalation channel"
          hint={
            channels.length === 0
              ? "No channels configured yet"
              : "Where escalated alerts are sent"
          }
        >
          <FilterDropdown<string>
            value={escalationChannelId || NONE_SENTINEL}
            options={escalationOptions}
            onChange={(id) =>
              setEscalationChannelId(id === NONE_SENTINEL ? "" : id)
            }
            ariaLabel="Escalation channel"
            fullWidth
          />
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
            No channels configured yet. Create one under Notifications, then
            return here to route alerts.
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
    </div>
  );
}
