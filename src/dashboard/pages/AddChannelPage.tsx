/**
 * Channel form — create + edit in one page.
 *
 *   /notifications/channels/new       → create mode (POST)
 *   /notifications/channels/:id/edit  → edit mode   (PUT, with Delete + Test)
 *
 * Mirrors the Add-endpoint layout (left nav + panels + sticky footer) so the
 * surface stays consistent. Two sections only:
 *
 *   • Connection — type picker, name, type-specific credentials
 *   • Delivery   — priority, severity filter, event filters, rate limit,
 *                  retry-on-failure, enabled
 *
 * All boolean toggles use HeroUI's compound Checkbox so checkmark/focus/hover
 * states match the rest of the app.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Label,
  Spinner,
  cn,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { useApi } from "../hooks/useApi";
import { toast } from "../ui/toast";
import type {
  ApiChannel,
  ChannelType,
  DeliveryPriority,
  SeverityFilter,
} from "../types/notifications";
import {
  CHANNEL_TYPE_ICON,
  CHANNEL_TYPE_LABEL,
} from "../types/notifications";
import {
  FilterDropdown,
  SectionHead,
} from "../components/endpoint-detail/primitives";
import {
  Field,
  errorInputClass,
  inputClass,
} from "../components/endpoint-detail/SettingsTab";

type Section = "connection" | "delivery";

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: "connection", label: "Connection", icon: "solar:plug-circle-outline" },
  { key: "delivery", label: "Delivery", icon: "solar:bell-bing-outline" },
];

type WebhookMethod = "POST" | "PUT" | "PATCH";

function parseKV(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)\s*$/);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

function kvToText(kv: Record<string, string> | undefined): string {
  if (!kv) return "";
  return Object.entries(kv)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

const textAreaClass =
  "w-full rounded-lg bg-wd-surface border border-wd-border/60 px-3 py-2 text-[12.5px] text-foreground font-mono placeholder:text-wd-muted/70 focus:outline-none focus:border-wd-primary transition-colors resize-y";

export default function ChannelFormPage() {
  const navigate = useNavigate();
  const { request } = useApi();
  const params = useParams<{ id: string }>();
  const channelId = params.id ?? null;
  const isEdit = channelId != null;

  const [section, setSection] = useState<Section>("connection");

  // ── Connection ──
  const [type, setType] = useState<ChannelType>("discord");
  const [name, setName] = useState("");

  // ── Connection · Discord ──
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [discordUsername, setDiscordUsername] = useState("");
  const [discordAvatarUrl, setDiscordAvatarUrl] = useState("");

  // ── Connection · Slack ──
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");

  // ── Connection · Email ──
  const [emailEndpoint, setEmailEndpoint] = useState("");
  const [emailRecipients, setEmailRecipients] = useState("");

  // ── Connection · Webhook ──
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookMethod, setWebhookMethod] = useState<WebhookMethod>("POST");
  const [webhookHeaders, setWebhookHeaders] = useState("");
  const [webhookBodyTemplate, setWebhookBodyTemplate] = useState("");

  // ── Delivery ──
  const [deliveryPriority, setDeliveryPriority] =
    useState<DeliveryPriority>("standard");
  const [severityFilter, setSeverityFilter] =
    useState<SeverityFilter>("warning+");
  const [sendOpen, setSendOpen] = useState(true);
  const [sendResolved, setSendResolved] = useState(true);
  const [sendEscalation, setSendEscalation] = useState(true);
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [maxPerMinute, setMaxPerMinute] = useState(30);
  const [retryOnFailure, setRetryOnFailure] = useState(true);
  const [enabled, setEnabled] = useState(true);

  // ── Edit-mode load ──
  const [loading, setLoading] = useState(isEdit);
  const [loadedChannel, setLoadedChannel] = useState<ApiChannel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !channelId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const res = await request<{ data: ApiChannel }>(
        `/notifications/channels/${channelId}`,
      );
      if (cancelled) return;
      if (res.status >= 400 || !res.data?.data) {
        setLoadError(`Failed to load channel (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      const ch = res.data.data;
      setLoadedChannel(ch);
      setType(ch.type);
      setName(ch.name);
      setDiscordWebhookUrl(ch.discordWebhookUrl ?? "");
      setDiscordUsername(ch.discordUsername ?? "");
      setDiscordAvatarUrl(ch.discordAvatarUrl ?? "");
      setSlackWebhookUrl(ch.slackWebhookUrl ?? "");
      setEmailEndpoint(ch.emailEndpoint ?? "");
      setEmailRecipients((ch.emailRecipients ?? []).join(", "));
      setWebhookUrl(ch.webhookUrl ?? "");
      setWebhookMethod((ch.webhookMethod as WebhookMethod) ?? "POST");
      setWebhookHeaders(kvToText(ch.webhookHeaders));
      setWebhookBodyTemplate(ch.webhookBodyTemplate ?? "");
      setDeliveryPriority(ch.deliveryPriority);
      setSeverityFilter(ch.severityFilter);
      setSendOpen(ch.eventFilters.sendOpen);
      setSendResolved(ch.eventFilters.sendResolved);
      setSendEscalation(ch.eventFilters.sendEscalation);
      setRateLimitEnabled(!!ch.rateLimit);
      if (ch.rateLimit) setMaxPerMinute(ch.rateLimit.maxPerMinute);
      setRetryOnFailure(ch.retryOnFailure);
      setEnabled(ch.enabled);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, channelId, request]);

  // ── Validation ──
  const nameError = name.trim() === "" ? "Name is required." : null;

  const discordWebhookUrlError = useMemo<string | null>(() => {
    if (type !== "discord") return null;
    if (discordWebhookUrl.trim() === "")
      return "Discord webhook URL is required.";
    try {
      const u = new URL(discordWebhookUrl);
      if (u.protocol !== "https:") return "Webhook URL must be https://.";
    } catch {
      return "Webhook URL is not a valid URL.";
    }
    return null;
  }, [type, discordWebhookUrl]);

  const slackWebhookUrlError = useMemo<string | null>(() => {
    if (type !== "slack") return null;
    if (slackWebhookUrl.trim() === "") return "Slack webhook URL is required.";
    try {
      const u = new URL(slackWebhookUrl);
      if (u.protocol !== "https:") return "Webhook URL must be https://.";
    } catch {
      return "Webhook URL is not a valid URL.";
    }
    return null;
  }, [type, slackWebhookUrl]);

  const emailEndpointError = useMemo<string | null>(() => {
    if (type !== "email") return null;
    if (emailEndpoint.trim() === "")
      return "SMTP endpoint is required (e.g. smtp://user:pass@host:587).";
    try {
      const u = new URL(emailEndpoint);
      if (u.protocol !== "smtp:" && u.protocol !== "smtps:")
        return "SMTP endpoint must use smtp:// or smtps://.";
    } catch {
      return "SMTP endpoint is not a valid URL.";
    }
    return null;
  }, [type, emailEndpoint]);

  const emailRecipientsError = useMemo<string | null>(() => {
    if (type !== "email") return null;
    const recips = emailRecipients
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (recips.length === 0) return "At least one recipient is required.";
    return null;
  }, [type, emailRecipients]);

  const webhookUrlError = useMemo<string | null>(() => {
    if (type !== "webhook") return null;
    if (webhookUrl.trim() === "") return "Webhook URL is required.";
    try {
      const u = new URL(webhookUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:")
        return "Webhook URL must be http(s)://.";
    } catch {
      return "Webhook URL is not a valid URL.";
    }
    return null;
  }, [type, webhookUrl]);

  const connectionError =
    discordWebhookUrlError ||
    slackWebhookUrlError ||
    emailEndpointError ||
    emailRecipientsError ||
    webhookUrlError;

  const canSubmit = !nameError && !connectionError && !loading;

  // ── Submit ──
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!canSubmit) {
      if (nameError || connectionError) setSection("connection");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = {
      name: name.trim(),
      deliveryPriority,
      enabled,
      severityFilter,
      eventFilters: {
        sendOpen,
        sendResolved,
        sendEscalation,
      },
      rateLimit: rateLimitEnabled ? { maxPerMinute } : null,
      retryOnFailure,
    };

    // Type is immutable post-create; only the create payload carries it.
    if (!isEdit) body.type = type;

    switch (type) {
      case "discord":
        if (discordWebhookUrl)
          body.discordWebhookUrl = discordWebhookUrl.trim();
        if (discordUsername) body.discordUsername = discordUsername.trim();
        if (discordAvatarUrl) body.discordAvatarUrl = discordAvatarUrl.trim();
        break;
      case "slack":
        if (slackWebhookUrl) body.slackWebhookUrl = slackWebhookUrl.trim();
        break;
      case "email":
        if (emailEndpoint) body.emailEndpoint = emailEndpoint.trim();
        body.emailRecipients = emailRecipients
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "webhook":
        if (webhookUrl) body.webhookUrl = webhookUrl.trim();
        body.webhookMethod = webhookMethod;
        body.webhookHeaders = parseKV(webhookHeaders);
        if (webhookBodyTemplate) body.webhookBodyTemplate = webhookBodyTemplate;
        break;
    }

    const res = await request<{ data: ApiChannel }>(
      isEdit
        ? `/notifications/channels/${channelId}`
        : "/notifications/channels",
      { method: isEdit ? "PUT" : "POST", body },
    );
    setSubmitting(false);
    if (res.status < 400 && res.data?.data) {
      toast.success(isEdit ? "Channel Saved" : "Channel Created", {
        description: res.data.data.name,
      });
      navigate("/notifications");
    } else {
      const e = res.data as unknown as {
        error?: { message?: string };
        message?: string;
      };
      const msg =
        e?.error?.message ?? e?.message ?? `Save failed (HTTP ${res.status})`;
      setSubmitError(msg);
      toast.error(isEdit ? "Channel Save Failed" : "Channel Create Failed", {
        description: msg,
      });
    }
  }, [
    canSubmit,
    nameError,
    connectionError,
    isEdit,
    channelId,
    type,
    name,
    deliveryPriority,
    enabled,
    severityFilter,
    sendOpen,
    sendResolved,
    sendEscalation,
    rateLimitEnabled,
    maxPerMinute,
    retryOnFailure,
    discordWebhookUrl,
    discordUsername,
    discordAvatarUrl,
    slackWebhookUrl,
    emailEndpoint,
    emailRecipients,
    webhookUrl,
    webhookMethod,
    webhookHeaders,
    webhookBodyTemplate,
    request,
    navigate,
  ]);

  // ── Edit-only actions ──
  const [testing, setTesting] = useState(false);
  const sendTest = useCallback(async () => {
    if (!channelId) return;
    setTesting(true);
    const res = await request<{ data: { ok: boolean; reason?: string } }>(
      `/notifications/channels/${channelId}/test`,
      { method: "POST" },
    );
    setTesting(false);
    const data = res.data?.data;
    if (res.status >= 400) {
      toast.error("Test Failed", { description: `HTTP ${res.status}` });
    } else if (data?.ok) {
      toast.success("Test Dispatched", { description: name || "Channel" });
    } else {
      toast.error("Test Failed", {
        description: data?.reason ?? "No reason given",
      });
    }
  }, [channelId, name, request]);

  const [deleting, setDeleting] = useState(false);
  const del = useCallback(async () => {
    if (!channelId) return;
    if (!confirm(`Delete channel "${name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const res = await request(`/notifications/channels/${channelId}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (res.status >= 400) {
      toast.error("Delete Failed", { description: `HTTP ${res.status}` });
      return;
    }
    toast.success("Channel Deleted", { description: name });
    navigate("/notifications");
  }, [channelId, name, request, navigate]);

  const headerTitle = isEdit
    ? loadedChannel
      ? `Edit — ${loadedChannel.name}`
      : "Edit channel"
    : "Add channel";

  return (
    <div className="flex flex-col min-h-full">
      {/* Breadcrumb header */}
      <div className="w-full max-w-6xl mx-auto flex items-center gap-2.5 px-6 pt-6 pb-4">
        <button
          onClick={() => navigate("/notifications")}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-wd-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <Icon icon="solar:arrow-left-linear" width={14} />
          Notifications
        </button>
        <Icon
          icon="solar:alt-arrow-right-linear"
          width={11}
          className="text-wd-muted/60"
        />
        <span className="text-[12.5px] font-semibold text-foreground">
          {headerTitle}
        </span>
      </div>

      {/* Load-error banner. Edit-mode only — create mode has nothing to load. */}
      {loadError && (
        <div className="w-full max-w-6xl mx-auto px-6 pb-3">
          <div className="rounded-lg border border-wd-danger/40 bg-wd-danger/10 px-3 py-2 text-[11.5px] text-wd-danger inline-flex items-center gap-2">
            <Icon icon="solar:danger-triangle-outline" width={13} />
            {loadError}
          </div>
        </div>
      )}

      {/* Main grid */}
      <div className="w-full max-w-6xl mx-auto flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5 px-6 pb-6">
        <nav className="rounded-xl border border-wd-border/50 bg-wd-surface p-1 self-start">
          {SECTIONS.map((s) => {
            const active = section === s.key;
            const hasError =
              (s.key === "connection" &&
                (nameError != null || connectionError != null));
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
          {loading ? (
            <div className="flex items-center justify-center h-[520px] text-wd-muted text-[12.5px]">
              <Spinner size="sm" />
              <span className="ml-2">Loading channel…</span>
            </div>
          ) : (
            <>
              <div className={cn(section !== "connection" && "hidden")}>
                <ConnectionSection
                  type={type}
                  setType={setType}
                  isEdit={isEdit}
                  name={name}
                  setName={setName}
                  nameError={nameError}
                  discordWebhookUrl={discordWebhookUrl}
                  setDiscordWebhookUrl={setDiscordWebhookUrl}
                  discordWebhookUrlError={discordWebhookUrlError}
                  discordUsername={discordUsername}
                  setDiscordUsername={setDiscordUsername}
                  discordAvatarUrl={discordAvatarUrl}
                  setDiscordAvatarUrl={setDiscordAvatarUrl}
                  slackWebhookUrl={slackWebhookUrl}
                  setSlackWebhookUrl={setSlackWebhookUrl}
                  slackWebhookUrlError={slackWebhookUrlError}
                  emailEndpoint={emailEndpoint}
                  setEmailEndpoint={setEmailEndpoint}
                  emailEndpointError={emailEndpointError}
                  emailRecipients={emailRecipients}
                  setEmailRecipients={setEmailRecipients}
                  emailRecipientsError={emailRecipientsError}
                  webhookUrl={webhookUrl}
                  setWebhookUrl={setWebhookUrl}
                  webhookUrlError={webhookUrlError}
                  webhookMethod={webhookMethod}
                  setWebhookMethod={setWebhookMethod}
                  webhookHeaders={webhookHeaders}
                  setWebhookHeaders={setWebhookHeaders}
                  webhookBodyTemplate={webhookBodyTemplate}
                  setWebhookBodyTemplate={setWebhookBodyTemplate}
                />
              </div>
              <div className={cn(section !== "delivery" && "hidden")}>
                <DeliverySection
                  deliveryPriority={deliveryPriority}
                  setDeliveryPriority={setDeliveryPriority}
                  severityFilter={severityFilter}
                  setSeverityFilter={setSeverityFilter}
                  sendOpen={sendOpen}
                  setSendOpen={setSendOpen}
                  sendResolved={sendResolved}
                  setSendResolved={setSendResolved}
                  sendEscalation={sendEscalation}
                  setSendEscalation={setSendEscalation}
                  rateLimitEnabled={rateLimitEnabled}
                  setRateLimitEnabled={setRateLimitEnabled}
                  maxPerMinute={maxPerMinute}
                  setMaxPerMinute={setMaxPerMinute}
                  retryOnFailure={retryOnFailure}
                  setRetryOnFailure={setRetryOnFailure}
                  enabled={enabled}
                  setEnabled={setEnabled}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sticky footer — full-width bg, inner content capped. */}
      <div className="sticky bottom-0 bg-wd-surface/95 backdrop-blur border-t border-wd-border/50">
        <div className="w-full max-w-6xl mx-auto px-6 py-3 flex items-center gap-3 flex-wrap">
          {(nameError || connectionError) && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
              <Icon icon="solar:danger-triangle-outline" width={13} />
              {nameError ?? connectionError}
            </span>
          )}
          {submitError && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-wd-danger">
              <Icon icon="solar:danger-triangle-outline" width={13} />
              {submitError}
            </span>
          )}

          {/* Edit-mode danger action sits far left so it never sits next to Save. */}
          {isEdit && (
            <Button
              size="sm"
              variant="outline"
              className="!rounded-lg !border-wd-danger/40 !text-wd-danger hover:!bg-wd-danger/10"
              onPress={() => void del()}
              isDisabled={submitting || deleting || loading}
            >
              {deleting ? (
                <Spinner size="sm" />
              ) : (
                <Icon icon="solar:trash-bin-minimalistic-linear" width={16} />
              )}
              Delete
            </Button>
          )}

          <div className="ml-auto flex items-center gap-3">
            {isEdit && (
              <Button
                size="sm"
                variant="outline"
                className="!rounded-lg"
                onPress={() => void sendTest()}
                isDisabled={submitting || testing || loading}
              >
                {testing ? (
                  <Spinner size="sm" />
                ) : (
                  <Icon icon="solar:test-tube-linear" width={16} />
                )}
                Send test
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="!rounded-lg"
              onPress={() => navigate("/notifications")}
              isDisabled={submitting || deleting}
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
                <Icon
                  icon={
                    isEdit
                      ? "solar:diskette-linear"
                      : "solar:add-circle-outline"
                  }
                  width={16}
                />
              )}
              {isEdit ? "Save changes" : "Create channel"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection — type picker, name, and type-specific credentials.
// ---------------------------------------------------------------------------

function ConnectionSection(props: {
  type: ChannelType;
  setType: (t: ChannelType) => void;
  isEdit: boolean;
  name: string;
  setName: (v: string) => void;
  nameError: string | null;
  discordWebhookUrl: string;
  setDiscordWebhookUrl: (v: string) => void;
  discordWebhookUrlError: string | null;
  discordUsername: string;
  setDiscordUsername: (v: string) => void;
  discordAvatarUrl: string;
  setDiscordAvatarUrl: (v: string) => void;
  slackWebhookUrl: string;
  setSlackWebhookUrl: (v: string) => void;
  slackWebhookUrlError: string | null;
  emailEndpoint: string;
  setEmailEndpoint: (v: string) => void;
  emailEndpointError: string | null;
  emailRecipients: string;
  setEmailRecipients: (v: string) => void;
  emailRecipientsError: string | null;
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  webhookUrlError: string | null;
  webhookMethod: WebhookMethod;
  setWebhookMethod: (v: WebhookMethod) => void;
  webhookHeaders: string;
  setWebhookHeaders: (v: string) => void;
  webhookBodyTemplate: string;
  setWebhookBodyTemplate: (v: string) => void;
}) {
  const {
    type,
    setType,
    isEdit,
    name,
    setName,
    nameError,
    discordWebhookUrl,
    setDiscordWebhookUrl,
    discordWebhookUrlError,
    discordUsername,
    setDiscordUsername,
    discordAvatarUrl,
    setDiscordAvatarUrl,
    slackWebhookUrl,
    setSlackWebhookUrl,
    slackWebhookUrlError,
    emailEndpoint,
    setEmailEndpoint,
    emailEndpointError,
    emailRecipients,
    setEmailRecipients,
    emailRecipientsError,
    webhookUrl,
    setWebhookUrl,
    webhookUrlError,
    webhookMethod,
    setWebhookMethod,
    webhookHeaders,
    setWebhookHeaders,
    webhookBodyTemplate,
    setWebhookBodyTemplate,
  } = props;

  const types: ChannelType[] = ["discord", "slack", "email", "webhook"];

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex flex-col gap-4">
      <SectionHead
        icon="solar:plug-circle-outline"
        title="Connection"
        sub={
          isEdit
            ? `Credentials and routing target · type cannot be changed after creation`
            : `Channel type, identity, and credentials`
        }
      />

      {/* Type picker. In edit mode it's shown read-only so users still see which
          type they're editing without being able to switch. */}
      <Field label="Channel type">
        <div className="inline-flex rounded-lg border border-wd-border/60 bg-wd-surface overflow-hidden">
          {types.map((t, i) => {
            const active = type === t;
            const disabled = isEdit && !active;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  if (!isEdit) setType(t);
                }}
                disabled={disabled}
                title={
                  isEdit && !active
                    ? "Channel type cannot be changed after creation"
                    : undefined
                }
                className={cn(
                  "px-4 h-9 text-[12px] font-medium transition-colors inline-flex items-center gap-1.5",
                  active
                    ? "bg-wd-primary/15 text-wd-primary"
                    : "text-wd-muted hover:bg-wd-surface-hover hover:text-foreground",
                  i > 0 && "border-l border-wd-border/60",
                  disabled
                    ? "opacity-40 cursor-not-allowed"
                    : "cursor-pointer",
                )}
              >
                <Icon icon={CHANNEL_TYPE_ICON[t]} width={14} />
                {CHANNEL_TYPE_LABEL[t]}
              </button>
            );
          })}
        </div>
      </Field>

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
          placeholder="#alerts-critical"
        />
      </Field>

      {/* Type-specific credential block — the "changes dependent on channel
          method selected" the user asked for. */}
      {type === "discord" && (
        <>
          <Field
            label="Webhook URL"
            hint={
              discordWebhookUrlError ??
              "Server Settings → Integrations → Webhooks → Copy Webhook URL"
            }
            error={discordWebhookUrlError != null}
          >
            <input
              value={discordWebhookUrl}
              onChange={(e) => setDiscordWebhookUrl(e.target.value)}
              aria-invalid={discordWebhookUrlError != null}
              className={cn(
                inputClass,
                discordWebhookUrlError && errorInputClass,
              )}
              placeholder="https://discord.com/api/webhooks/..."
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Author name"
              hint="Optional · overrides the webhook's default name"
            >
              <input
                value={discordUsername}
                onChange={(e) => setDiscordUsername(e.target.value)}
                className={inputClass}
                placeholder="WatchDeck"
              />
            </Field>
            <Field
              label="Author avatar URL"
              hint="Optional · must be an https image URL"
            >
              <input
                value={discordAvatarUrl}
                onChange={(e) => setDiscordAvatarUrl(e.target.value)}
                className={inputClass}
                placeholder="https://…"
              />
            </Field>
          </div>
        </>
      )}

      {type === "slack" && (
        <Field
          label="Slack webhook URL"
          hint={slackWebhookUrlError ?? "From Slack's Incoming Webhooks app"}
          error={slackWebhookUrlError != null}
        >
          <input
            value={slackWebhookUrl}
            onChange={(e) => setSlackWebhookUrl(e.target.value)}
            aria-invalid={slackWebhookUrlError != null}
            className={cn(inputClass, slackWebhookUrlError && errorInputClass)}
            placeholder="https://hooks.slack.com/services/..."
          />
        </Field>
      )}

      {type === "email" && (
        <>
          <Field
            label="SMTP endpoint"
            hint={
              emailEndpointError ??
              "smtp://user:pass@host:port · sender is derived from this URL + channel name"
            }
            error={emailEndpointError != null}
          >
            <input
              value={emailEndpoint}
              onChange={(e) => setEmailEndpoint(e.target.value)}
              aria-invalid={emailEndpointError != null}
              className={cn(inputClass, emailEndpointError && errorInputClass)}
              placeholder="smtp://user:pass@smtp.gmail.com:587"
            />
          </Field>
          <Field
            label="Recipients"
            hint={emailRecipientsError ?? "Comma- or newline-separated"}
            error={emailRecipientsError != null}
          >
            <textarea
              value={emailRecipients}
              onChange={(e) => setEmailRecipients(e.target.value)}
              rows={3}
              placeholder="ops@example.com, oncall@example.com"
              aria-invalid={emailRecipientsError != null}
              className={cn(
                textAreaClass,
                "min-h-[64px]",
                emailRecipientsError &&
                  "!border-wd-danger/60 focus:!border-wd-danger",
              )}
            />
          </Field>
        </>
      )}

      {type === "webhook" && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-4">
            <Field
              label="Webhook URL"
              hint={webhookUrlError ?? "Where WatchDeck sends the payload"}
              error={webhookUrlError != null}
            >
              <input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                aria-invalid={webhookUrlError != null}
                className={cn(inputClass, webhookUrlError && errorInputClass)}
                placeholder="https://example.com/hooks/watchdeck"
              />
            </Field>
            <Field label="Method">
              <FilterDropdown<WebhookMethod>
                value={webhookMethod}
                options={[
                  { id: "POST", label: "POST" },
                  { id: "PUT", label: "PUT" },
                  { id: "PATCH", label: "PATCH" },
                ]}
                onChange={setWebhookMethod}
                ariaLabel="HTTP method"
                fullWidth
              />
            </Field>
          </div>
          <Field label="Headers" hint="One per line · format: key: value">
            <textarea
              value={webhookHeaders}
              onChange={(e) => setWebhookHeaders(e.target.value)}
              rows={3}
              placeholder="Authorization: Bearer …"
              className={cn(textAreaClass, "min-h-[64px]")}
            />
          </Field>
          <Field
            label="Body template"
            hint="Optional · leave blank for the default JSON envelope. Supports {{variable}} substitution."
          >
            <textarea
              value={webhookBodyTemplate}
              onChange={(e) => setWebhookBodyTemplate(e.target.value)}
              rows={5}
              className={cn(textAreaClass, "min-h-[80px]")}
            />
          </Field>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delivery — priority, severity filter, event filters, rate limit, retry,
// enabled. All booleans are HeroUI Checkboxes for consistent styling.
// ---------------------------------------------------------------------------

function DeliverySection({
  deliveryPriority,
  setDeliveryPriority,
  severityFilter,
  setSeverityFilter,
  sendOpen,
  setSendOpen,
  sendResolved,
  setSendResolved,
  sendEscalation,
  setSendEscalation,
  rateLimitEnabled,
  setRateLimitEnabled,
  maxPerMinute,
  setMaxPerMinute,
  retryOnFailure,
  setRetryOnFailure,
  enabled,
  setEnabled,
}: {
  deliveryPriority: DeliveryPriority;
  setDeliveryPriority: (v: DeliveryPriority) => void;
  severityFilter: SeverityFilter;
  setSeverityFilter: (v: SeverityFilter) => void;
  sendOpen: boolean;
  setSendOpen: (v: boolean) => void;
  sendResolved: boolean;
  setSendResolved: (v: boolean) => void;
  sendEscalation: boolean;
  setSendEscalation: (v: boolean) => void;
  rateLimitEnabled: boolean;
  setRateLimitEnabled: (v: boolean) => void;
  maxPerMinute: number;
  setMaxPerMinute: (n: number) => void;
  retryOnFailure: boolean;
  setRetryOnFailure: (v: boolean) => void;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}) {
  // The CheckboxGroup's value is a string[] of the currently-checked event
  // keys; on change we mirror it back into the three individual booleans so
  // the API payload stays flat.
  const eventFilterValue = useMemo(() => {
    const out: string[] = [];
    if (sendOpen) out.push("open");
    if (sendResolved) out.push("resolved");
    if (sendEscalation) out.push("escalation");
    return out;
  }, [sendOpen, sendResolved, sendEscalation]);

  const handleEventFilterChange = (v: string[]): void => {
    setSendOpen(v.includes("open"));
    setSendResolved(v.includes("resolved"));
    setSendEscalation(v.includes("escalation"));
  };

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex flex-col gap-5">
      <SectionHead
        icon="solar:bell-bing-outline"
        title="Delivery"
        sub="Routing policy, event filters, and rate limit"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field
          label="Delivery priority"
          hint="Critical bypasses coalescing"
        >
          <FilterDropdown<DeliveryPriority>
            value={deliveryPriority}
            options={[
              { id: "standard", label: "Standard" },
              { id: "critical", label: "Critical" },
            ]}
            onChange={setDeliveryPriority}
            ariaLabel="Delivery priority"
            fullWidth
          />
        </Field>
        <Field
          label="Severity filter"
          hint="Only dispatches at this level or above are sent"
        >
          <FilterDropdown<SeverityFilter>
            value={severityFilter}
            options={[
              { id: "info+", label: "Info and above (everything)" },
              { id: "warning+", label: "Warning and above" },
              { id: "critical", label: "Critical only" },
            ]}
            onChange={setSeverityFilter}
            ariaLabel="Severity filter"
            fullWidth
          />
        </Field>
      </div>

      <div>
        <CheckboxGroup
          value={eventFilterValue}
          onChange={handleEventFilterChange}
          aria-label="Event filters"
          className="!flex-col !gap-2"
        >
          <Label className="!text-[11.5px] !font-medium !text-foreground !mb-1">
            Event filters
          </Label>
          <Checkbox value="open" id="evt-open">
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Content>
              <Label htmlFor="evt-open" className="!text-[12.5px]">
                Incident opened
              </Label>
            </Checkbox.Content>
          </Checkbox>
          <Checkbox value="resolved" id="evt-resolved">
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Content>
              <Label htmlFor="evt-resolved" className="!text-[12.5px]">
                Incident resolved
              </Label>
            </Checkbox.Content>
          </Checkbox>
          <Checkbox value="escalation" id="evt-escalation">
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Content>
              <Label htmlFor="evt-escalation" className="!text-[12.5px]">
                Escalation
              </Label>
            </Checkbox.Content>
          </Checkbox>
        </CheckboxGroup>
      </div>

      <div className="rounded-lg border border-wd-border/40 bg-wd-surface-hover/20 p-3 flex flex-col gap-3">
        <Checkbox
          isSelected={rateLimitEnabled}
          onChange={setRateLimitEnabled}
          id="rate-limit-enabled"
        >
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <Label
              htmlFor="rate-limit-enabled"
              className="!text-[12.5px] !font-medium !text-foreground"
            >
              Rate limit override
            </Label>
            <span className="text-[11px] text-wd-muted">
              Cap dispatches per minute for this channel
            </span>
          </Checkbox.Content>
        </Checkbox>
        {rateLimitEnabled && (
          <Field label="Max per minute">
            <input
              type="number"
              min={1}
              max={10000}
              value={maxPerMinute}
              onChange={(e) =>
                setMaxPerMinute(Math.max(1, Number(e.target.value) || 1))
              }
              className={inputClass}
            />
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Checkbox
          isSelected={retryOnFailure}
          onChange={setRetryOnFailure}
          id="retry-on-failure"
        >
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <Label htmlFor="retry-on-failure" className="!text-[12.5px]">
              Retry on failure
            </Label>
            <span className="text-[11px] text-wd-muted">
              Default backoff: 2s / 8s / 30s
            </span>
          </Checkbox.Content>
        </Checkbox>
        <Checkbox isSelected={enabled} onChange={setEnabled} id="enabled">
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <Label htmlFor="enabled" className="!text-[12.5px]">
              Enabled
            </Label>
            <span className="text-[11px] text-wd-muted">
              When off, this channel is kept but receives no dispatches
            </span>
          </Checkbox.Content>
        </Checkbox>
      </div>
    </div>
  );
}
