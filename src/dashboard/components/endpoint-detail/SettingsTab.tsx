/**
 * Settings tab — sidebar nav (General / Monitoring / Assertions / Access /
 * Danger) and a form panel wired to:
 *   PUT /endpoints/:id          — name, URL, method, headers, expectedStatusCodes
 *   PUT /endpoints/:id/settings — the OVERRIDABLE_FIELDS set
 *   PATCH /endpoints/:id/toggle — pause/resume
 *   DELETE /endpoints/:id       — remove
 *
 * Assertions and Access aren't wired to the data model yet, so those live
 * inside a rainbow placeholder.
 */
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Button, Spinner, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../../hooks/useApi";
import type { ApiEndpoint } from "../../types/api";
import type { ApiChannel } from "../../types/notifications";
import { CHANNEL_TYPE_ICON } from "../../types/notifications";
import { FilterDropdown, RainbowPlaceholder, SectionHead } from "./primitives";

type Section = "general" | "monitoring" | "assertions" | "alerts" | "danger";

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: "general", label: "General", icon: "solar:tuning-square-linear" },
  { key: "monitoring", label: "Monitoring", icon: "solar:radar-linear" },
  {
    key: "assertions",
    label: "Assertions",
    icon: "solar:checklist-minimalistic-linear",
  },
  { key: "alerts", label: "Alerts", icon: "solar:bell-bing-outline" },
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

      <div className="min-w-0 min-h-[520px]">
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
        {section === "alerts" && (
          <AlertsPanel
            endpoint={endpoint}
            channels={channels}
            onEndpointUpdated={onEndpointUpdated}
          />
        )}
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
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-foreground">{label}</span>
      {children}
      {hint && (
        <span
          className={cn(
            "text-[11px] inline-flex items-center gap-1",
            error ? "text-wd-danger" : "text-wd-muted",
          )}
        >
          {error && (
            <Icon
              icon="solar:danger-triangle-outline"
              width={12}
              className="shrink-0"
            />
          )}
          {hint}
        </span>
      )}
    </label>
  );
}

const inputClass =
  "w-full h-9 rounded-lg bg-wd-surface border border-wd-border/60 px-3 text-[12.5px] text-foreground font-mono focus:outline-none focus:border-wd-primary transition-colors";

