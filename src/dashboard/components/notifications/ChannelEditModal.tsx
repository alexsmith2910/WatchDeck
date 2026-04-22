/**
 * Channel edit modal (§4.2) — create + update + delete.
 *
 * One form covers every channel type. Type is chosen on create and frozen
 * afterwards (matching the backend: we never re-assign a channel's type).
 */
import { useEffect, useState } from 'react'
import {
  AlertDialog,
  Button,
  Checkbox,
  CheckboxGroup,
  Dropdown,
  FieldError,
  Input,
  Label,
  Spinner,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../../hooks/useApi'
import { useModules } from '../../hooks/useModules'
import { toast } from '../../ui/toast'
import type { ApiChannel, ChannelType, DeliveryPriority, SeverityFilter } from '../../types/notifications'
import { CHANNEL_TYPE_ICON, CHANNEL_TYPE_LABEL } from '../../types/notifications'

/** Browser-reported IANA timezone, or UTC on exotic runtimes where it throws. */
function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface Props {
  open: boolean
  channel: ApiChannel | null        // null → create
  onClose: () => void
  onSaved: (ch: ApiChannel) => void
  onDeleted?: (id: string) => void
}

interface FormState {
  type: ChannelType
  name: string
  deliveryPriority: DeliveryPriority
  enabled: boolean
  severityFilter: SeverityFilter
  sendOpen: boolean
  sendResolved: boolean
  sendEscalation: boolean
  quietHoursEnabled: boolean
  quietStart: string
  quietEnd: string
  quietTz: string
  rateLimitEnabled: boolean
  maxPerMinute: number
  retryOnFailure: boolean

  // per-type
  discordTransport: 'webhook' | 'bot'
  discordWebhookUrl: string
  discordChannelId: string
  discordGuildId: string
  discordUsername: string
  discordAvatarUrl: string
  slackWebhookUrl: string
  slackChannelId: string
  slackWorkspaceName: string
  emailEndpoint: string
  emailRecipients: string // CSV in form
  webhookUrl: string
  webhookMethod: 'POST' | 'PUT' | 'PATCH'
  webhookHeaders: string // KV lines "key: value"
  webhookBodyTemplate: string
}

function defaultForm(): FormState {
  return {
    type: 'discord',
    name: '',
    deliveryPriority: 'standard',
    enabled: true,
    severityFilter: 'warning+',
    sendOpen: true,
    sendResolved: true,
    sendEscalation: true,
    quietHoursEnabled: false,
    quietStart: '22:00',
    quietEnd: '08:00',
    quietTz: detectTimeZone(),
    rateLimitEnabled: false,
    maxPerMinute: 30,
    retryOnFailure: true,

    discordTransport: 'webhook',
    discordWebhookUrl: '',
    discordChannelId: '',
    discordGuildId: '',
    discordUsername: '',
    discordAvatarUrl: '',
    slackWebhookUrl: '',
    slackChannelId: '',
    slackWorkspaceName: '',
    emailEndpoint: '',
    emailRecipients: '',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookHeaders: '',
    webhookBodyTemplate: '',
  }
}

function fromChannel(ch: ApiChannel): FormState {
  const f = defaultForm()
  f.type = ch.type
  f.name = ch.name
  f.deliveryPriority = ch.deliveryPriority
  f.enabled = ch.enabled
  f.severityFilter = ch.severityFilter
  f.sendOpen = ch.eventFilters.sendOpen
  f.sendResolved = ch.eventFilters.sendResolved
  f.sendEscalation = ch.eventFilters.sendEscalation
  f.quietHoursEnabled = !!ch.quietHours
  f.quietStart = ch.quietHours?.start ?? f.quietStart
  f.quietEnd = ch.quietHours?.end ?? f.quietEnd
  f.quietTz = ch.quietHours?.tz ?? f.quietTz
  f.rateLimitEnabled = !!ch.rateLimit
  f.maxPerMinute = ch.rateLimit?.maxPerMinute ?? f.maxPerMinute
  f.retryOnFailure = ch.retryOnFailure
  f.discordTransport = ch.discordTransport ?? 'webhook'
  f.discordWebhookUrl = ch.discordWebhookUrl ?? ''
  f.discordChannelId = ch.discordChannelId ?? ''
  f.discordGuildId = ch.discordGuildId ?? ''
  f.discordUsername = ch.discordUsername ?? ''
  f.discordAvatarUrl = ch.discordAvatarUrl ?? ''
  f.slackWebhookUrl = ch.slackWebhookUrl ?? ''
  f.slackChannelId = ch.slackChannelId ?? ''
  f.slackWorkspaceName = ch.slackWorkspaceName ?? ''
  f.emailEndpoint = ch.emailEndpoint ?? ''
  f.emailRecipients = (ch.emailRecipients ?? []).join(', ')
  f.webhookUrl = ch.webhookUrl ?? ''
  f.webhookMethod = ch.webhookMethod ?? 'POST'
  f.webhookHeaders = Object.entries(ch.webhookHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  f.webhookBodyTemplate = ch.webhookBodyTemplate ?? ''
  return f
}

function parseKV(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)\s*$/)
    if (m) out[m[1]!.trim()] = m[2]!.trim()
  }
  return out
}

