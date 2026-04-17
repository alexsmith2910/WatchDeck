import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  TextField,
  Input,
  Label,
  FieldError,
  Dropdown,
  Switch,
  Checkbox,
  CheckboxGroup,
  RadioGroup,
  Radio,
  Separator,
  Spinner,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useApi } from '../../hooks/useApi'
import ChipInput from '../ChipInput'
import KeyValueEditor, { type KeyValuePair } from '../KeyValueEditor'
import type { ApiEndpoint } from '../../types/api'

// ---------------------------------------------------------------------------
// Option arrays (matching AddEndpointPage)
// ---------------------------------------------------------------------------

const INTERVAL_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
]

const TIMEOUT_OPTIONS = [
  { value: 1_000, label: '1 second' },
  { value: 3_000, label: '3 seconds' },
  { value: 5_000, label: '5 seconds' },
  { value: 10_000, label: '10 seconds' },
  { value: 15_000, label: '15 seconds' },
  { value: 30_000, label: '30 seconds' },
  { value: 60_000, label: '60 seconds' },
]

const FAILURE_OPTIONS = Array.from({ length: 10 }, (_, i) => ({
  value: i + 1,
  label: `${i + 1} failure${i > 0 ? 's' : ''}`,
}))

const COOLDOWN_OPTIONS = [
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1_800, label: '30 minutes' },
  { value: 3_600, label: '1 hour' },
  { value: 7_200, label: '2 hours' },
]

const ESCALATION_OPTIONS = [
  { value: 0, label: 'Disabled' },
  { value: 900, label: '15 minutes' },
  { value: 1_800, label: '30 minutes' },
  { value: 3_600, label: '1 hour' },
  { value: 7_200, label: '2 hours' },
  { value: 21_600, label: '6 hours' },
  { value: 43_200, label: '12 hours' },
  { value: 86_400, label: '24 hours' },
]

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const LATENCY_OPTIONS = [
  { value: 500, label: '500ms' },
  { value: 1_000, label: '1 second' },
  { value: 2_000, label: '2 seconds' },
  { value: 3_000, label: '3 seconds' },
  { value: 5_000, label: '5 seconds' },
  { value: 10_000, label: '10 seconds' },
  { value: 15_000, label: '15 seconds' },
  { value: 30_000, label: '30 seconds' },
]

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  url: z.string().optional(),
  method: z.string().optional(),
  expectedStatusCodes: z.array(z.number()).optional(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  checkInterval: z.number(),
  timeout: z.number(),
  latencyThreshold: z.number(),
  failureThreshold: z.number(),
  sslWarningDays: z.number(),
  recoveryAlert: z.boolean(),
  alertCooldown: z.number(),
  escalationDelay: z.number(),
  escalationChannelId: z.string().optional(),
  notificationChannelIds: z.array(z.string()),
})

type SettingsFormValues = z.infer<typeof settingsSchema>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationChannel {
  _id: string
  type: 'discord' | 'slack' | 'email'
  name: string
}

interface SettingsTabProps {
  endpoint: ApiEndpoint
  onUpdate: (ep: ApiEndpoint) => void
  onDelete: () => void
  onToggle: () => void
}

// ---------------------------------------------------------------------------
// InfoTip — hover tooltip for field explanations
// ---------------------------------------------------------------------------

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip delay={200} closeDelay={0}>
      <TooltipTrigger>
        <span className="inline-flex cursor-help ml-1">
          <Icon icon="solar:info-circle-linear" width={13} className="text-wd-muted/50" />
        </span>
      </TooltipTrigger>
      <TooltipContent placement="top" className="px-2.5 py-1.5 text-[11px] max-w-[280px] text-center leading-snug font-medium [word-break:normal] [overflow-wrap:normal]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// FormSelect
// ---------------------------------------------------------------------------

