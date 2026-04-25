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
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Spinner, cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../../hooks/useApi";
import { useModules } from "../../hooks/useModules";
import type {
  ApiEndpoint,
  AssertionEvalResult,
  AssertionResult,
} from "../../types/api";
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
  /**
   * Fires whenever the aggregate dirty state changes across all Settings
   * panels. EndpointDetailPage uses this to intercept tab switches with a
   * "discard unsaved changes?" confirm.
   */
  onDirtyChange?: (anyDirty: boolean) => void;
}

type DirtyMap = Record<Exclude<Section, "danger">, boolean>;

const VALID_SECTIONS: Section[] = [
  "general",
  "monitoring",
  "assertions",
  "alerts",
  "danger",
];

function SettingsTabBase({
  endpoint,
  channels,
  onEndpointUpdated,
  onDeleted,
  onDirtyChange,
}: Props) {
  // Deep-linkable section — `?section=danger` (e.g. from the Endpoints list
  // Delete action) takes the user straight to Danger zone instead of General.
  // Read once on mount; sidebar clicks keep the state internal so we don't
  // thrash the URL on every switch.
  const [searchParams] = useSearchParams();
  const [section, setSection] = useState<Section>(() => {
    const s = searchParams.get("section");
    return s && (VALID_SECTIONS as string[]).includes(s) ? (s as Section) : "general";
  });

  // Per-section dirty tracking — each save-capable panel calls its
  // onDirtyChange callback via useEffect, and we roll those up into an
  // `anyDirty` signal that the parent page uses to gate tab switches.
  const [dirty, setDirty] = useState<DirtyMap>({
    general: false,
    monitoring: false,
    assertions: false,
    alerts: false,
  });
  const setPanelDirty = useCallback(
    (key: keyof DirtyMap) => (d: boolean) => {
      setDirty((prev) => (prev[key] === d ? prev : { ...prev, [key]: d }));
    },
    [],
  );
  const anyDirty = dirty.general || dirty.monitoring || dirty.assertions || dirty.alerts;
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);
  // Clear the parent's "settings are dirty" flag when this tab unmounts, so
  // navigating away (after confirming discard) doesn't leave a stale flag
  // that the beforeunload handler would still see as "in progress".
  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
      <nav className="rounded-xl border border-wd-border/50 bg-wd-surface p-1 self-start">
        {SECTIONS.map((s) => {
          const active = section === s.key;
          const isDirty =
            s.key !== "danger" && dirty[s.key as keyof DirtyMap];
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
              {isDirty && (
                <span
                  className="ml-auto h-1.5 w-1.5 rounded-full bg-wd-warning"
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/*
        All panels stay mounted. Hiding the inactive ones with display:none
        keeps form state + dirty tracking intact on section switches, so users
        can flip between General / Monitoring / etc. without losing edits.
      */}
      <div className="min-w-0 min-h-[520px]">
        <div className={cn(section !== "general" && "hidden")}>
          <GeneralPanel
            endpoint={endpoint}
            onEndpointUpdated={onEndpointUpdated}
            onDirtyChange={setPanelDirty("general")}
          />
        </div>
        <div className={cn(section !== "monitoring" && "hidden")}>
          <MonitoringPanel
            endpoint={endpoint}
            onEndpointUpdated={onEndpointUpdated}
            onJumpToSection={setSection}
            onDirtyChange={setPanelDirty("monitoring")}
          />
        </div>
        <div className={cn(section !== "assertions" && "hidden")}>
          <AssertionsPanel
            endpoint={endpoint}
            onJumpToSection={setSection}
            onEndpointUpdated={onEndpointUpdated}
            onDirtyChange={setPanelDirty("assertions")}
          />
        </div>
        <div className={cn(section !== "alerts" && "hidden")}>
          <AlertsPanel
            endpoint={endpoint}
            channels={channels}
            onEndpointUpdated={onEndpointUpdated}
            onDirtyChange={setPanelDirty("alerts")}
          />
        </div>
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

export function Field({
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

export const inputClass =
  "w-full h-9 rounded-lg bg-wd-surface border border-wd-border/60 px-3 text-[12.5px] text-foreground font-mono focus:outline-none focus:border-wd-primary transition-colors";

export const errorInputClass =
  "!border-wd-danger/60 focus:!border-wd-danger";

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralPanel({
  endpoint,
  onEndpointUpdated,
  onDirtyChange,
}: {
  endpoint: ApiEndpoint;
  onEndpointUpdated: (e: ApiEndpoint) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { request } = useApi();
  const navigate = useNavigate();
  const [name, setName] = useState(endpoint.name);
  const [description, setDescription] = useState(endpoint.description ?? "");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
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
    description !== (endpoint.description ?? "") ||
    url !== (endpoint.url ?? "") ||
    host !== (endpoint.host ?? "") ||
    port !== (endpoint.port != null ? String(endpoint.port) : "") ||
    method !== (endpoint.method ?? "GET") ||
    (endpoint.type === "http" &&
      (currentStatusKey !== initialStatusKey ||
        currentHeaderKey !== initialHeaderKey));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name, description };
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
      `/endpoints/${endpoint.id}`,
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
    description,
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

  const clone = useCallback(async () => {
    setCloning(true);
    setCloneError(null);
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint.id}/clone`,
      { method: "POST" },
    );
    setCloning(false);
    if (res.status < 400 && res.data.data) {
      navigate(`/endpoints/${res.data.data.id}`);
    } else {
      const e = res.data as unknown as { message?: string };
      setCloneError(e.message ?? "Failed to clone endpoint");
    }
  }, [endpoint.id, request, navigate]);

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

      <div className="mt-4">
        <Field
          label="Description"
          hint={`${description.length}/500 · optional notes, shown only in Settings`}
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

      {endpoint.type === "http" && (
        <div className="mt-6 flex flex-col gap-6">
          <StatusCodeChips value={statusCodes} onChange={setStatusCodes} />
          <HeaderRows value={headerRows} onChange={setHeaderRows} />
        </div>
      )}

      <div className="flex items-center gap-3 mt-6 pt-4 border-t border-wd-border/40 flex-wrap">
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
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={clone}
          isDisabled={cloning}
        >
          {cloning ? (
            <Spinner size="sm" />
          ) : (
            <Icon icon="solar:copy-outline" width={16} />
          )}
          Clone endpoint
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
        {cloneError && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {cloneError}
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

export function StatusCodeChips({
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

export function HeaderRows({
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

export const CHECK_INTERVAL_PRESETS: PresetOption[] = [
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

export const TIMEOUT_PRESETS: PresetOption[] = [
  { id: "1000", label: "1 second" },
  { id: "3000", label: "3 seconds" },
  { id: "5000", label: "5 seconds" },
  { id: "10000", label: "10 seconds" },
  { id: "15000", label: "15 seconds" },
  { id: "30000", label: "30 seconds" },
  { id: "60000", label: "60 seconds" },
];

export const LATENCY_PRESETS: PresetOption[] = [
  { id: "250", label: "250 ms" },
  { id: "500", label: "500 ms" },
  { id: "1000", label: "1 second" },
  { id: "2000", label: "2 seconds" },
  { id: "5000", label: "5 seconds" },
  { id: "10000", label: "10 seconds" },
  { id: "30000", label: "30 seconds" },
];

export const SSL_WARNING_PRESETS: PresetOption[] = [
  { id: "0", label: "Off" },
  { id: "7", label: "7 days" },
  { id: "14", label: "14 days" },
  { id: "30", label: "30 days" },
  { id: "60", label: "60 days" },
  { id: "90", label: "90 days" },
];

export const FAILURE_THRESHOLD_PRESETS: PresetOption[] = [
  { id: "1", label: "1 (fail-fast)" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "5", label: "5" },
  { id: "10", label: "10" },
];

export const RECOVERY_THRESHOLD_PRESETS: PresetOption[] = [
  { id: "1", label: "1 (resolve on first healthy)" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "5", label: "5" },
  { id: "10", label: "10" },
];

export const ALERT_COOLDOWN_PRESETS: PresetOption[] = [
  { id: "0", label: "None" },
  { id: "60", label: "1 minute" },
  { id: "300", label: "5 minutes" },
  { id: "900", label: "15 minutes" },
  { id: "1800", label: "30 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "7200", label: "2 hours" },
];

export const ESCALATION_DELAY_PRESETS: PresetOption[] = [
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
export function withCustomOption(
  presets: PresetOption[],
  value: number,
  customLabel: (n: number) => string,
): PresetOption[] {
  const id = String(value);
  if (presets.some((p) => p.id === id)) return presets;
  return [{ id, label: `${customLabel(value)} (custom)` }, ...presets];
}

export const fmtSeconds = (n: number): string => {
  if (n === 0) return "0 seconds";
  if (n < 60) return `${n} second${n === 1 ? "" : "s"}`;
  if (n < 3600) {
    const m = n / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = n / 3600;
  return `${h} hour${h === 1 ? "" : "s"}`;
};

export const fmtMs = (n: number): string =>
  n < 1000 ? `${n} ms` : `${n / 1000} second${n === 1000 ? "" : "s"}`;

export const fmtDays = (n: number): string =>
  n === 0 ? "Off" : `${n} day${n === 1 ? "" : "s"}`;

// Stand-in for a Monitoring field that's been superseded by an assertion of
// the matching kind. Shows the stored value as read-only context and offers a
// one-click jump to the Assertions tab where the rule actually lives.
function SupersededByAssertion({
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

function MonitoringPanel({
  endpoint,
  onEndpointUpdated,
  onJumpToSection,
  onDirtyChange,
}: {
  endpoint: ApiEndpoint;
  onEndpointUpdated: (e: ApiEndpoint) => void;
  onJumpToSection: (s: Section) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { request } = useApi();
  const hasLatencyAssertion = (endpoint.assertions ?? []).some(
    (a) => a.kind === "latency",
  );
  const hasSslAssertion = (endpoint.assertions ?? []).some(
    (a) => a.kind === "ssl",
  );
  const [checkInterval, setCheckInterval] = useState(endpoint.checkInterval);
  const [timeoutMs, setTimeoutMs] = useState(endpoint.timeout);
  const [latencyThreshold, setLatencyThreshold] = useState(
    endpoint.latencyThreshold,
  );
  const [sslWarningDays, setSslWarningDays] = useState(endpoint.sslWarningDays);
  const [failureThreshold, setFailureThreshold] = useState(
    endpoint.failureThreshold,
  );
  const [recoveryThreshold, setRecoveryThreshold] = useState(
    endpoint.recoveryThreshold,
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
  const recoveryOptions = useMemo(
    () =>
      withCustomOption(RECOVERY_THRESHOLD_PRESETS, recoveryThreshold, (n) => String(n)),
    [recoveryThreshold],
  );

  const dirty = useMemo(() => {
    return (
      checkInterval !== endpoint.checkInterval ||
      timeoutMs !== endpoint.timeout ||
      latencyThreshold !== endpoint.latencyThreshold ||
      sslWarningDays !== endpoint.sslWarningDays ||
      failureThreshold !== endpoint.failureThreshold ||
      recoveryThreshold !== endpoint.recoveryThreshold
    );
  }, [
    checkInterval,
    timeoutMs,
    latencyThreshold,
    sslWarningDays,
    failureThreshold,
    recoveryThreshold,
    endpoint,
  ]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const body = {
      checkInterval,
      timeout: timeoutMs,
      latencyThreshold,
      sslWarningDays,
      failureThreshold,
      recoveryThreshold,
    };
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint.id}/settings`,
      {
        method: "PUT",
        body,
      },
    );
    setSaving(false);
    if (res.status < 400 && res.data.data) {
      const saved = res.data.data;
      // Detect the "silent field drop" case: save succeeds (200) but the
      // server returns an endpoint without the field we sent. This
      // historically hid bugs where the API's OVERRIDABLE_FIELDS list drifted
      // behind a new schema field. We call out the specific fields so the
      // user can see which key got dropped.
      const dropped: string[] = [];
      if (saved.checkInterval !== checkInterval) dropped.push("checkInterval");
      if (saved.timeout !== timeoutMs) dropped.push("timeout");
      if (saved.latencyThreshold !== latencyThreshold)
        dropped.push("latencyThreshold");
      if (saved.sslWarningDays !== sslWarningDays)
        dropped.push("sslWarningDays");
      if (saved.failureThreshold !== failureThreshold)
        dropped.push("failureThreshold");
      if (saved.recoveryThreshold !== recoveryThreshold)
        dropped.push("recoveryThreshold");
      // Re-sync local state to the server's view regardless — so the
      // dropdown can't show a value that isn't actually persisted.
      setCheckInterval(saved.checkInterval);
      setTimeoutMs(saved.timeout);
      setLatencyThreshold(saved.latencyThreshold);
      setSslWarningDays(saved.sslWarningDays);
      setFailureThreshold(saved.failureThreshold);
      setRecoveryThreshold(saved.recoveryThreshold);
      onEndpointUpdated(saved);
      if (dropped.length > 0) {
        setError(
          `Server accepted the request but did not persist: ${dropped.join(", ")}. Restart the backend so the latest schema takes effect.`,
        );
      } else {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1500);
      }
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
    recoveryThreshold,
    endpoint.id,
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
          hint={
            hasLatencyAssertion
              ? "Superseded by a latency assertion"
              : "Response time above this is flagged 'degraded'"
          }
        >
          {hasLatencyAssertion ? (
            <SupersededByAssertion
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
            <SupersededByAssertion
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
        <Field
          label="Recovery threshold"
          hint="Consecutive healthy checks required to auto-resolve"
        >
          <FilterDropdown<string>
            value={String(recoveryThreshold)}
            options={recoveryOptions}
            onChange={(id) => setRecoveryThreshold(Number(id))}
            ariaLabel="Recovery threshold"
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
  onDirtyChange,
}: {
  endpoint: ApiEndpoint;
  channels: ApiChannel[];
  onEndpointUpdated: (e: ApiEndpoint) => void;
  onDirtyChange?: (dirty: boolean) => void;
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
      ...channels.map((c) => ({ id: c.id, label: `${c.name} · ${c.type}` })),
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

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

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
      `/endpoints/${endpoint.id}/settings`,
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
    endpoint.id,
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
              const on = notificationChannelIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleChannel(c.id)}
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
// Assertions — per-endpoint rule editor (HTTP only)
//
// First row is a locked mirror of the General-tab expectedStatusCodes — it is
// the foundational "is this response successful?" gate and cannot be edited
// here (a small link jumps back to General). Everything below is a
// user-defined rule on three axes:
//   kind (latency / body / header / json / ssl) → operator → value
// Operators are scoped to the kind (e.g. `status > ok` is disallowed). The
// value input shape follows from the selected operator.
//
// UI draft: save is disabled until the backend evaluator + body-text capture
// land. A JSON preview at the bottom surfaces the payload shape so we can
// settle storage before wiring.
// ---------------------------------------------------------------------------

export type AssertionKind = "latency" | "body" | "header" | "json" | "ssl";

export type AssertionOperator =
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "equals"
  | "exists"
  | "not_exists";

export const MAX_ASSERTIONS = 10;

export type AssertionSeverity = "down" | "degraded";

export interface AssertionDraft {
  id: string;
  kind: AssertionKind;
  operator: AssertionOperator;
  /** Header name or JSON path — only meaningful for `header` / `json`. */
  target?: string;
  /** Comparison value — omitted for `exists` / `not_exists`. */
  value?: string;
  /**
   * How a failure of this rule affects the composite check status.
   * Defaults by kind: latency/ssl → "degraded"; body/header/json → "down".
   */
  severity: AssertionSeverity;
}

export function defaultSeverity(kind: AssertionKind): AssertionSeverity {
  return kind === "latency" || kind === "ssl" ? "degraded" : "down";
}

const KIND_META: Record<
  AssertionKind,
  { label: string; icon: string; accent: string; tint: string; border: string }
> = {
  latency: {
    label: "Latency",
    icon: "solar:stopwatch-outline",
    accent: "text-wd-info",
    tint: "bg-wd-info/5",
    border: "border-wd-info/25",
  },
  body: {
    label: "Body",
    icon: "solar:document-text-outline",
    accent: "text-wd-primary",
    tint: "bg-wd-primary/5",
    border: "border-wd-primary/25",
  },
  header: {
    label: "Header",
    icon: "solar:code-square-outline",
    accent: "text-wd-warning",
    tint: "bg-wd-warning/5",
    border: "border-wd-warning/25",
  },
  json: {
    label: "JSON path",
    icon: "solar:code-scan-outline",
    accent: "text-wd-success",
    tint: "bg-wd-success/5",
    border: "border-wd-success/25",
  },
  ssl: {
    label: "SSL days",
    icon: "solar:shield-keyhole-outline",
    accent: "text-foreground",
    tint: "bg-wd-surface-hover/40",
    border: "border-wd-border/50",
  },
};

const OPERATOR_LABEL: Record<AssertionOperator, string> = {
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  eq: "==",
  neq: "≠",
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  exists: "exists",
  not_exists: "does not exist",
};

function operatorsFor(kind: AssertionKind): AssertionOperator[] {
  switch (kind) {
    case "latency":
      return ["lt", "lte", "gt", "gte", "eq"];
    case "body":
      return ["contains", "not_contains", "equals"];
    case "header":
      return ["exists", "not_exists", "equals", "contains"];
    case "json":
      return [
        "exists",
        "not_exists",
        "eq",
        "neq",
        "lt",
        "lte",
        "gt",
        "gte",
        "contains",
      ];
    case "ssl":
      return ["lt", "lte", "gt", "gte", "eq"];
  }
}

export function defaultAssertion(kind: AssertionKind): AssertionDraft {
  const op = operatorsFor(kind)[0];
  const id = newDraftId();
  const severity = defaultSeverity(kind);
  switch (kind) {
    case "latency":
      return { id, kind, operator: op, value: "800", severity };
    case "body":
      return { id, kind, operator: op, value: '"status":"ok"', severity };
    case "header":
      return { id, kind, operator: op, target: "content-type", value: "", severity };
    case "json":
      return { id, kind, operator: op, target: "$.status", value: "", severity };
    case "ssl":
      return { id, kind, operator: op, value: "30", severity };
  }
}

function needsTarget(kind: AssertionKind): boolean {
  return kind === "header" || kind === "json";
}

function newDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Math.random()).slice(2);
}

// Takes the server-persisted assertion array and attaches stable UI ids used
// for React keys + dirty diffing. Safe to call with undefined.
export function hydrateDrafts(input: ApiEndpoint["assertions"]): AssertionDraft[] {
  if (!input) return [];
  return input.map((a) => ({
    id: newDraftId(),
    kind: a.kind,
    operator: a.operator,
    severity: a.severity,
    target: a.target,
    value: a.value,
  }));
}

// Inverse of hydrate — strip the UI-only id field and emit keys in a canonical
// order so JSON.stringify output is stable across origins. Without this, a
// draft built by `defaultAssertion` and an otherwise-identical draft rebuilt
// via `hydrateDrafts` after save serialise to different strings (same data,
// different key order) and the dirty-diff never clears.
export function stripIds(
  drafts: AssertionDraft[],
): Array<Omit<AssertionDraft, "id">> {
  return drafts.map((d) => ({
    kind: d.kind,
    operator: d.operator,
    target: d.target,
    value: d.value,
    severity: d.severity,
  }));
}

function needsValue(op: AssertionOperator): boolean {
  return op !== "exists" && op !== "not_exists";
}

function targetPlaceholder(kind: AssertionKind): string {
  if (kind === "header") return "content-type";
  if (kind === "json") return "$.data.status";
  return "";
}

function valueSuffix(kind: AssertionKind): string | null {
  if (kind === "latency") return "ms";
  if (kind === "ssl") return "days";
  return null;
}

function valueIsNumeric(kind: AssertionKind): boolean {
  return kind === "latency" || kind === "ssl";
}

const PRESET_ASSERTIONS: Array<{ label: string; build: () => AssertionDraft }> = [
  {
    label: "latency < 1s",
    build: () => ({ ...defaultAssertion("latency"), operator: "lt", value: "1000" }),
  },
  {
    label: 'body contains "ok"',
    build: () => ({ ...defaultAssertion("body"), operator: "contains", value: '"ok"' }),
  },
  {
    label: "content-type json",
    build: () => ({
      ...defaultAssertion("header"),
      operator: "contains",
      target: "content-type",
      value: "application/json",
    }),
  },
  {
    label: "$.status == ok",
    build: () => ({
      ...defaultAssertion("json"),
      operator: "eq",
      target: "$.status",
      value: "ok",
    }),
  },
];

export interface TestResponse {
  baseStatus: "healthy" | "degraded" | "down";
  baseReason?: string | null;
  probe: {
    statusCode: number | null;
    responseTime: number;
    errorMessage: string | null;
    contentType: string | null;
    bodyBytes: number | null;
    bodyBytesTruncated: boolean;
    sslDaysRemaining: number | null;
  };
  assertionResult: AssertionEvalResult | null;
}

function AssertionsPanel({
  endpoint,
  onJumpToSection,
  onEndpointUpdated,
  onDirtyChange,
}: {
  endpoint: ApiEndpoint;
  onJumpToSection: (s: Section) => void;
  onEndpointUpdated: (e: ApiEndpoint) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { request } = useApi();
  const { modules } = useModules();
  const [assertions, setAssertions] = useState<AssertionDraft[]>(() =>
    hydrateDrafts(endpoint.assertions),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const isHttp = endpoint.type === "http";
  const isHttps = (endpoint.url ?? "").startsWith("https://");
  const sslChecksDisabled = !modules.sslChecks;

  const updateAt = useCallback(
    (i: number, next: AssertionDraft) => {
      setAssertions((prev) => prev.map((a, idx) => (idx === i ? next : a)));
    },
    [],
  );
  const removeAt = useCallback((i: number) => {
    setAssertions((prev) => prev.filter((_, idx) => idx !== i));
  }, []);
  const addAssertion = useCallback((kind: AssertionKind) => {
    setAssertions((prev) =>
      prev.length >= MAX_ASSERTIONS ? prev : [...prev, defaultAssertion(kind)],
    );
  }, []);

  const atCap = assertions.length >= MAX_ASSERTIONS;

  const initialKey = useMemo(
    () => JSON.stringify(stripIds(hydrateDrafts(endpoint.assertions))),
    [endpoint.assertions],
  );
  const currentKey = useMemo(
    () => JSON.stringify(stripIds(assertions)),
    [assertions],
  );
  const dirty = currentKey !== initialKey;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const payload = stripIds(assertions);
    const res = await request<{ data: ApiEndpoint }>(
      `/endpoints/${endpoint.id}/settings`,
      { method: "PUT", body: { assertions: payload } },
    );
    setSaving(false);
    if (res.status < 400 && res.data.data) {
      onEndpointUpdated(res.data.data);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } else {
      const e = res.data as unknown as { message?: string };
      setSaveError(e.message ?? "Failed to save");
    }
  }, [assertions, endpoint.id, request, onEndpointUpdated]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    const payload = stripIds(assertions);
    const res = await request<{ data: TestResponse }>(
      `/endpoints/${endpoint.id}/test-assertions`,
      { method: "POST", body: { assertions: payload } },
    );
    setTesting(false);
    if (res.status < 400 && res.data.data) {
      setTestResult(res.data.data);
    } else {
      const e = res.data as unknown as { message?: string };
      setTestError(e.message ?? "Test failed");
      setTestResult(null);
    }
  }, [assertions, endpoint.id, request]);

  const statusCodes = endpoint.expectedStatusCodes ?? [200];

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
            title={atCap ? "Maximum reached" : undefined}
          >
            {assertions.length}/{MAX_ASSERTIONS}
          </span>
        }
      />

      <div className="flex flex-col gap-2">
        <LockedStatusAssertion
          codes={statusCodes}
          onJumpToGeneral={() => onJumpToSection("general")}
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

      <div className="flex items-center gap-3 pt-4 border-t border-wd-border/40 flex-wrap">
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
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={runTest}
          isDisabled={testing || assertions.length === 0}
        >
          {testing ? (
            <Spinner size="sm" />
          ) : (
            <Icon icon="solar:play-circle-outline" width={16} />
          )}
          Test now
        </Button>
        <span className="inline-flex items-center gap-1 text-[10.5px] text-wd-muted">
          <Icon icon="solar:info-circle-outline" width={11} />
          Test runs one probe — no check is saved to history.
        </span>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-success">
            <Icon icon="solar:check-circle-outline" width={13} />
            Saved
          </span>
        )}
        {saveError && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {saveError}
          </span>
        )}
      </div>

      {testError && (
        <div className="rounded-lg border border-wd-danger/40 bg-wd-danger/5 px-3 py-2 text-[11.5px] text-wd-danger inline-flex items-center gap-2">
          <Icon icon="solar:danger-triangle-outline" width={13} />
          {testError}
        </div>
      )}

      {testResult && (
        <AssertionTestResults
          result={testResult}
          onDismiss={() => setTestResult(null)}
        />
      )}

      <AssertionRulesOfUse />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test results panel — rendered after the user clicks "Test now". Mirrors the
// visual vocabulary of the Checks tab's expanded Assertions block so real
// checks and test runs read the same.
// ---------------------------------------------------------------------------

export function AssertionTestResults({
  result,
  onDismiss,
}: {
  result: TestResponse;
  onDismiss: () => void;
}) {
  const { probe, assertionResult, baseStatus, baseReason } = result;
  const baseTone =
    baseStatus === "healthy"
      ? "text-wd-success"
      : baseStatus === "degraded"
        ? "text-wd-warning"
        : "text-wd-danger";

  // When the probe itself failed (status-code gate down) we render a compact
  // "probe failed, assertions skipped" notice instead of an empty rules list.
  const probeFailed = baseStatus === "down";

  return (
    <div className="rounded-lg border border-wd-border/50 bg-wd-surface-hover/30 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
          <Icon icon="solar:play-circle-outline" width={13} />
          Test result
          <span className={cn("normal-case font-mono font-semibold", baseTone)}>
            · {baseStatus}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-wd-muted hover:text-foreground hover:bg-wd-surface-hover transition-colors cursor-pointer"
          aria-label="Dismiss test result"
        >
          <Icon icon="solar:close-circle-outline" width={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11.5px]">
        <ProbeField label="Status code" value={probe.statusCode ?? "—"} />
        <ProbeField label="Response time" value={`${probe.responseTime} ms`} />
        <ProbeField
          label="Content-Type"
          value={probe.contentType ?? "—"}
          muted={!probe.contentType}
        />
        <ProbeField
          label="Body"
          value={
            probe.bodyBytes != null
              ? `${probe.bodyBytes}${probe.bodyBytesTruncated ? "+" : ""} B`
              : "—"
          }
          muted={probe.bodyBytes == null}
        />
        <ProbeField
          label="SSL days"
          value={
            probe.sslDaysRemaining != null ? `${probe.sslDaysRemaining}` : "—"
          }
          muted={probe.sslDaysRemaining == null}
        />
        {probe.errorMessage && (
          <ProbeField label="Probe error" value={probe.errorMessage} danger />
        )}
      </div>

      {probeFailed && (
        <div className="rounded-md border border-dashed border-wd-danger/40 bg-wd-danger/5 px-3 py-2 text-[11.5px] text-wd-danger font-mono inline-flex items-center gap-2">
          <Icon icon="solar:danger-triangle-outline" width={13} />
          Probe {baseReason ? `failed: ${baseReason}` : "failed before assertions could run."}
        </div>
      )}

      {!probeFailed && assertionResult && assertionResult.results.length > 0 && (
        <div className="flex flex-col gap-1">
          {assertionResult.results.map((r, i) => (
            <TestAssertionRow key={i} result={r} />
          ))}
        </div>
      )}

      {!probeFailed && assertionResult === null && (
        <div className="text-[11px] text-wd-muted font-mono">
          No assertions were evaluated — add or unsave some rules to test.
        </div>
      )}
    </div>
  );
}

function ProbeField({
  label,
  value,
  muted = false,
  danger = false,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-wd-muted shrink-0 min-w-[90px]">{label}</span>
      <span
        className={cn(
          "truncate",
          danger ? "text-wd-danger" : muted ? "text-wd-muted" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

const TEST_OP_LABEL: Record<string, string> = {
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  eq: "==",
  neq: "≠",
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  exists: "exists",
  not_exists: "does not exist",
};

function TestAssertionRow({ result }: { result: AssertionResult }) {
  const passed = result.passed;
  const tone = passed
    ? "bg-wd-success/[0.08] text-wd-success"
    : result.severity === "down"
      ? "bg-wd-danger/[0.08] text-wd-danger"
      : "bg-wd-warning/[0.10] text-wd-warning";
  const icon = passed
    ? "solar:check-circle-bold"
    : result.severity === "down"
      ? "solar:close-circle-bold"
      : "solar:danger-triangle-bold";
  const showValue =
    result.operator !== "exists" && result.operator !== "not_exists";
  const opLabel = TEST_OP_LABEL[result.operator] ?? result.operator;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-[5px] rounded-md font-mono text-[11.5px]",
        tone,
      )}
    >
      <Icon icon={icon} width={12} />
      <span className="min-w-0">
        <b className="font-semibold">{result.kind}</b>{" "}
        {result.target && (
          <span className="text-wd-muted">{result.target} </span>
        )}
        <span className="text-wd-muted">{opLabel}</span>
        {showValue && result.value !== undefined && <> {result.value}</>}
      </span>
      {!passed && (
        <span className="text-wd-muted ml-auto truncate max-w-[45%]">
          {result.error
            ? `error: ${result.error}`
            : `actual: ${formatTestActual(result.actual)}`}
        </span>
      )}
    </div>
  );
}

function formatTestActual(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------
// Rules of use — compact reference of per-kind constraints, limits, and the
// syntax rules callers have to follow. Kept intentionally quiet (muted copy,
// mono for identifiers) so it reads as reference, not a primary control.
// ---------------------------------------------------------------------------

export function AssertionRulesOfUse() {
  const rules: Array<{ label: string; body: React.ReactNode }> = [
    {
      label: "Count",
      body: (
        <>
          Max <b className="text-foreground">{MAX_ASSERTIONS}</b> assertions per
          endpoint (status-code gate from General does not count).
        </>
      ),
    },
    {
      label: "Latency",
      body: (
        <>
          Value in milliseconds · range{" "}
          <b className="text-foreground">0 – 60,000</b> (0–60 seconds). Operators:
          &lt;, ≤, &gt;, ≥, ==.
        </>
      ),
    },
    {
      label: "SSL days",
      body: (
        <>
          Integer · range <b className="text-foreground">0 – 365</b>. Compares
          against days remaining before certificate expiry.
        </>
      ),
    },
    {
      label: "Body",
      body: (
        <>
          Case-sensitive substring or exact match against the response body.
          Value up to <b className="text-foreground">1,000</b> characters.
          Response body capture is capped at the{" "}
          <span className="text-foreground">maxBodyBytesToRead</span> config
          value — oversized bodies are truncated before evaluation.
        </>
      ),
    },
    {
      label: "Header names",
      body: (
        <>
          <b className="text-foreground">Case-insensitive</b> match against
          response headers (HTTP header names are not case-sensitive by spec).
          Name up to <b className="text-foreground">128</b> characters, value up
          to <b className="text-foreground">1,000</b>.
        </>
      ),
    },
    {
      label: "JSON path",
      body: (
        <>
          Dotted syntax · e.g.{" "}
          <span className="text-foreground">$.data.status</span> or{" "}
          <span className="text-foreground">items.0.name</span> (numeric
          segments = array index). Path up to{" "}
          <b className="text-foreground">256</b> characters. Wildcards, filters,
          and recursive descent are <b className="text-foreground">not</b>{" "}
          supported.
        </>
      ),
    },
    {
      label: "Severity",
      body: (
        <>
          Each rule marks the check as{" "}
          <span className="text-wd-danger font-semibold">down</span> or{" "}
          <span className="text-wd-warning font-semibold">degraded</span> on
          failure. Defaults: latency/SSL → degraded · body/header/JSON → down.
          Assertions are only evaluated when the status-code gate passes.
        </>
      ),
    },
  ];

  return (
    <details className="mt-1 group rounded-lg border border-wd-border/40 bg-wd-surface-hover/20 overflow-hidden">
      <summary
        className={cn(
          "flex items-center justify-between gap-3 cursor-pointer select-none",
          "px-4 py-3 list-none",
          "hover:bg-wd-surface-hover/40 transition-colors",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
          <Icon icon="solar:book-outline" width={13} />
          Rules of use
        </span>
        <Icon
          icon="solar:alt-arrow-down-linear"
          width={14}
          className="text-wd-muted transition-transform group-open:rotate-180"
        />
      </summary>

      <ul className="flex flex-col px-4 pb-4 pt-1 divide-y divide-wd-border/30">
        {rules.map((r) => (
          <li
            key={r.label}
            className="flex flex-col sm:flex-row sm:items-baseline gap-2 sm:gap-8 py-3 text-[11.5px] leading-relaxed first:pt-2 last:pb-1"
          >
            <span className="shrink-0 w-[96px] font-mono uppercase tracking-wider text-[10px] font-semibold text-wd-muted">
              {r.label}
            </span>
            <span className="font-mono text-wd-muted/90 flex-1">{r.body}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Row: locked status-codes mirror (read-only, surfaces General-tab config)
// ---------------------------------------------------------------------------

export function LockedStatusAssertion({
  codes,
  onJumpToGeneral,
}: {
  codes: number[];
  onJumpToGeneral: () => void;
}) {
  const sorted = useMemo(() => [...codes].sort((a, b) => a - b), [codes]);
  const display = sorted.join(", ");
  const opLabel = sorted.length === 1 ? "==" : "in";
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 py-2 rounded-md font-mono text-[12px]",
        "bg-wd-success/[0.08] text-wd-success border border-wd-success/25",
      )}
    >
      <Icon icon="solar:lock-keyhole-minimalistic-linear" width={13} />
      <span>
        <b className="font-semibold">status</b>{" "}
        <span className="text-wd-muted">{opLabel}</span> {display || "—"}
      </span>
      <button
        type="button"
        onClick={onJumpToGeneral}
        className={cn(
          "ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-md",
          "text-[10.5px] font-sans font-medium text-wd-muted hover:text-foreground",
          "bg-wd-surface hover:bg-wd-surface-hover border border-wd-border/50",
          "transition-colors cursor-pointer",
        )}
      >
        Edit in General
        <Icon icon="solar:alt-arrow-right-linear" width={11} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row: editable assertion
// ---------------------------------------------------------------------------

export function AssertionEditorRow({
  index,
  value,
  isHttps,
  sslChecksDisabled,
  onChange,
  onRemove,
}: {
  index: number;
  value: AssertionDraft;
  isHttps: boolean;
  sslChecksDisabled: boolean;
  onChange: (next: AssertionDraft) => void;
  onRemove: () => void;
}) {
  const meta = KIND_META[value.kind];
  const showTarget = needsTarget(value.kind);
  const showValue = needsValue(value.operator);
  const suffix = valueSuffix(value.kind);
  const isNumeric = valueIsNumeric(value.kind);
  // Two distinct warnings can fire on ssl rows — the URL-scheme one is hard
  // (rule can never succeed), the module one is soft (user can flip a flag).
  // Prefer the URL warning because it's the root cause; the module one is
  // irrelevant if the endpoint isn't HTTPS in the first place.
  const sslHttpsWarning = value.kind === "ssl" && !isHttps;
  const sslModuleWarning =
    value.kind === "ssl" && isHttps && sslChecksDisabled;

  const changeKind = (kind: AssertionKind) => {
    if (kind === value.kind) return;
    const ops = operatorsFor(kind);
    const nextOp = (ops.includes(value.operator) ? value.operator : ops[0]) as
      | AssertionOperator;
    const base = defaultAssertion(kind);
    onChange({ ...base, id: value.id, operator: nextOp });
  };

  const changeOp = (op: AssertionOperator) => {
    onChange({ ...value, operator: op });
  };

  return (
    <div className="flex flex-col gap-1">
    <div
      className={cn(
        "group flex items-stretch gap-0 rounded-md border overflow-hidden",
        "transition-colors",
        meta.border,
      )}
    >
      <div className="shrink-0 flex items-center justify-center w-8 text-[10px] font-mono font-semibold text-wd-muted/60 select-none border-r border-wd-border/30 bg-wd-surface-hover/30">
        {String(index).padStart(2, "0")}
      </div>

      <div
        className={cn(
          "flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 flex-wrap",
          meta.tint,
        )}
      >
        <Icon icon={meta.icon} width={14} className={cn("shrink-0", meta.accent)} />

        <FilterDropdown<AssertionKind>
          value={value.kind}
          options={(Object.keys(KIND_META) as AssertionKind[]).map((k) => ({
            id: k,
            label: KIND_META[k].label,
          }))}
          onChange={changeKind}
          ariaLabel="Assertion kind"
        />

        {showTarget && (
          <input
            value={value.target ?? ""}
            onChange={(e) => onChange({ ...value, target: e.target.value })}
            placeholder={targetPlaceholder(value.kind)}
            aria-label="Target"
            className={cn(
              "flex-1 min-w-[140px] h-8 px-2.5 rounded-md",
              "bg-wd-surface border border-wd-border/50",
              "text-[12px] font-mono text-foreground placeholder:text-wd-muted/70",
              "focus:outline-none focus:border-wd-primary/60 transition-colors",
            )}
          />
        )}

        <FilterDropdown<AssertionOperator>
          value={value.operator}
          options={operatorsFor(value.kind).map((op) => ({
            id: op,
            label: OPERATOR_LABEL[op],
          }))}
          onChange={changeOp}
          ariaLabel="Operator"
        />

        {showValue && (
          <div className="relative flex-1 min-w-[160px] inline-flex items-center">
            <input
              value={value.value ?? ""}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
              placeholder={isNumeric ? "0" : "value"}
              inputMode={isNumeric ? "numeric" : undefined}
              aria-label="Value"
              className={cn(
                "w-full h-8 pl-2.5 rounded-md",
                suffix ? "pr-10" : "pr-2.5",
                "bg-wd-surface border border-wd-border/50",
                "text-[12px] font-mono text-foreground placeholder:text-wd-muted/70",
                "focus:outline-none focus:border-wd-primary/60 transition-colors",
              )}
            />
            {suffix && (
              <span className="absolute right-2.5 text-[10.5px] font-mono text-wd-muted pointer-events-none">
                {suffix}
              </span>
            )}
          </div>
        )}

        <SeverityToggle
          value={value.severity}
          onChange={(sev) => onChange({ ...value, severity: sev })}
        />
      </div>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove assertion ${index}`}
        className="shrink-0 inline-flex items-center justify-center w-9 text-wd-muted hover:text-wd-danger hover:bg-wd-danger/5 border-l border-wd-border/30 transition-colors cursor-pointer"
      >
        <Icon icon="solar:trash-bin-minimalistic-linear" width={14} />
      </button>
    </div>

    {sslHttpsWarning && (
      <div className="ml-8 inline-flex items-center gap-1.5 text-[10.5px] text-wd-warning font-mono">
        <Icon icon="solar:danger-triangle-outline" width={12} className="shrink-0" />
        Endpoint is HTTP — SSL assertions require HTTPS and will always fail.
      </div>
    )}
    {sslModuleWarning && (
      <div className="ml-8 inline-flex items-center gap-1.5 text-[10.5px] text-wd-warning font-mono">
        <Icon icon="solar:danger-triangle-outline" width={12} className="shrink-0" />
        sslChecks module is disabled — enable it in watchdeck.config.js or this rule will always fail.
      </div>
    )}
    </div>
  );
}

// Two-state toggle that reads like a status pill so users instantly see what
// failure mode this rule enforces. Matches the status colour tokens used in
// the Hero banner and the Checks tab status dots.
function SeverityToggle({
  value,
  onChange,
}: {
  value: AssertionSeverity;
  onChange: (next: AssertionSeverity) => void;
}) {
  const isDown = value === "down";
  return (
    <button
      type="button"
      onClick={() => onChange(isDown ? "degraded" : "down")}
      aria-label={`On failure: mark as ${value} — click to switch`}
      title={`On failure: mark as ${value}`}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-[11px] font-mono font-semibold",
        "transition-colors cursor-pointer",
        isDown
          ? "border-wd-danger/40 bg-wd-danger/10 text-wd-danger hover:bg-wd-danger/15"
          : "border-wd-warning/40 bg-wd-warning/10 text-wd-warning hover:bg-wd-warning/15",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isDown ? "bg-wd-danger" : "bg-wd-warning",
        )}
      />
      → {value}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty state + add-row affordance
// ---------------------------------------------------------------------------

export function EmptyAssertionsHint({
  onAdd,
  atCap,
}: {
  onAdd: (kind: AssertionKind) => void;
  atCap: boolean;
}) {
  return (
    <div className="rounded-md border border-dashed border-wd-border/50 bg-wd-surface-hover/20 px-3 py-4 flex items-center gap-3">
      <Icon
        icon="solar:checklist-minimalistic-outline"
        width={18}
        className="text-wd-muted shrink-0"
      />
      <div className="flex-1 text-[11.5px] text-wd-muted">
        No extra assertions yet · the status-code gate above is always enforced.
        Add a rule to check latency, body, headers, or a JSON field.
      </div>
      <AddAssertionMenu onAdd={onAdd} atCap={atCap} compact />
    </div>
  );
}

export function AddAssertionMenu({
  onAdd,
  atCap,
  compact = false,
}: {
  onAdd: (kind: AssertionKind) => void;
  atCap: boolean;
  compact?: boolean;
}) {
  const kinds = Object.keys(KIND_META) as AssertionKind[];
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 flex-wrap",
        !compact && "pt-0.5",
      )}
    >
      <span className="uppercase tracking-wider text-[9.5px] font-semibold text-wd-muted mr-0.5">
        Add
      </span>
      {kinds.map((k) => {
        const meta = KIND_META[k];
        return (
          <button
            key={k}
            onClick={() => onAdd(k)}
            disabled={atCap}
            title={atCap ? `Max ${MAX_ASSERTIONS} assertions per endpoint` : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md",
              "text-[11.5px] font-medium border",
              atCap
                ? "bg-wd-surface/40 border-wd-border/30 text-wd-muted/50 cursor-not-allowed"
                : "bg-wd-surface hover:bg-wd-surface-hover border-wd-border/50 text-wd-muted hover:text-foreground cursor-pointer",
              "transition-colors",
            )}
          >
            <Icon icon={meta.icon} width={12} className={cn(!atCap && meta.accent)} />
            {meta.label}
          </button>
        );
      })}
      {atCap && (
        <span className="text-[10.5px] text-wd-warning inline-flex items-center gap-1 ml-1">
          <Icon icon="solar:danger-triangle-outline" width={11} />
          Max {MAX_ASSERTIONS} reached
        </span>
      )}
    </div>
  );
}

export function AssertionPresetsRow({
  onApply,
  atCap,
}: {
  onApply: (draft: AssertionDraft) => void;
  atCap: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="uppercase tracking-wider text-[9.5px] font-semibold text-wd-muted">
        Common
      </span>
      {PRESET_ASSERTIONS.map((p) => (
        <button
          key={p.label}
          onClick={() => onApply(p.build())}
          disabled={atCap}
          className={cn(
            "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-mono border transition-colors",
            atCap
              ? "bg-wd-surface/40 border-wd-border/30 text-wd-muted/50 cursor-not-allowed"
              : "bg-wd-surface-hover/40 hover:bg-wd-surface-hover border-wd-border/40 text-wd-muted hover:text-foreground cursor-pointer",
          )}
        >
          <Icon icon="solar:add-square-linear" width={11} />
          {p.label}
        </button>
      ))}
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
      `/endpoints/${endpoint.id}/toggle`,
      {
        method: "PATCH",
      },
    );
    if (res.status < 400 && res.data.data) onEndpointUpdated(res.data.data);
    setPausing(false);
  }, [endpoint.id, request, onEndpointUpdated]);

  const destroy = useCallback(async () => {
    if (confirm !== endpoint.name) return;
    setDeleting(true);
    const res = await request(`/endpoints/${endpoint.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (res.status < 400) onDeleted();
  }, [confirm, endpoint.id, endpoint.name, request, onDeleted]);

  const paused = endpoint.status === "paused";
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
            {paused ? "Resume monitoring" : "Pause monitoring"}
          </div>
          <div className="text-[11.5px] text-wd-muted">
            {paused
              ? "Re-enable the scheduler for this endpoint."
              : "Stops scheduled checks. No alerts will fire while paused."}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={togglePause}
          isDisabled={pausing}
        >
          {pausing ? (
            <Spinner size="sm" />
          ) : (
            <Icon
              icon={paused ? "solar:play-circle-outline" : "solar:pause-circle-outline"}
              width={16}
            />
          )}
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>

      <div className="flex flex-col gap-3 pt-4">
        <div>
          <div className="text-[12.5px] font-medium text-wd-danger">
            Delete endpoint
          </div>
          <div className="text-[11.5px] text-wd-muted">
            Permanently removes the endpoint and stops future checks.
            Historical checks and incidents stay in the database for
            post-mortem.
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            placeholder={`Type "${endpoint.name}" to confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={cn(inputClass, "max-w-sm")}
          />
          <Button
            size="sm"
            variant="outline"
            className="!rounded-lg !border-wd-danger/50 !text-wd-danger hover:!bg-wd-danger/10"
            onPress={destroy}
            isDisabled={confirm !== endpoint.name || deleting}
          >
            {deleting ? (
              <Spinner size="sm" />
            ) : (
              <Icon icon="solar:trash-bin-minimalistic-linear" width={16} />
            )}
            Delete endpoint
          </Button>
        </div>
      </div>
    </div>
  );
}

export default memo(SettingsTabBase);