function toPayload(f: FormState, isCreate: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: f.name.trim(),
    deliveryPriority: f.deliveryPriority,
    enabled: f.enabled,
    severityFilter: f.severityFilter,
    eventFilters: {
      sendOpen: f.sendOpen,
      sendResolved: f.sendResolved,
      sendEscalation: f.sendEscalation,
    },
    quietHours: f.quietHoursEnabled
      ? { start: f.quietStart, end: f.quietEnd, tz: f.quietTz }
      : null,
    rateLimit: f.rateLimitEnabled ? { maxPerMinute: f.maxPerMinute } : null,
    retryOnFailure: f.retryOnFailure,
  }
  if (isCreate) base.type = f.type

  switch (f.type) {
    case 'discord':
      base.discordTransport = f.discordTransport
      if (f.discordTransport === 'webhook') {
        if (f.discordWebhookUrl) base.discordWebhookUrl = f.discordWebhookUrl.trim()
        if (f.discordUsername) base.discordUsername = f.discordUsername.trim()
        if (f.discordAvatarUrl) base.discordAvatarUrl = f.discordAvatarUrl.trim()
      } else {
        if (f.discordChannelId) base.discordChannelId = f.discordChannelId.trim()
        if (f.discordGuildId) base.discordGuildId = f.discordGuildId.trim()
      }
      break
    case 'slack':
      if (f.slackWebhookUrl) base.slackWebhookUrl = f.slackWebhookUrl.trim()
      if (f.slackChannelId) base.slackChannelId = f.slackChannelId.trim()
      if (f.slackWorkspaceName) base.slackWorkspaceName = f.slackWorkspaceName.trim()
      break
    case 'email':
      if (f.emailEndpoint) base.emailEndpoint = f.emailEndpoint.trim()
      base.emailRecipients = f.emailRecipients
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
      break
    case 'webhook':
      if (f.webhookUrl) base.webhookUrl = f.webhookUrl.trim()
      base.webhookMethod = f.webhookMethod
      base.webhookHeaders = parseKV(f.webhookHeaders)
      if (f.webhookBodyTemplate) base.webhookBodyTemplate = f.webhookBodyTemplate
      break
  }
  return base
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-wd-muted">{children}</span>
  )
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-wd-muted/60 leading-snug">{children}</span>
}