function FormSelect({
  label,
  options,
  value,
  onChange,
  description,
  tip,
}: {
  label: string
  options: { value: number; label: string }[]
  value: number
  onChange: (value: number) => void
  description?: string
  tip?: string
}) {
  const selectedLabel = options.find((o) => o.value === value)?.label ?? '—'

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-wd-muted">
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <Dropdown>
        <Dropdown.Trigger>
          <div
            className={cn(
              'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
              'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
            )}
          >
            <span className="text-foreground">{selectedLabel}</span>
            <Icon icon="solar:alt-arrow-down-linear" width={14} className="text-wd-muted" />
          </div>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom start" className="!min-w-[180px]">
          <Dropdown.Menu
            selectionMode="single"
            selectedKeys={new Set([String(value)])}
            onSelectionChange={(keys: Selection) => {
              const sel = [...keys][0]
              if (sel != null) onChange(Number(sel))
            }}
          >
            {options.map((opt) => (
              <Dropdown.Item key={String(opt.value)} id={String(opt.value)} className="!text-xs">
                {opt.label}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {description && <span className="text-[11px] text-wd-muted/60">{description}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SettingsTab
// ---------------------------------------------------------------------------

export default function SettingsTab({ endpoint, onUpdate, onDelete, onToggle }: SettingsTabProps) {
  const navigate = useNavigate()
  const { request } = useApi()

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    request<{ data: NotificationChannel[] }>('/notifications/channels')
      .then((res) => setChannels(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setChannelsLoading(false))
  }, [request])

  const defaultValues: SettingsFormValues = {
    name: endpoint.name,
    url: endpoint.url,
    method: endpoint.method,
    expectedStatusCodes: endpoint.expectedStatusCodes,
    headers: endpoint.headers
      ? Object.entries(endpoint.headers).map(([key, value]) => ({ key, value }))
      : [],
    host: endpoint.host,
    port: endpoint.port,
    checkInterval: endpoint.checkInterval,
    timeout: endpoint.timeout,
    latencyThreshold: endpoint.latencyThreshold,
    failureThreshold: endpoint.failureThreshold,
    sslWarningDays: endpoint.sslWarningDays,
    recoveryAlert: endpoint.recoveryAlert,
    alertCooldown: endpoint.alertCooldown,
    escalationDelay: endpoint.escalationDelay,
    escalationChannelId: endpoint.escalationChannelId,
    notificationChannelIds: endpoint.notificationChannelIds,
  }

  const {
    control,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues,
    mode: 'onBlur',
  })

  const escalationDelay = watch('escalationDelay')

  useEffect(() => {
    reset(defaultValues)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint._id])

  const onSubmit = async (data: SettingsFormValues) => {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    const body: Record<string, unknown> = {
      name: data.name,
      checkInterval: data.checkInterval,
      timeout: data.timeout,
      latencyThreshold: data.latencyThreshold,
      failureThreshold: data.failureThreshold,
      sslWarningDays: data.sslWarningDays,
      recoveryAlert: data.recoveryAlert,
      alertCooldown: data.alertCooldown,
      escalationDelay: data.escalationDelay,
      notificationChannelIds: data.notificationChannelIds,
    }

    if (data.escalationDelay > 0 && data.escalationChannelId) {
      body.escalationChannelId = data.escalationChannelId
    }

    if (endpoint.type === 'http') {
      body.url = data.url
      body.method = data.method
      body.expectedStatusCodes = data.expectedStatusCodes
      const headerObj: Record<string, string> = {}
      for (const h of data.headers ?? []) {
        if (h.key.trim()) headerObj[h.key.trim()] = h.value
      }
      if (Object.keys(headerObj).length > 0) body.headers = headerObj
    } else {
      body.host = data.host
      body.port = data.port
    }

    try {
      const res = await request<{ data: ApiEndpoint }>(`/endpoints/${endpoint._id}`, {
        method: 'PUT',
        body,
      })
      if (res.status >= 400) {
        throw new Error(
          (res.data as unknown as { message?: string })?.message ?? `Server returned ${res.status}`,
        )
      }
      onUpdate(res.data.data)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    const res = await request(`/endpoints/${endpoint._id}`, { method: 'DELETE' })
    setDeleting(false)
    if (res.status < 400 || res.status === 204) {
      onDelete()
      navigate('/endpoints')
    }
  }, [endpoint._id, request, navigate, onDelete])

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* ── Row 1: General (full width) ───────────────────────────── */}
      <SectionCard title="General" icon="solar:info-circle-linear">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Left column */}
          <div className="space-y-4">
            {/* Type (read-only) */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-wd-muted">Type</span>
              <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-wd-surface-hover/30 border border-wd-border/30 text-xs text-wd-muted">
                <Icon
                  icon={
                    endpoint.type === 'http' ? 'solar:global-outline' : 'solar:plug-circle-outline'
                  }
                  width={14}
                />
                {endpoint.type.toUpperCase()}
                <span className="text-[10px] text-wd-muted/60 ml-1">(cannot be changed)</span>
              </div>
            </div>

            {/* Name */}
            <Controller
              name="name"
              control={control}
              render={({ field }) => (
                <TextField isInvalid={!!errors.name} isRequired>
                  <Label className="!text-xs !font-medium !text-wd-muted">Name</Label>
                  <Input {...field} placeholder="e.g. Production API" className="!text-sm" />
                  {errors.name && (
                    <FieldError className="!text-[11px]">{errors.name.message}</FieldError>
                  )}
                </TextField>
              )}
            />

            {/* URL / Host+Port */}
            {endpoint.type === 'http' ? (
              <Controller
                name="url"
                control={control}
                render={({ field }) => (
                  <TextField isRequired>
                    <Label className="!text-xs !font-medium !text-wd-muted">URL</Label>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="https://api.example.com/health"
                      className="!text-sm"
                    />
                  </TextField>
                )}
              />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <Controller
                  name="host"
                  control={control}
                  render={({ field }) => (
                    <TextField isRequired>
                      <Label className="!text-xs !font-medium !text-wd-muted">Host</Label>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        placeholder="db.example.com"
                        className="!text-sm"
                      />
                    </TextField>
                  )}
                />
                <Controller
                  name="port"
                  control={control}
                  render={({ field }) => (
                    <TextField isRequired>
                      <Label className="!text-xs !font-medium !text-wd-muted">Port</Label>
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={field.value ? String(field.value) : ''}
                        onChange={(e) =>
                          field.onChange(e.target.value ? Number(e.target.value) : undefined)
                        }
                        onBlur={field.onBlur}
                        placeholder="5432"
                        className="!text-sm"
                      />
                    </TextField>
                  )}
                />
              </div>
            )}
          </div>

          {/* Right column (HTTP-specific or empty for port) */}
          {endpoint.type === 'http' ? (
            <div className="space-y-4">
              <Controller
                name="method"
                control={control}
                render={({ field }) => (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-wd-muted">
                      Method
                      <InfoTip text="HTTP method used for the health check request" />
                    </span>
                    <Dropdown>
                      <Dropdown.Trigger>
                        <div
                          className={cn(
                            'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
                            'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
                          )}
                        >
                          <span className="text-foreground">{field.value ?? 'GET'}</span>
                          <Icon
                            icon="solar:alt-arrow-down-linear"
                            width={14}
                            className="text-wd-muted"
                          />
                        </div>
                      </Dropdown.Trigger>
                      <Dropdown.Popover placement="bottom start" className="!min-w-[140px]">
                        <Dropdown.Menu
                          selectionMode="single"
                          selectedKeys={new Set([field.value ?? 'GET'])}
                          onSelectionChange={(keys: Selection) => {
                            const sel = [...keys][0]
                            if (sel != null) field.onChange(String(sel))
                          }}
                        >
                          {METHOD_OPTIONS.map((m) => (
                            <Dropdown.Item key={m} id={m} className="!text-xs">
                              {m}
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    </Dropdown>
                  </div>
                )}
              />

              <Controller
                name="expectedStatusCodes"
                control={control}
                render={({ field }) => (
                  <ChipInput
                    label="Expected Status Codes"
                    values={(field.value ?? []).map(String)}
                    onChange={(vals) => field.onChange(vals.map(Number))}
                    placeholder="e.g. 201"
                    description="HTTP response codes that indicate a healthy check"
                    validate={(val) => {
                      const n = Number(val)
                      if (isNaN(n) || !Number.isInteger(n) || n < 100 || n > 599) {
                        return 'Enter a valid HTTP status code (100–599)'
                      }
                      return null
                    }}
                  />
                )}
              />

              <Controller
                name="headers"
                control={control}
                render={({ field }) => (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-wd-muted">
                      Custom Headers
                      <InfoTip text="HTTP headers sent with every check request. Use for Authorization tokens (e.g. Bearer), API keys, or custom Content-Type headers." />
                    </span>
                    <KeyValueEditor
                      pairs={(field.value ?? []) as KeyValuePair[]}
                      onChange={field.onChange}
                    />
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center text-wd-muted/30">
              <Icon icon="solar:plug-circle-outline" width={48} />
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Row 2: Monitoring + Alerts (side by side) ─────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Monitoring" icon="solar:clock-circle-linear">
          <div className="grid grid-cols-2 gap-4">
            <Controller
              name="checkInterval"
              control={control}
              render={({ field }) => (
                <FormSelect
                  label="Check every"
                  options={INTERVAL_OPTIONS}
                  value={field.value}
                  onChange={field.onChange}
                  tip="How frequently health checks are performed against this endpoint"
                />
              )}
            />
            <Controller
              name="timeout"
              control={control}
              render={({ field }) => (
                <FormSelect
                  label="Timeout"
                  options={TIMEOUT_OPTIONS}
                  value={field.value}
                  onChange={field.onChange}
                  tip="Maximum time to wait for a response before the check is marked as failed"
                />
              )}
            />
            <Controller
              name="latencyThreshold"
              control={control}
              render={({ field }) => (
                <FormSelect
                  label="Degraded after"
                  options={LATENCY_OPTIONS}
                  value={field.value}
                  onChange={field.onChange}
                  tip="Response time above this threshold marks the check as 'degraded' instead of 'healthy'"
                />
              )}
            />
            <Controller
              name="failureThreshold"
              control={control}
              render={({ field }) => (
                <FormSelect
                  label="Failure threshold"
                  options={FAILURE_OPTIONS}
                  value={field.value}
                  onChange={field.onChange}
                  tip="Number of consecutive failed checks required before an incident is opened"
                />
              )}
            />
          </div>

          {endpoint.type === 'http' && (
            <>
              <Separator className="!bg-wd-border/20 my-4" />
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-wd-muted">
                  SSL Certificate Warning
                  <InfoTip text="Triggers an alert when the SSL certificate expires within this many days" />
                </span>
                <Controller
                  name="sslWarningDays"
                  control={control}
                  render={({ field }) => (
                    <RadioGroup
                      orientation="horizontal"
                      value={String(field.value)}
                      onChange={(val) => field.onChange(Number(val))}
                      aria-label="SSL warning days"
                      className="!gap-3"
                    >
                      {[7, 14, 30].map((d) => (
                        <Radio
                          key={d}
                          value={String(d)}
                          className={cn(
                            '!text-xs !px-3 !py-1.5 !rounded-lg !border !cursor-pointer',
                            'data-[selected=true]:!border-wd-primary data-[selected=true]:!bg-wd-primary/10',
                            'data-[selected=false]:!border-wd-border/50 data-[selected=false]:!bg-wd-surface-hover/30',
                          )}
                        >
                          {d} days
                        </Radio>
                      ))}
                    </RadioGroup>
                  )}
                />
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard title="Alerts" icon="solar:bell-linear">
          <div className="space-y-4">
            <Controller
              name="recoveryAlert"
              control={control}
              render={({ field }) => (
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">
                      Recovery alert
                      <InfoTip text="Sends a notification when the endpoint recovers from a downtime incident" />
                    </span>
                    <span className="text-[11px] text-wd-muted/60">
                      Notify when endpoint recovers
                    </span>
                  </div>
                  <Switch isSelected={field.value} onChange={field.onChange} size="sm">
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch>
                </div>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <Controller
                name="alertCooldown"
                control={control}
                render={({ field }) => (
                  <FormSelect
                    label="Alert cooldown"
                    options={COOLDOWN_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    tip="Minimum time between repeated alert notifications for the same ongoing incident"
                  />
                )}
              />
              <Controller
                name="escalationDelay"
                control={control}
                render={({ field }) => (
                  <FormSelect
                    label="Escalation delay"
                    options={ESCALATION_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    tip="If the incident isn't resolved within this time, alerts are sent to the escalation channel"
                  />
                )}
              />
            </div>

            {escalationDelay > 0 && channels.length > 0 && (
              <Controller
                name="escalationChannelId"
                control={control}
                render={({ field }) => {
                  const selectedCh = channels.find((c) => c._id === field.value)
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-wd-muted">
                        Escalate to
                        <InfoTip text="Secondary notification channel that receives alerts if the incident is not resolved" />
                      </span>
                      <Dropdown>
                        <Dropdown.Trigger>
                          <div
                            className={cn(
                              'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
                              'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
                            )}
                          >
                            <span className={selectedCh ? 'text-foreground' : 'text-wd-muted/60'}>
                              {selectedCh?.name ?? 'Select a channel'}
                            </span>
                            <Icon
                              icon="solar:alt-arrow-down-linear"
                              width={14}
                              className="text-wd-muted"
                            />
                          </div>
                        </Dropdown.Trigger>
                        <Dropdown.Popover placement="bottom start" className="!min-w-[180px]">
                          <Dropdown.Menu
                            selectionMode="single"
                            selectedKeys={field.value ? new Set([field.value]) : new Set()}
                            onSelectionChange={(keys: Selection) => {
                              const sel = [...keys][0]
                              field.onChange(sel != null ? String(sel) : undefined)
                            }}
                          >
                            {channels.map((ch) => (
                              <Dropdown.Item key={ch._id} id={ch._id} className="!text-xs">
                                <div className="flex items-center gap-2">
                                  <Icon
                                    icon={
                                      ch.type === 'discord'
                                        ? 'simple-icons:discord'
                                        : ch.type === 'slack'
                                          ? 'simple-icons:slack'
                                          : 'solar:letter-outline'
                                    }
                                    width={12}
                                    className="text-wd-muted"
                                  />
                                  {ch.name}
                                </div>
                              </Dropdown.Item>
                            ))}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    </div>
                  )
                }}
              />
            )}
          </div>
        </SectionCard>
      </div>

      {/* ── Row 3: Notifications + Danger Zone (side by side) ─────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Notifications" icon="solar:bell-bing-linear">
          {channelsLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Spinner size="sm" />
              <span className="text-xs text-wd-muted">Loading channels...</span>
            </div>
          ) : channels.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-wd-surface-hover/30 px-3 py-2.5">
              <Icon
                icon="solar:info-circle-outline"
                width={14}
                className="text-wd-muted/60 shrink-0"
              />
              <span className="text-xs text-wd-muted/60">
                No notification channels configured.{' '}
                <span
                  className="text-wd-primary cursor-pointer hover:underline"
                  onClick={() => navigate('/notifications')}
                >
                  Set up in Settings
                </span>
              </span>
            </div>
          ) : (
            <Controller
              name="notificationChannelIds"
              control={control}
              render={({ field }) => (
                <CheckboxGroup
                  value={field.value}
                  onChange={field.onChange}
                  aria-label="Notification channels"
                  className="!gap-2"
                >
                  {channels.map((ch) => (
                    <Checkbox key={ch._id} value={ch._id} className="!text-xs">
                      <div className="flex items-center gap-2">
                        <Icon
                          icon={
                            ch.type === 'discord'
                              ? 'simple-icons:discord'
                              : ch.type === 'slack'
                                ? 'simple-icons:slack'
                                : 'solar:letter-outline'
                          }
                          width={14}
                          className="text-wd-muted"
                        />
                        <span>{ch.name}</span>
                      </div>
                    </Checkbox>
                  ))}
                </CheckboxGroup>
              )}
            />
          )}
        </SectionCard>

        {/* Danger Zone */}
        <div className="bg-wd-surface border border-wd-danger/20 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Icon icon="solar:danger-triangle-linear" width={16} className="text-wd-danger" />
            <h3 className="text-sm font-semibold text-wd-danger">Danger Zone</h3>
          </div>
          <p className="text-xs text-wd-muted/60 mb-4">
            These actions affect the endpoint&apos;s active monitoring state and cannot be easily undone.
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="bordered" className="!text-xs" onPress={onToggle}>
              <Icon
                icon={
                  endpoint.status === 'active' ? 'solar:pause-linear' : 'solar:play-linear'
                }
                width={14}
              />
              {endpoint.status === 'active' ? 'Pause Endpoint' : 'Resume Endpoint'}
            </Button>
            <Button
              size="sm"
              variant="bordered"
              className="!text-xs !border-wd-danger/30 !text-wd-danger"
              onPress={() => setShowDeleteModal(true)}
            >
              <Icon icon="solar:trash-bin-minimalistic-linear" width={14} />
              Delete Endpoint
            </Button>
          </div>
        </div>
      </div>

      {/* ── Save bar ──────────────────────────────────────────────── */}
      {saveError && (
        <div className="flex items-center gap-2 rounded-lg border border-wd-danger/30 bg-wd-danger/5 px-3 py-2">
          <Icon icon="solar:danger-triangle-outline" width={16} className="text-wd-danger shrink-0" />
          <span className="text-xs text-wd-danger">{saveError}</span>
        </div>
      )}

      {saveSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-wd-success/30 bg-wd-success/5 px-3 py-2">
          <Icon icon="solar:check-circle-linear" width={16} className="text-wd-success shrink-0" />
          <span className="text-xs text-wd-success">Settings saved successfully</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 pb-4">
        <Button
          variant="ghost"
          size="sm"
          className="!text-xs !px-4"
          onPress={() => reset(defaultValues)}
          isDisabled={!isDirty || saving}
        >
          Discard Changes
        </Button>
        <Button
          type="submit"
          size="sm"
          className="!bg-wd-primary dark:!bg-wd-primary/50 !text-wd-primary-foreground !text-xs !px-6 !font-medium"
          isDisabled={!isDirty || saving}
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-1" />
              Saving...
            </>
          ) : (
            <>
              <Icon icon="solar:diskette-linear" width={16} className="mr-1" />
              Save Changes
            </>
          )}
        </Button>
      </div>

      {/* ── Delete Modal ──────────────────────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDeleteModal(false)} />
          <div className="relative bg-wd-surface border border-wd-border rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-full bg-wd-danger/10 p-2">
                <Icon
                  icon="solar:trash-bin-minimalistic-linear"
                  width={20}
                  className="text-wd-danger"
                />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Delete Endpoint</h3>
                <p className="text-xs text-wd-muted">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-wd-muted mb-1">
              Are you sure you want to archive{' '}
              <span className="font-medium text-foreground">{endpoint.name}</span>?
            </p>
            <p className="text-xs text-wd-muted/60 mb-6">
              The endpoint will be moved to the archived list. Check history and incident data will
              be preserved.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="bordered"
                className="!text-xs"
                onPress={() => setShowDeleteModal(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="!text-xs !bg-wd-danger !text-white"
                onPress={handleDelete}
                isDisabled={deleting}
              >
                {deleting ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={14} />
                    Archive Endpoint
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  icon,
  children,
}: {
  title: string
  icon: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-wd-surface border border-wd-border/50 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon icon={icon} width={16} className="text-wd-muted" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {children}
    </div>
  )
}