const errorInputClass =
  "!border-wd-danger/60 focus:!border-wd-danger";

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
  const [statusCodes, setStatusCodes] = useState<number[]>(
    endpoint.expectedStatusCodes ?? [200],
  );
  const [headerRows, setHeaderRows] = useState<Array<[string, string]>>(
    () => Object.entries(endpoint.headers ?? {}),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const initialStatusKey = useMemo(
    () => [...(endpoint.expectedStatusCodes ?? [200])].sort().join(","),
    [endpoint.expectedStatusCodes],
  );
  const initialHeaderKey = useMemo(
    () =>
      Object.entries(endpoint.headers ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("|"),
    [endpoint.headers],
  );

  const currentStatusKey = [...statusCodes].sort().join(",");
  const currentHeaderKey = headerRows
    .filter(([k]) => k.trim() !== "")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("|");

  const urlError = useMemo(() => {
    if (endpoint.type !== "http") return null;
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
  }, [url, endpoint.type]);

  const portError = useMemo(() => {
    if (endpoint.type !== "port") return null;
    if (port.trim() === "") return "Port is required.";
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "Port must be an integer between 1 and 65535.";
    }
    return null;
  }, [port, endpoint.type]);

  const hostError = useMemo(() => {
    if (endpoint.type !== "port") return null;
    if (host.trim() === "") return "Host is required.";
    return null;
  }, [host, endpoint.type]);

  const hasFieldError = urlError != null || portError != null || hostError != null;

  const dirty =
    name !== endpoint.name ||
    url !== (endpoint.url ?? "") ||
    host !== (endpoint.host ?? "") ||
    port !== (endpoint.port != null ? String(endpoint.port) : "") ||
    method !== (endpoint.method ?? "GET") ||
    (endpoint.type === "http" &&
      (currentStatusKey !== initialStatusKey ||
        currentHeaderKey !== initialHeaderKey));

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name };
    if (endpoint.type === "http") {
      body.url = url;
      body.method = method;
      body.expectedStatusCodes = statusCodes;
      const headerObj: Record<string, string> = {};
      for (const [k, v] of headerRows) {
        const key = k.trim();
        if (key) headerObj[key] = v;
      }
      body.headers = headerObj;
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
  }, [
    name,
    url,
    method,
    host,
    port,
    statusCodes,
    headerRows,
    endpoint,
    request,
    onEndpointUpdated,
  ]);

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
        <Field label="Type" hint="Locked · set at creation">
          <input
            value={endpoint.type === "http" ? "HTTP" : "TCP port"}
            readOnly
            className={cn(inputClass, "text-wd-muted cursor-not-allowed")}
          />
        </Field>
        {endpoint.type === "http" ? (
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
              />
            </Field>
            <Field label="Method">
              <FilterDropdown<string>
                value={method}
                options={["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map(
                  (m) => ({ id: m, label: m }),
                )}
                onChange={setMethod}
                ariaLabel="HTTP method"
                fullWidth
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Host" hint={hostError ?? undefined} error={hostError != null}>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                aria-invalid={hostError != null}
                className={cn(inputClass, hostError && errorInputClass)}
              />
            </Field>
            <Field label="Port" hint={portError ?? undefined} error={portError != null}>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                aria-invalid={portError != null}
                className={cn(inputClass, portError && errorInputClass)}
              />
            </Field>
          </>
        )}
      </div>

      {endpoint.type === "http" && (
        <div className="mt-6 flex flex-col gap-6">
          <StatusCodeChips value={statusCodes} onChange={setStatusCodes} />
          <HeaderRows value={headerRows} onChange={setHeaderRows} />
        </div>
      )}

      <div className="flex items-center gap-3 mt-6 pt-4 border-t border-wd-border/40">
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={save}
          isDisabled={!dirty || saving || hasFieldError}
        >
          {saving ? (
            <Spinner size="sm" />
          ) : (
            <Icon icon="solar:diskette-outline" width={16} />
          )}
          Save changes
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-success">
            <Icon icon="solar:check-circle-outline" width={13} />
            Saved
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {error}
          </span>
        )}
        {!error && hasFieldError && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            Fix the highlighted fields before saving.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expected status codes — chip editor colored by HTTP category.
// Chips render in monospace with a category-tinted dot + soft tint; invalid
// codes render as muted and never get committed. The inline input at the end
// accepts Enter / Tab / comma / space to commit the current draft.
// ---------------------------------------------------------------------------

type StatusCategory = "info" | "success" | "redirect" | "client" | "server";

function categorize(code: number): StatusCategory | null {
  if (code < 100 || code > 599) return null;
  if (code < 200) return "info";
  if (code < 300) return "success";
  if (code < 400) return "redirect";
  if (code < 500) return "client";
  return "server";
}

const STATUS_CATEGORY_STYLE: Record<
  StatusCategory,
  { dot: string; text: string; border: string; bg: string; label: string }
> = {
  info: {
    dot: "bg-wd-muted",
    text: "text-wd-muted",
    border: "border-wd-border/60",
    bg: "bg-wd-surface-hover/50",
    label: "1xx",
  },
  success: {
    dot: "bg-wd-success",
    text: "text-wd-success",
    border: "border-wd-success/40",
    bg: "bg-wd-success/10",
    label: "2xx",
  },
  redirect: {
    dot: "bg-wd-info",
    text: "text-wd-info",
    border: "border-wd-info/40",
    bg: "bg-wd-info/10",
    label: "3xx",
  },
  client: {
    dot: "bg-wd-warning",
    text: "text-wd-warning",
    border: "border-wd-warning/45",
    bg: "bg-wd-warning/10",
    label: "4xx",
  },
  server: {
    dot: "bg-wd-danger",
    text: "text-wd-danger",
    border: "border-wd-danger/40",
    bg: "bg-wd-danger/10",
    label: "5xx",
  },
};

const STATUS_PRESETS: Array<{ label: string; codes: number[] }> = [
  { label: "2xx only", codes: [200, 201, 202, 204] },
  { label: "2xx + 3xx", codes: [200, 201, 204, 301, 302, 304] },
  { label: "Just 200", codes: [200] },
];

function StatusCodeChips({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState(false);

  const sorted = useMemo(() => [...value].sort((a, b) => a - b), [value]);

  const commit = useCallback(
    (raw: string) => {
      const cleaned = raw.trim();
      if (!cleaned) return true;
      const n = Number(cleaned);
      if (!Number.isInteger(n) || n < 100 || n > 599) {
        setDraftError(true);
        return false;
      }
      if (!value.includes(n)) onChange([...value, n]);
      setDraftError(false);
      return true;
    },
    [value, onChange],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === " ") {
      if (draft.trim() === "") return;
      e.preventDefault();
      if (commit(draft)) setDraft("");
    } else if (e.key === "Backspace" && draft === "" && sorted.length > 0) {
      onChange(sorted.slice(0, -1));
    }
  };

  const remove = (code: number) =>
    onChange(value.filter((v) => v !== code));

  const applyPreset = (codes: number[]) => {
    setDraft("");
    setDraftError(false);
    onChange(codes);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium text-foreground">
            Expected status codes
          </span>
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-md text-[10px] font-mono font-semibold bg-wd-primary/10 text-wd-primary">
            {value.length}
          </span>
        </div>
        <span className="text-[11px] text-wd-muted">
          Any other code marks the check as down.
        </span>
      </div>

      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 min-h-[40px] p-1.5 rounded-lg bg-wd-surface border transition-colors",
          draftError
            ? "border-wd-danger/50"
            : "border-wd-border/60 focus-within:border-wd-primary/60",
        )}
      >
        {sorted.map((code) => {
          const cat = categorize(code) ?? "info";
          const style = STATUS_CATEGORY_STYLE[cat];
          return (
            <span
              key={code}
              className={cn(
                "group inline-flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-md border text-[12px] font-mono font-semibold transition-colors",
                style.border,
                style.bg,
                style.text,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
              {code}
              <button
                onClick={() => remove(code)}
                aria-label={`Remove ${code}`}
                className={cn(
                  "inline-flex items-center justify-center w-5 h-5 rounded-sm",
                  "opacity-50 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-opacity",
                )}
              >
                <Icon icon="solar:close-circle-linear" width={12} />
              </button>
            </span>
          );
        })}
        <input
          value={draft}
          onChange={(e) => {
            setDraftError(false);
            setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim() !== "" && commit(draft)) setDraft("");
          }}
          placeholder={sorted.length === 0 ? "e.g. 200" : "add…"}
          aria-label="Add status code"
          className={cn(
            "flex-1 min-w-[72px] h-7 px-1.5 bg-transparent border-0 outline-none",
            "text-[12.5px] font-mono text-foreground placeholder:text-wd-muted/80",
          )}
        />
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-[11px] text-wd-muted">
          <span className="uppercase tracking-wider text-[9.5px] font-semibold">
            Presets
          </span>
          {STATUS_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.codes)}
              className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-mono text-wd-muted bg-wd-surface-hover/40 hover:bg-wd-surface-hover hover:text-foreground border border-wd-border/40 transition-colors cursor-pointer"
            >
              {p.label}
            </button>
          ))}
        </div>
        {draftError && (
          <span className="inline-flex items-center gap-1 text-[11px] text-wd-danger font-mono">
            <Icon icon="solar:danger-triangle-outline" width={12} />
            valid range is 100–599
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom request headers — row-based editor with a terminal / HTTP-file feel.
// Each row aligns key on a monospace grid with a colon separator and value,
// so the whole block reads like a literal Headers: section from a .http file.
// ---------------------------------------------------------------------------

const COMMON_HEADERS = [
  "Authorization",
  "Accept",
  "User-Agent",
  "X-Api-Key",
  "Cache-Control",
  "Content-Type",
  "Cookie",
];

function HeaderRows({
  value,
  onChange,
}: {
  value: Array<[string, string]>;
  onChange: (next: Array<[string, string]>) => void;
}) {
  const update = (i: number, side: 0 | 1, v: string) => {
    const next = value.map((row, idx) =>
      idx === i
        ? ((side === 0 ? [v, row[1]] : [row[0], v]) as [string, string])
        : row,
    );
    onChange(next);
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, ["", ""]]);

  const keyCount = value.filter(([k]) => k.trim() !== "").length;
  const usedKeys = new Set(
    value.map(([k]) => k.trim().toLowerCase()).filter(Boolean),
  );
  const suggestions = COMMON_HEADERS.filter(
    (h) => !usedKeys.has(h.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium text-foreground">
            Custom request headers
          </span>
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-md text-[10px] font-mono font-semibold bg-wd-primary/10 text-wd-primary">
            {keyCount}
          </span>
        </div>
        <span className="text-[11px] text-wd-muted">
          Sent with every probe request.
        </span>
      </div>

      <div className="rounded-lg border border-wd-border/60 bg-wd-surface overflow-hidden">
        {value.length === 0 ? (
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div className="inline-flex items-center gap-2 text-[11.5px] text-wd-muted font-mono">
              <Icon icon="solar:code-square-outline" width={14} />
              No custom headers · probes use the default set.
            </div>
            <button
              onClick={add}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-wd-primary bg-wd-primary/10 hover:bg-wd-primary/15 transition-colors cursor-pointer"
            >
              <Icon icon="solar:add-circle-linear" width={14} />
              Add header
            </button>
          </div>
        ) : (
          <div className="divide-y divide-wd-border/40">
            {value.map(([k, v], i) => (
              <div
                key={i}
                className="group flex items-stretch gap-0 hover:bg-wd-surface-hover/40 transition-colors"
              >
                <div className="shrink-0 flex items-center justify-center w-8 text-[10px] font-mono font-semibold text-wd-muted/60 select-none border-r border-wd-border/30 bg-wd-surface-hover/30">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <input
                  value={k}
                  onChange={(e) => update(i, 0, e.target.value)}
                  placeholder="Header-Name"
                  aria-label={`Header ${i + 1} name`}
                  className={cn(
                    "flex-1 min-w-0 h-9 px-3 bg-transparent border-0 outline-none",
                    "text-[12.5px] font-mono text-foreground placeholder:text-wd-muted/70",
                    "focus:bg-wd-primary/5",
                  )}
                />
                <div className="shrink-0 flex items-center px-1 text-[12.5px] font-mono font-semibold text-wd-muted/70 select-none">
                  :
                </div>
                <input
                  value={v}
                  onChange={(e) => update(i, 1, e.target.value)}
                  placeholder="value"
                  aria-label={`Header ${i + 1} value`}
                  className={cn(
                    "flex-[1.4] min-w-0 h-9 px-3 bg-transparent border-0 outline-none",
                    "text-[12.5px] font-mono text-foreground placeholder:text-wd-muted/70",
                    "focus:bg-wd-primary/5",
                  )}
                />
                <button
                  onClick={() => remove(i)}
                  aria-label={`Remove header ${i + 1}`}
                  className="shrink-0 inline-flex items-center justify-center w-9 text-wd-muted hover:text-wd-danger hover:bg-wd-danger/5 transition-colors cursor-pointer"
                >
                  <Icon icon="solar:trash-bin-minimalistic-linear" width={14} />
                </button>
              </div>
            ))}
            <button
              onClick={add}
              className="w-full flex items-center justify-center gap-1.5 h-9 text-[11.5px] font-medium text-wd-primary hover:bg-wd-primary/5 border-t border-dashed border-wd-border/50 transition-colors cursor-pointer"
            >
              <Icon icon="solar:add-circle-linear" width={14} />
              Add header
            </button>
          </div>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="uppercase tracking-wider text-[9.5px] font-semibold text-wd-muted">
            Common
          </span>
          {suggestions.slice(0, 5).map((h) => (
            <button
              key={h}
              onClick={() => onChange([...value, [h, ""]])}
              className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-mono text-wd-muted bg-wd-surface-hover/40 hover:bg-wd-surface-hover hover:text-foreground border border-wd-border/40 transition-colors cursor-pointer"
            >
              <Icon icon="solar:add-square-linear" width={11} />
              {h}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring (overridable fields)
// ---------------------------------------------------------------------------

// Monitoring field presets — all IDs are stringified integers in the stored
// unit (seconds for intervals/delays, ms for timeouts/latency, days for SSL).
// Dropdown presets replace free-form number inputs so the user picks from
// curated, human-readable values; backend JSON schema still enforces the
// ranges in MONITORING_FIELD_RANGES (src/api/routes/endpoints.ts) so legacy
// or API-origin values remain valid even if they're off-preset.
type PresetOption = { id: string; label: string };

const CHECK_INTERVAL_PRESETS: PresetOption[] = [
  { id: "30", label: "30 seconds" },
  { id: "60", label: "1 minute" },
  { id: "120", label: "2 minutes" },
  { id: "300", label: "5 minutes" },
  { id: "600", label: "10 minutes" },
  { id: "900", label: "15 minutes" },
  { id: "1800", label: "30 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "21600", label: "6 hours" },
  { id: "43200", label: "12 hours" },
  { id: "86400", label: "24 hours" },
];

const TIMEOUT_PRESETS: PresetOption[] = [
  { id: "1000", label: "1 second" },
  { id: "3000", label: "3 seconds" },
  { id: "5000", label: "5 seconds" },
  { id: "10000", label: "10 seconds" },
  { id: "15000", label: "15 seconds" },
  { id: "30000", label: "30 seconds" },
  { id: "60000", label: "60 seconds" },
];

const LATENCY_PRESETS: PresetOption[] = [
  { id: "250", label: "250 ms" },
  { id: "500", label: "500 ms" },
  { id: "1000", label: "1 second" },
  { id: "2000", label: "2 seconds" },
  { id: "5000", label: "5 seconds" },
  { id: "10000", label: "10 seconds" },
  { id: "30000", label: "30 seconds" },
];

const SSL_WARNING_PRESETS: PresetOption[] = [
  { id: "0", label: "Off" },
  { id: "7", label: "7 days" },
  { id: "14", label: "14 days" },
  { id: "30", label: "30 days" },
  { id: "60", label: "60 days" },
  { id: "90", label: "90 days" },
];

const FAILURE_THRESHOLD_PRESETS: PresetOption[] = [
  { id: "1", label: "1 (fail-fast)" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "5", label: "5" },
  { id: "10", label: "10" },
];

const ALERT_COOLDOWN_PRESETS: PresetOption[] = [
  { id: "0", label: "None" },
  { id: "60", label: "1 minute" },
  { id: "300", label: "5 minutes" },
  { id: "900", label: "15 minutes" },
  { id: "1800", label: "30 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "7200", label: "2 hours" },
];

const ESCALATION_DELAY_PRESETS: PresetOption[] = [
  { id: "0", label: "Off" },
  { id: "300", label: "5 minutes" },
  { id: "900", label: "15 minutes" },
  { id: "1800", label: "30 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "7200", label: "2 hours" },
  { id: "21600", label: "6 hours" },
  { id: "43200", label: "12 hours" },
  { id: "86400", label: "24 hours" },
];

/**
 * If the endpoint's stored value doesn't match any preset (legacy endpoints
 * created before presets existed, or values edited via the API), prepend a
 * "{n} {unit} (custom)" entry so the dropdown can still display + preserve it.
 */
function withCustomOption(
  presets: PresetOption[],
  value: number,
  customLabel: (n: number) => string,
): PresetOption[] {
  const id = String(value);
  if (presets.some((p) => p.id === id)) return presets;
  return [{ id, label: `${customLabel(value)} (custom)` }, ...presets];
}

const fmtSeconds = (n: number): string => {
  if (n === 0) return "0 seconds";
  if (n < 60) return `${n} second${n === 1 ? "" : "s"}`;
  if (n < 3600) {
    const m = n / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = n / 3600;
  return `${h} hour${h === 1 ? "" : "s"}`;
};

const fmtMs = (n: number): string =>
  n < 1000 ? `${n} ms` : `${n / 1000} second${n === 1000 ? "" : "s"}`;

const fmtDays = (n: number): string =>
  n === 0 ? "Off" : `${n} day${n === 1 ? "" : "s"}`;

function MonitoringPanel({
  endpoint,
  onEndpointUpdated,
}: {
  endpoint: ApiEndpoint;
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      withCustomOption(FAILURE_THRESHOLD_PRESETS, failureThreshold, (n) => String(n)),
    [failureThreshold],
  );

  const dirty = useMemo(() => {
    return (
      checkInterval !== endpoint.checkInterval ||
      timeoutMs !== endpoint.timeout ||
      latencyThreshold !== endpoint.latencyThreshold ||
      sslWarningDays !== endpoint.sslWarningDays ||
      failureThreshold !== endpoint.failureThreshold
    );
  }, [
    checkInterval,
    timeoutMs,
    latencyThreshold,
    sslWarningDays,
    failureThreshold,
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
    endpoint._id,
    request,
    onEndpointUpdated,
  ]);

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
          hint="Response time above this is flagged 'degraded'"
        >
          <FilterDropdown<string>
            value={String(latencyThreshold)}
            options={latencyOptions}
            onChange={(id) => setLatencyThreshold(Number(id))}
            ariaLabel="Latency threshold"
            fullWidth
          />
        </Field>
        <Field
          label="SSL warning"
          hint="Alert before the certificate expires"
        >
          <FilterDropdown<string>
            value={String(sslWarningDays)}
            options={sslOptions}
            onChange={(id) => setSslWarningDays(Number(id))}
            ariaLabel="SSL warning"
            fullWidth
          />
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

      <div className="flex items-center gap-3 mt-5 pt-4 border-t border-wd-border/40">
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={save}
          isDisabled={!dirty || saving}
        >
          {saving ? (
            <Spinner size="sm" />
          ) : (
            <Icon icon="solar:diskette-outline" width={16} />
          )}
          Save changes
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-success">
            <Icon icon="solar:check-circle-outline" width={13} />
            Saved
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts — incident routing (cooldown, escalation, channels, recovery)
// ---------------------------------------------------------------------------

function AlertsPanel({
  endpoint,
  channels,
  onEndpointUpdated,
}: {
  endpoint: ApiEndpoint;
  channels: ApiChannel[];
  onEndpointUpdated: (e: ApiEndpoint) => void;
}) {
  const { request } = useApi();
  const [alertCooldown, setAlertCooldown] = useState(endpoint.alertCooldown);
  const [recoveryAlert, setRecoveryAlert] = useState(endpoint.recoveryAlert);
  const [escalationDelay, setEscalationDelay] = useState(endpoint.escalationDelay);
  const [escalationChannelId, setEscalationChannelId] = useState(
    endpoint.escalationChannelId ?? "",
  );
  const [notificationChannelIds, setNotificationChannelIds] = useState<string[]>(
    endpoint.notificationChannelIds ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cooldownOptions = useMemo(
    () => withCustomOption(ALERT_COOLDOWN_PRESETS, alertCooldown, fmtSeconds),
    [alertCooldown],
  );
  const escalationDelayOptions = useMemo(
    () => withCustomOption(ESCALATION_DELAY_PRESETS, escalationDelay, fmtSeconds),
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

  const dirty = useMemo(() => {
    return (
      alertCooldown !== endpoint.alertCooldown ||
      recoveryAlert !== endpoint.recoveryAlert ||
      escalationDelay !== endpoint.escalationDelay ||
      escalationChannelId !== (endpoint.escalationChannelId ?? "") ||
      notificationChannelIds.join(",") !==
        (endpoint.notificationChannelIds ?? []).join(",")
    );
  }, [
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
      alertCooldown,
      recoveryAlert,
      escalationDelay,
      escalationChannelId: escalationChannelId || null,
      notificationChannelIds,
    };
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint._id}/settings`,
      { method: "PUT", body },
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

      <div className="flex items-center gap-3 mt-5 pt-4 border-t border-wd-border/40">
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={save}
          isDisabled={!dirty || saving}
        >
          {saving ? (
            <Spinner size="sm" />
          ) : (
            <Icon icon="solar:diskette-outline" width={16} />
          )}
          Save changes
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-success">
            <Icon icon="solar:check-circle-outline" width={13} />
            Saved
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {error}
          </span>
        )}
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
            Not yet wired · body-validation config will surface here once the
            API exposes CRUD for rules.
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