function Select<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  className?: string
}) {
  const selected = options.find((o) => o.value === value)?.label ?? '—'
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          className={cn(
            'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
            'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
            className,
          )}
        >
          <span className="text-foreground truncate">{selected}</span>
          <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted shrink-0 ml-2" />
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="!min-w-[220px]">
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([value])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0]
            if (sel != null) onChange(String(sel) as T)
          }}
        >
          {options.map((opt) => (
            <Dropdown.Item key={opt.value} id={opt.value} className="!text-xs">
              {opt.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

function FilterCheckbox({ value, label }: { value: string; label: string }) {
  const id = `evt-${value}`
  return (
    <Checkbox id={id} value={value}>
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
      <Checkbox.Content>
        <Label htmlFor={id} className="!text-xs">{label}</Label>
      </Checkbox.Content>
    </Checkbox>
  )
}

function SwitchRow({
  isSelected,
  onChange,
  title,
  description,
}: {
  isSelected: boolean
  onChange: (v: boolean) => void
  title: string
  description?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {description && <span className="text-[11px] text-wd-muted/60 leading-snug">{description}</span>}
      </div>
      <Switch isSelected={isSelected} onChange={onChange} size="sm" className="shrink-0 mt-0.5">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch>
    </div>
  )
}

const TYPE_OPTIONS: { value: ChannelType; label: string; icon: string }[] = [
  { value: 'discord', label: 'Discord', icon: CHANNEL_TYPE_ICON.discord },
  { value: 'slack',   label: 'Slack',   icon: CHANNEL_TYPE_ICON.slack },
  { value: 'email',   label: 'Email',   icon: CHANNEL_TYPE_ICON.email },
  { value: 'webhook', label: 'Webhook', icon: CHANNEL_TYPE_ICON.webhook },
]

// ───────────────────────────────────────────────────────────────────────────

export function ChannelEditModal({ open, channel, onClose, onSaved, onDeleted }: Props) {
  const { request } = useApi()
  const { modules } = useModules()
  const [form, setForm] = useState<FormState>(defaultForm)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCreate = channel === null

  // Which channel types are currently selectable on create. Discord stays
  // enabled regardless of modules.discord because the webhook transport does
  // not require the Discord module — it's a plain HTTPS POST. Only the bot
  // transport is gated (see the Discord transport block below).
  const typeDisabled: Record<ChannelType, string | null> = {
    discord: null,
    slack: modules.slack ? null : 'Enable modules.slack in watchdeck.config.js to use Slack channels.',
    email: null,
    webhook: null,
  }
  const discordBotDisabled = !modules.discord

  useEffect(() => {
    if (!open) return
    setError(null)
    const next = channel ? fromChannel(channel) : defaultForm()
    // If the default/preselected type isn't available on create, fall back
    // to the first type that is (discord/webhook/email are always on).
    if (!channel && typeDisabled[next.type]) {
      const firstEnabled = (['discord', 'webhook', 'email', 'slack'] as ChannelType[])
        .find((t) => !typeDisabled[t])
      if (firstEnabled) next.type = firstEnabled
    }
    setForm(next)
    // Intentionally exclude typeDisabled — it's a stable derivation of
    // `modules`, which this effect doesn't need to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel])

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    setError(null)
    if (!form.name.trim()) {
      setError('Name is required')
      return
    }
    setSaving(true)
    try {
      const payload = toPayload(form, isCreate)
      const res = await request<{ data: ApiChannel }>(
        isCreate ? '/notifications/channels' : `/notifications/channels/${channel!._id}`,
        { method: isCreate ? 'POST' : 'PUT', body: payload },
      )
      if (res.status >= 400 || !res.data?.data) {
        const msg = (res.data as unknown as { error?: { message?: string } })?.error?.message
          ?? `Save failed (HTTP ${res.status})`
        setError(msg)
        toast.error('Channel Save Failed', { description: msg })
        return
      }
      toast.success(isCreate ? 'Channel Created' : 'Channel Saved', {
        description: res.data.data.name,
      })
      onSaved(res.data.data)
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      setError(msg)
      toast.error('Channel Save Failed', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    if (!channel) return
    setTesting(true)
    try {
      const res = await request<{ data: { ok: boolean; reason?: string } }>(
        `/notifications/channels/${channel._id}/test`,
        { method: 'POST' },
      )
      const data = res.data?.data
      if (res.status >= 400) {
        toast.error('Test Failed', { description: `HTTP ${res.status}` })
      } else if (data?.ok) {
        toast.success('Test Dispatched', { description: channel.name })
      } else {
        toast.error('Test Failed', { description: data?.reason ?? 'No reason given' })
      }
    } catch (e) {
      toast.error('Test Failed', { description: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setTesting(false)
    }
  }

  const del = async () => {
    if (!channel) return
    if (!confirm(`Delete channel "${channel.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      const res = await request(`/notifications/channels/${channel._id}`, { method: 'DELETE' })
      if (res.status >= 400) {
        toast.error('Delete Failed', { description: `HTTP ${res.status}` })
        return
      }
      toast.success('Channel Deleted', { description: channel.name })
      onDeleted?.(channel._id)
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog.Backdrop
      isOpen={open}
      onOpenChange={(o) => { if (!o) onClose() }}
      isDismissable
      isKeyboardDismissDisabled={false}
      variant="opaque"
    >
      <AlertDialog.Container size="lg" placement="center">
        <AlertDialog.Dialog
          aria-label={isCreate ? 'New notification channel' : `Edit ${channel?.name ?? 'channel'}`}
          className="!p-0 !max-h-[90vh] !w-full sm:!w-[640px] !max-w-[94vw] !flex !flex-col !bg-wd-surface"
        >
          <AlertDialog.Header className="!px-5 !py-4 !border-b !border-wd-border/60 !flex !items-start !justify-between !gap-3">
            <div className="flex-1 min-w-0">
              <AlertDialog.Heading className="!text-sm !font-semibold !text-foreground">
                {isCreate ? 'New Notification Channel' : `Edit — ${channel!.name}`}
              </AlertDialog.Heading>
              <p className="text-[11px] text-wd-muted mt-0.5">
                {isCreate ? 'Channel type cannot be changed after creation.' : CHANNEL_TYPE_LABEL[form.type]}
              </p>
            </div>
            <AlertDialog.CloseTrigger className="!h-7 !w-7 !rounded-md !text-wd-muted hover:!text-foreground hover:!bg-wd-surface-hover/60 !shrink-0">
              <Icon icon="solar:close-circle-linear" width={20} />
            </AlertDialog.CloseTrigger>
          </AlertDialog.Header>

          <AlertDialog.Body className="!flex-1 !overflow-y-auto !px-5 !py-4 !flex !flex-col !gap-5 wd-scroll-thin">
            {/* Type picker (create only) */}
            {isCreate ? (
              <div className="flex flex-col gap-2">
                <FieldLabel>Channel Type</FieldLabel>
                <ToggleButtonGroup
                  selectionMode="single"
                  selectedKeys={new Set([form.type])}
                  onSelectionChange={(keys) => {
                    const sel = [...keys][0] as ChannelType | undefined
                    if (sel && !typeDisabled[sel]) update('type', sel)
                  }}
                  size="sm"
                  className="!w-full"
                >
                  {TYPE_OPTIONS.map((t) => {
                    const disabledReason = typeDisabled[t.value]
                    return (
                      <ToggleButton
                        key={t.value}
                        id={t.value}
                        isDisabled={!!disabledReason}
                        title={disabledReason ?? undefined}
                        className={cn(
                          '!flex-1 !text-xs !gap-1.5',
                          'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
                          'data-[disabled=true]:!opacity-50 data-[disabled=true]:!cursor-not-allowed',
                        )}
                      >
                        <Icon icon={t.icon} width={16} />
                        {t.label}
                      </ToggleButton>
                    )
                  })}
                </ToggleButtonGroup>
                {Object.values(typeDisabled).some(Boolean) && (
                  <HelpText>
                    {Object.entries(typeDisabled)
                      .filter(([, reason]) => !!reason)
                      .map(([, reason]) => reason)
                      .join(' · ')}
                  </HelpText>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs bg-wd-surface-hover/30 border border-wd-border/40 rounded-lg px-3 py-2">
                <Icon icon={CHANNEL_TYPE_ICON[form.type]} width={16} />
                <span className="text-wd-muted">{CHANNEL_TYPE_LABEL[form.type]} · type cannot be changed</span>
              </div>
            )}

            {/* Module-off banner for existing channels whose backing module is disabled */}
            {!isCreate && form.type === 'slack' && !modules.slack && (
              <div className="bg-wd-warning/10 border border-wd-warning/40 rounded-lg px-3 py-2 text-xs text-wd-warning">
                The Slack module is disabled — dispatches to this channel will be suppressed. Set <code>modules.slack</code> to <code>true</code> in <code>watchdeck.config.js</code> and restart to resume delivery.
              </div>
            )}
            {!isCreate && form.type === 'discord' && form.discordTransport === 'bot' && !modules.discord && (
              <div className="bg-wd-warning/10 border border-wd-warning/40 rounded-lg px-3 py-2 text-xs text-wd-warning">
                The Discord module is disabled — dispatches via the bot transport will be suppressed. Switch to the Webhook transport or enable <code>modules.discord</code> in <code>watchdeck.config.js</code>.
              </div>
            )}

            {/* Name */}
            <TextField
              isInvalid={!!error && !form.name.trim()}
              isRequired
              value={form.name}
              onChange={(v) => update('name', v)}
            >
              <Label className="!text-xs !font-medium !text-wd-muted">Name</Label>
              <Input placeholder="e.g. #alerts-critical" className="!text-sm" />
            </TextField>

            {/* Delivery priority + severity filter */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <FieldLabel>Delivery Priority</FieldLabel>
                <Select<DeliveryPriority>
                  value={form.deliveryPriority}
                  onChange={(v) => update('deliveryPriority', v)}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'critical', label: 'Critical — bypasses coalescing & quiet hours' },
                  ]}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>Severity Filter</FieldLabel>
                <Select<SeverityFilter>
                  value={form.severityFilter}
                  onChange={(v) => update('severityFilter', v)}
                  options={[
                    { value: 'info+',    label: 'Info and above (everything)' },
                    { value: 'warning+', label: 'Warning and above' },
                    { value: 'critical', label: 'Critical only' },
                  ]}
                />
              </div>
            </div>

            {/* Event filters */}
            <div className="flex flex-col gap-2">
              <FieldLabel>Event Filters</FieldLabel>
              <CheckboxGroup
                value={[
                  ...(form.sendOpen ? ['open'] : []),
                  ...(form.sendResolved ? ['resolved'] : []),
                  ...(form.sendEscalation ? ['escalation'] : []),
                ]}
                onChange={(v) => {
                  update('sendOpen', v.includes('open'))
                  update('sendResolved', v.includes('resolved'))
                  update('sendEscalation', v.includes('escalation'))
                }}
                orientation="horizontal"
                aria-label="Event filters"
                className="flex-wrap gap-2"
              >
                <FilterCheckbox value="open" label="Incident Opened" />
                <FilterCheckbox value="resolved" label="Incident Resolved" />
                <FilterCheckbox value="escalation" label="Escalation" />
              </CheckboxGroup>
            </div>

            {/* Enabled / Retry toggles */}
            <div className="bg-wd-surface-hover/20 border border-wd-border/40 rounded-lg p-3 flex flex-col gap-3">
              <SwitchRow
                isSelected={form.enabled}
                onChange={(v) => update('enabled', v)}
                title="Enabled"
                description="This channel receives dispatches"
              />
              <SwitchRow
                isSelected={form.retryOnFailure}
                onChange={(v) => update('retryOnFailure', v)}
                title="Retry on Failure"
                description="Default backoff: 2s / 8s / 30s"
              />
            </div>

            {/* Quiet hours */}
            <div className="bg-wd-surface-hover/20 border border-wd-border/40 rounded-lg p-3 flex flex-col gap-3">
              <SwitchRow
                isSelected={form.quietHoursEnabled}
                onChange={(v) => update('quietHoursEnabled', v)}
                title="Quiet Hours"
                description="Suppress non-critical dispatches during this window"
              />
              {form.quietHoursEnabled && (
                <div className="grid grid-cols-3 gap-2">
                  <TextField value={form.quietStart} onChange={(v) => update('quietStart', v)}>
                    <Label className="!text-xs !font-medium !text-wd-muted">Start</Label>
                    <Input type="time" className="!text-sm !font-mono" />
                  </TextField>
                  <TextField value={form.quietEnd} onChange={(v) => update('quietEnd', v)}>
                    <Label className="!text-xs !font-medium !text-wd-muted">End</Label>
                    <Input type="time" className="!text-sm !font-mono" />
                  </TextField>
                  <TextField value={form.quietTz} onChange={(v) => update('quietTz', v)}>
                    <Label className="!text-xs !font-medium !text-wd-muted">Timezone</Label>
                    <Input placeholder="Europe/London" className="!text-sm !font-mono" />
                  </TextField>
                </div>
              )}
            </div>

            {/* Rate limit */}
            <div className="bg-wd-surface-hover/20 border border-wd-border/40 rounded-lg p-3 flex flex-col gap-3">
              <SwitchRow
                isSelected={form.rateLimitEnabled}
                onChange={(v) => update('rateLimitEnabled', v)}
                title="Rate Limit Override"
                description="Cap dispatches per minute for this channel"
              />
              {form.rateLimitEnabled && (
                <TextField
                  value={String(form.maxPerMinute)}
                  onChange={(v) => update('maxPerMinute', Math.max(1, Number(v) || 1))}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">Max Per Minute</Label>
                  <Input type="number" min={1} max={10000} className="!text-sm !font-mono" />
                </TextField>
              )}
            </div>

            {/* ────────── Type-specific block ────────── */}
            {form.type === 'discord' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>Transport</FieldLabel>
                  <Select<'webhook' | 'bot'>
                    value={form.discordTransport}
                    onChange={(v) => {
                      if (v === 'bot' && discordBotDisabled) return
                      update('discordTransport', v)
                    }}
                    options={[
                      { value: 'webhook', label: 'Discord Webhook' },
                      {
                        value: 'bot',
                        label: discordBotDisabled
                          ? 'Discord Bot — enable modules.discord'
                          : 'Discord Bot (coming soon)',
                      },
                    ]}
                  />
                  <HelpText>
                    How WatchDeck talks to Discord. Webhook is simplest — paste a URL from Discord's Integrations settings. {discordBotDisabled ? 'Bot transport is unavailable because modules.discord is off.' : ''}
                  </HelpText>
                </div>

                {form.discordTransport === 'webhook' && (
                  <>
                    <TextField
                      value={form.discordWebhookUrl}
                      onChange={(v) => update('discordWebhookUrl', v)}
                    >
                      <Label className="!text-xs !font-medium !text-wd-muted">Webhook URL</Label>
                      <Input placeholder="https://discord.com/api/webhooks/..." className="!text-sm !font-mono" />
                      <HelpText>
                        Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL
                      </HelpText>
                    </TextField>
                    <div className="grid grid-cols-2 gap-3">
                      <TextField
                        value={form.discordUsername}
                        onChange={(v) => update('discordUsername', v)}
                      >
                        <Label className="!text-xs !font-medium !text-wd-muted">Author Name (optional)</Label>
                        <Input placeholder="WatchDeck" className="!text-sm" />
                        <HelpText>Overrides the webhook's default name.</HelpText>
                      </TextField>
                      <TextField
                        value={form.discordAvatarUrl}
                        onChange={(v) => update('discordAvatarUrl', v)}
                      >
                        <Label className="!text-xs !font-medium !text-wd-muted">Author Avatar URL (optional)</Label>
                        <Input placeholder="https://…" className="!text-sm !font-mono" />
                        <HelpText>Must be an https image URL.</HelpText>
                      </TextField>
                    </div>
                  </>
                )}

                {form.discordTransport === 'bot' && (
                  <div className="bg-wd-warning/10 border border-wd-warning/40 rounded-lg px-3 py-2 text-xs text-wd-warning">
                    Discord bot transport is not implemented yet — switch to the Webhook transport to send messages today.
                  </div>
                )}
              </div>
            )}

            {form.type === 'slack' && (
              <div className="flex flex-col gap-3">
                <TextField
                  value={form.slackWebhookUrl}
                  onChange={(v) => update('slackWebhookUrl', v)}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">Slack Webhook URL</Label>
                  <Input placeholder="https://hooks.slack.com/services/..." className="!text-sm !font-mono" />
                </TextField>
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    value={form.slackChannelId}
                    onChange={(v) => update('slackChannelId', v)}
                  >
                    <Label className="!text-xs !font-medium !text-wd-muted">Channel ID (optional)</Label>
                    <Input className="!text-sm !font-mono" />
                  </TextField>
                  <TextField
                    value={form.slackWorkspaceName}
                    onChange={(v) => update('slackWorkspaceName', v)}
                  >
                    <Label className="!text-xs !font-medium !text-wd-muted">Workspace (optional)</Label>
                    <Input className="!text-sm" />
                  </TextField>
                </div>
              </div>
            )}

            {form.type === 'email' && (
              <div className="flex flex-col gap-3">
                <TextField
                  value={form.emailEndpoint}
                  onChange={(v) => update('emailEndpoint', v)}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">SMTP Endpoint</Label>
                  <Input placeholder="smtp://…" className="!text-sm !font-mono" />
                </TextField>
                <TextField
                  value={form.emailRecipients}
                  onChange={(v) => update('emailRecipients', v)}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">Recipients</Label>
                  <TextArea
                    rows={2}
                    placeholder="ops@example.com, oncall@example.com"
                    className="!text-sm !font-mono"
                  />
                  <HelpText>Comma- or newline-separated</HelpText>
                </TextField>
              </div>
            )}

            {form.type === 'webhook' && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <TextField
                    value={form.webhookUrl}
                    onChange={(v) => update('webhookUrl', v)}
                  >
                    <Label className="!text-xs !font-medium !text-wd-muted">Webhook URL</Label>
                    <Input placeholder="https://…" className="!text-sm !font-mono" />
                  </TextField>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Method</FieldLabel>
                    <Select<'POST' | 'PUT' | 'PATCH'>
                      value={form.webhookMethod}
                      onChange={(v) => update('webhookMethod', v)}
                      options={[
                        { value: 'POST',  label: 'POST' },
                        { value: 'PUT',   label: 'PUT' },
                        { value: 'PATCH', label: 'PATCH' },
                      ]}
                    />
                  </div>
                </div>
                <TextField
                  value={form.webhookHeaders}
                  onChange={(v) => update('webhookHeaders', v)}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">Headers</Label>
                  <TextArea
                    rows={3}
                    placeholder="Authorization: Bearer …"
                    className="!text-sm !font-mono"
                  />
                  <HelpText>One per line — format: <code>key: value</code></HelpText>
                </TextField>
                <TextField
                  value={form.webhookBodyTemplate}
                  onChange={(v) => update('webhookBodyTemplate', v)}
                >
                  <Label className="!text-xs !font-medium !text-wd-muted">Body Template</Label>
                  <TextArea
                    rows={5}
                    className="!text-sm !font-mono"
                  />
                  <HelpText>Handlebars-style variables available at dispatch time.</HelpText>
                </TextField>
              </div>
            )}

            {error && (
              <div className="bg-wd-danger/10 border border-wd-danger/40 rounded-lg px-3 py-2 text-xs text-wd-danger">
                <FieldError>{error}</FieldError>
              </div>
            )}
          </AlertDialog.Body>

          <AlertDialog.Footer className="!px-5 !py-3 !border-t !border-wd-border/60 !flex !items-center !justify-between">
            <div>
              {!isCreate && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="!text-xs !text-wd-danger"
                  onPress={() => void del()}
                  isDisabled={deleting}
                >
                  {deleting ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Icon icon="solar:trash-bin-minimalistic-linear" width={16} className="mr-1" />
                      Delete
                    </>
                  )}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!isCreate && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="!text-xs"
                  onPress={() => void sendTest()}
                  isDisabled={testing}
                >
                  {testing ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Icon icon="solar:test-tube-linear" width={16} className="mr-1" />
                      Test
                    </>
                  )}
                </Button>
              )}
              <Button size="sm" variant="ghost" className="!text-xs" onPress={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="!text-xs !bg-wd-primary !text-wd-primary-foreground"
                onPress={() => void save()}
                isDisabled={saving}
              >
                {saving ? <Spinner size="sm" /> : (isCreate ? 'Create Channel' : 'Save')}
              </Button>
            </div>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}
