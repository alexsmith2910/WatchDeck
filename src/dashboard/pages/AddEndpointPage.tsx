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
  Accordion,
  RadioGroup,
  Radio,
  Separator,
  Spinner,
  ToggleButtonGroup,
  ToggleButton,
  cn,
} from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useApi } from '../hooks/useApi'
import ChipInput from '../components/ChipInput'
import KeyValueEditor, { type KeyValuePair } from '../components/KeyValueEditor'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const baseSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name must be under 200 characters'),
  type: z.enum(['http', 'port']),
  // Shared overrides
  checkInterval: z.number(),
  timeout: z.number(),
  latencyThreshold: z.number(),
  failureThreshold: z.number(),
  // SSL
  sslWarningDays: z.number(),
  // Alerts
  recoveryAlert: z.boolean(),
  alertCooldown: z.number(),
  escalationDelay: z.number(),
  escalationChannelId: z.string().optional(),
  notificationChannelIds: z.array(z.string()),
})

const httpSchema = baseSchema.extend({
  type: z.literal('http'),
  url: z
    .string()
    .min(1, 'URL is required')
    .refine(
      (val) => {
        try {
          new URL(val)
          return true
        } catch {
          return false
        }
      },
      { message: 'Must be a valid URL (include https://)' },
    ),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  expectedStatusCodes: z.array(z.number()).min(1, 'At least one status code required'),
  headers: z.array(z.object({ key: z.string(), value: z.string() })),
})

const portSchema = baseSchema.extend({
  type: z.literal('port'),
  host: z.string().min(1, 'Host is required'),
  port: z
    .number({ invalid_type_error: 'Port is required' })
    .int()
    .min(1, 'Port must be 1–65535')
    .max(65535, 'Port must be 1–65535'),
})

const formSchema = z.discriminatedUnion('type', [httpSchema, portSchema])

type FormValues = z.infer<typeof formSchema>

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HTTP_DEFAULTS: FormValues = {
  type: 'http',
  name: '',
  url: '',
  method: 'GET',
  expectedStatusCodes: [200],
  headers: [],
  checkInterval: 60,
  timeout: 10_000,
  latencyThreshold: 5_000,
  failureThreshold: 3,
  sslWarningDays: 14,
  recoveryAlert: true,
  alertCooldown: 900,
  escalationDelay: 1_800,
  notificationChannelIds: [],
}

const PORT_DEFAULTS: FormValues = {
  type: 'port',
  name: '',
  host: '',
  port: 0 as unknown as number, // placeholder — zod validates
  checkInterval: 60,
  timeout: 10_000,
  latencyThreshold: 5_000,
  failureThreshold: 3,
  sslWarningDays: 14,
  recoveryAlert: true,
  alertCooldown: 900,
  escalationDelay: 1_800,
  notificationChannelIds: [],
}

// ---------------------------------------------------------------------------
// Select option helpers
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
// Notification channel type
// ---------------------------------------------------------------------------

interface NotificationChannel {
  _id: string
  type: 'discord' | 'slack' | 'email'
  name: string
}

// ---------------------------------------------------------------------------
// Reusable form select
// ---------------------------------------------------------------------------

function FormSelect({
  label,
  options,
  value,
  onChange,
  description,
}: {
  label: string
  options: { value: number; label: string }[]
  value: number
  onChange: (value: number) => void
  description?: string
}) {
  const selectedLabel = options.find((o) => o.value === value)?.label ?? '—'

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-wd-muted">{label}</span>
      <Dropdown>
        <Dropdown.Trigger>
          <div
            className={cn(
              'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
              'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
            )}
          >
            <span className="text-foreground">{selectedLabel}</span>
            <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted" />
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
// AddEndpointPage
// ---------------------------------------------------------------------------

export default function AddEndpointPage() {
  const navigate = useNavigate()
  const { request } = useApi()

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    statusCode?: number | null
    responseTime: number
    sslDaysRemaining?: number | null
    errorMessage?: string | null
  } | null>(null)

  // Fetch notification channels
  useEffect(() => {
    request<{ data: NotificationChannel[] }>('/notifications/channels')
      .then((res) => setChannels(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setChannelsLoading(false))
  }, [request])

  const {
    control,
    handleSubmit,
    watch,
    reset,
    trigger,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: HTTP_DEFAULTS,
    mode: 'onBlur',
  })

  const endpointType = watch('type')
  const escalationDelay = watch('escalationDelay')

  // Switch type — reset form with type-specific defaults, preserve name
  const switchType = useCallback(
    (newType: 'http' | 'port') => {
      const currentName = watch('name')
      const defaults = newType === 'http' ? { ...HTTP_DEFAULTS } : { ...PORT_DEFAULTS }
      defaults.name = currentName
      reset(defaults)
      setTestResult(null)
    },
    [reset, watch],
  )

  // Test connection — fires a one-off check without saving
  const handleTestConnection = useCallback(async () => {
    setTestResult(null)
    const type = watch('type')

    // Validate required fields first
    if (type === 'http') {
      const valid = await trigger('url' as 'name')
      const url = watch('url' as 'url')
      if (!valid || !url) {
        setTestResult({ success: false, responseTime: 0, errorMessage: 'Enter a valid URL before testing' })
        return
      }
    } else {
      const validHost = await trigger('host' as 'name')
      const validPort = await trigger('port' as 'name')
      const host = watch('host' as 'host')
      const port = watch('port' as 'port')
      if (!validHost || !validPort || !host || !port) {
        setTestResult({ success: false, responseTime: 0, errorMessage: 'Enter host and port before testing' })
        return
      }
    }

    setTesting(true)
    try {
      const timeout = watch('timeout')
      const body: Record<string, unknown> = { type, timeout }

      if (type === 'http') {
        body.url = watch('url' as 'url')
        body.method = watch('method' as 'method') ?? 'GET'
      } else {
        body.host = watch('host' as 'host')
        body.port = watch('port' as 'port')
      }

      const res = await request<{
        data: {
          success: boolean
          statusCode?: number | null
          responseTime: number
          sslDaysRemaining?: number | null
          errorMessage?: string | null
        }
      }>('/endpoints/test', { method: 'POST', body })

      if (res.status < 400) {
        setTestResult(res.data.data)
      } else {
        setTestResult({ success: false, responseTime: 0, errorMessage: 'Test request failed' })
      }
    } catch {
      setTestResult({ success: false, responseTime: 0, errorMessage: 'Network error' })
    } finally {
      setTesting(false)
    }
  }, [watch, request, trigger])

  // Submit
  const onSubmit = async (data: FormValues) => {
    setSubmitting(true)
    setSubmitError(null)

    try {
      // Build the POST body
      const body: Record<string, unknown> = {
        name: data.name,
        type: data.type,
        checkInterval: data.checkInterval,
        timeout: data.timeout,
        latencyThreshold: data.latencyThreshold,
        failureThreshold: data.failureThreshold,
        sslWarningDays: data.sslWarningDays,
        recoveryAlert: data.recoveryAlert,
        alertCooldown: data.alertCooldown,
        escalationDelay: data.escalationDelay,
      }

      if (data.notificationChannelIds.length > 0) {
        body.notificationChannelIds = data.notificationChannelIds
      }
      if (data.escalationDelay > 0 && data.escalationChannelId) {
        body.escalationChannelId = data.escalationChannelId
      }

      if (data.type === 'http') {
        body.url = data.url
        body.method = data.method
        body.expectedStatusCodes = data.expectedStatusCodes
        // Convert header pairs to object, filtering out empty keys
        const headerObj: Record<string, string> = {}
        for (const h of data.headers) {
          if (h.key.trim()) headerObj[h.key.trim()] = h.value
        }
        if (Object.keys(headerObj).length > 0) body.headers = headerObj
      } else {
        body.host = data.host
        body.port = data.port
      }

      const res = await request<{ data?: unknown; error?: string; message?: string }>(
        '/endpoints',
        { method: 'POST', body },
      )
      if (res.status >= 400) {
        throw new Error(res.data?.message ?? res.data?.error ?? `Server returned ${res.status}`)
      }
      navigate('/endpoints')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create endpoint'
      setSubmitError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-6 max-w-2xl mx-auto pb-20">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="!rounded-lg"
          onPress={() => {
            if (!isDirty || window.confirm('You have unsaved changes. Discard and leave?')) {
              navigate('/endpoints')
            }
          }}
        >
          <Icon icon="solar:arrow-left-linear" width={20} />
        </Button>
        <h1 className="text-xl font-semibold text-foreground">Add Endpoint</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
        {/* ── Type Toggle ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-wd-muted">Type</span>
          <ToggleButtonGroup
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([endpointType])}
            onSelectionChange={(keys) => {
              const sel = [...keys][0] as 'http' | 'port' | undefined
              if (sel && sel !== endpointType) switchType(sel)
            }}
            size="sm"
          >
            <ToggleButton
              id="http"
              className={cn(
                '!text-xs !px-4',
                'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              )}
            >
              <Icon icon="solar:global-outline" width={16} className="mr-1" />
              HTTP
            </ToggleButton>
            <ToggleButton
              id="port"
              className={cn(
                '!text-xs !px-4',
                'data-[selected=true]:!bg-wd-primary data-[selected=true]:!text-wd-primary-foreground',
              )}
            >
              <Icon icon="solar:plug-circle-outline" width={16} className="mr-1" />
              Port
            </ToggleButton>
          </ToggleButtonGroup>
        </div>

        {/* ── Name ─────────────────────────────────────────────────── */}
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <TextField isInvalid={!!errors.name} isRequired>
              <Label className="!text-xs !font-medium !text-wd-muted">Name</Label>
              <Input
                {...field}
                placeholder="e.g. Production API"
                className="!text-sm"
              />
              {errors.name && <FieldError className="!text-[11px]">{errors.name.message}</FieldError>}
            </TextField>
          )}
        />

        {/* ── HTTP Fields ──────────────────────────────────────────── */}
        {endpointType === 'http' && (
          <>
            <Controller
              name="url"
              control={control}
              render={({ field }) => (
                <TextField isInvalid={!!errors.url} isRequired>
                  <Label className="!text-xs !font-medium !text-wd-muted">URL</Label>
                  <Input
                    {...field}
                    value={field.value ?? ''}
                    placeholder="https://api.example.com/health"
                    className="!text-sm !font-mono"
                    onBlur={(e) => {
                      // Auto-prepend https:// if user typed a bare domain
                      const v = (e.target as HTMLInputElement).value.trim()
                      if (v && !/^https?:\/\//i.test(v)) {
                        field.onChange(`https://${v}`)
                      }
                      field.onBlur()
                    }}
                  />
                  {errors.url && (
                    <FieldError className="!text-[11px]">{(errors as any).url?.message}</FieldError>
                  )}
                </TextField>
              )}
            />

            <Controller
              name="method"
              control={control}
              render={({ field }) => (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-wd-muted">Method</span>
                  <Dropdown>
                    <Dropdown.Trigger>
                      <div
                        className={cn(
                          'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
                          'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
                        )}
                      >
                        <span className="font-mono text-foreground">{field.value ?? 'GET'}</span>
                        <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted" />
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
                          <Dropdown.Item key={m} id={m} className="!text-xs !font-mono">
                            {m}
                          </Dropdown.Item>
                        ))}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
              )}
            />
          </>
        )}

        {/* ── Port Fields ──────────────────────────────────────────── */}
        {endpointType === 'port' && (
          <div className="grid grid-cols-2 gap-4">
            <Controller
              name="host"
              control={control}
              render={({ field }) => (
                <TextField isInvalid={!!(errors as any).host} isRequired>
                  <Label className="!text-xs !font-medium !text-wd-muted">Host</Label>
                  <Input
                    {...field}
                    value={field.value ?? ''}
                    placeholder="db.example.com"
                    className="!text-sm !font-mono"
                  />
                  {(errors as any).host && (
                    <FieldError className="!text-[11px]">{(errors as any).host?.message}</FieldError>
                  )}
                </TextField>
              )}
            />
            <Controller
              name="port"
              control={control}
              render={({ field }) => (
                <TextField isInvalid={!!(errors as any).port} isRequired>
                  <Label className="!text-xs !font-medium !text-wd-muted">Port</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={field.value ? String(field.value) : ''}
                    onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    onBlur={field.onBlur}
                    placeholder="5432"
                    className="!text-sm !font-mono"
                  />
                  {(errors as any).port && (
                    <FieldError className="!text-[11px]">{(errors as any).port?.message}</FieldError>
                  )}
                </TextField>
              )}
            />
          </div>
        )}

        {/* ── Test Connection ──────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="!text-xs !px-4"
            onPress={handleTestConnection}
            isDisabled={testing}
          >
            {testing ? (
              <>
                <Spinner size="sm" className="mr-1" />
                Testing...
              </>
            ) : (
              <>
                <Icon icon="solar:pulse-2-linear" width={16} className="mr-1" />
                Test Connection
              </>
            )}
          </Button>
          {testResult && (
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs',
              testResult.success
                ? 'bg-wd-success/10 text-wd-success'
                : 'bg-wd-danger/10 text-wd-danger',
            )}>
              <Icon
                icon={testResult.success ? 'solar:check-circle-linear' : 'solar:close-circle-linear'}
                width={16}
              />
              <span className="font-medium">
                {testResult.success
                  ? <>Connected &mdash; <span className="font-mono">{testResult.responseTime}ms</span></>
                  : testResult.errorMessage ?? 'Connection failed'}
              </span>
              {testResult.success && testResult.statusCode != null && (
                <span className="font-mono text-wd-muted">({testResult.statusCode})</span>
              )}
              {testResult.success && testResult.sslDaysRemaining != null && (
                <span className={cn(
                  'text-[10px] font-mono',
                  testResult.sslDaysRemaining > 14 ? 'text-wd-muted' : 'text-wd-warning',
                )}>
                  SSL: {testResult.sslDaysRemaining}d
                </span>
              )}
            </div>
          )}
        </div>

        <Separator className="!bg-wd-border/30" />

        {/* ── Accordion Sections ───────────────────────────────────── */}
        <Accordion allowsMultipleExpanded className="!p-0 !gap-0">

          {/* Expected Response (HTTP only) */}
          {endpointType === 'http' && (
            <Accordion.Item id="expected-response">
              <Accordion.Heading>
                <Accordion.Trigger className="!px-0 !py-3 group">
                  <div className="flex items-center gap-2 flex-1">
                    <Icon icon="solar:checklist-outline" width={20} className="text-wd-muted" />
                    <span className="text-sm font-medium text-foreground">Expected Response</span>
                  </div>
                  <Accordion.Indicator className="text-wd-muted transition-transform duration-200 group-data-[expanded]:rotate-180">
                    <Icon icon="solar:alt-arrow-down-linear" width={20} />
                  </Accordion.Indicator>
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="!px-0 !pb-4 !pt-0">
                  <div className="flex flex-col gap-4">
                    <Controller
                      name="expectedStatusCodes"
                      control={control}
                      render={({ field }) => (
                        <ChipInput
                          label="Expected Status Codes"
                          values={(field.value ?? []).map(String)}
                          onChange={(vals) => field.onChange(vals.map(Number))}
                          placeholder="e.g. 201"
                          description="HTTP status codes considered healthy"
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
                  </div>
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          )}

          {/* Headers (HTTP only) */}
          {endpointType === 'http' && (
            <Accordion.Item id="headers">
              <Accordion.Heading>
                <Accordion.Trigger className="!px-0 !py-3 group">
                  <div className="flex items-center gap-2 flex-1">
                    <Icon icon="solar:code-square-outline" width={20} className="text-wd-muted" />
                    <span className="text-sm font-medium text-foreground">Custom Headers</span>
                  </div>
                  <Accordion.Indicator className="text-wd-muted transition-transform duration-200 group-data-[expanded]:rotate-180">
                    <Icon icon="solar:alt-arrow-down-linear" width={20} />
                  </Accordion.Indicator>
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="!px-0 !pb-4 !pt-0">
                  <Controller
                    name="headers"
                    control={control}
                    render={({ field }) => (
                      <KeyValueEditor
                        pairs={(field.value ?? []) as KeyValuePair[]}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          )}

          {/* Schedule & Thresholds */}
          <Accordion.Item id="schedule">
            <Accordion.Heading>
              <Accordion.Trigger className="!px-0 !py-3 group">
                <div className="flex items-center gap-2 flex-1">
                  <Icon icon="solar:clock-circle-outline" width={20} className="text-wd-muted" />
                  <span className="text-sm font-medium text-foreground">Schedule & Thresholds</span>
                </div>
                <Accordion.Indicator className="text-wd-muted transition-transform duration-200 group-data-[expanded]:rotate-180">
                  <Icon icon="solar:alt-arrow-down-linear" width={20} />
                </Accordion.Indicator>
              </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel>
              <Accordion.Body className="!px-0 !pb-4 !pt-0">
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    name="checkInterval"
                    control={control}
                    render={({ field }) => (
                      <FormSelect
                        label="Check Every"
                        options={INTERVAL_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        description="How often to run checks"
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
                        description="Max wait before marking as failed"
                      />
                    )}
                  />
                  <Controller
                    name="latencyThreshold"
                    control={control}
                    render={({ field }) => (
                      <FormSelect
                        label="Degraded After"
                        options={LATENCY_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        description="Response time threshold for 'degraded'"
                      />
                    )}
                  />
                  <Controller
                    name="failureThreshold"
                    control={control}
                    render={({ field }) => (
                      <FormSelect
                        label="Failure Threshold"
                        options={FAILURE_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        description="Consecutive failures before incident"
                      />
                    )}
                  />
                </div>
              </Accordion.Body>
            </Accordion.Panel>
          </Accordion.Item>

          {/* SSL (HTTP only) */}
          {endpointType === 'http' && (
            <Accordion.Item id="ssl">
              <Accordion.Heading>
                <Accordion.Trigger className="!px-0 !py-3 group">
                  <div className="flex items-center gap-2 flex-1">
                    <Icon icon="solar:lock-outline" width={20} className="text-wd-muted" />
                    <span className="text-sm font-medium text-foreground">SSL Certificate</span>
                  </div>
                  <Accordion.Indicator className="text-wd-muted transition-transform duration-200 group-data-[expanded]:rotate-180">
                    <Icon icon="solar:alt-arrow-down-linear" width={20} />
                  </Accordion.Indicator>
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="!px-0 !pb-4 !pt-0">
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-wd-muted">Warn Before Expiry</span>
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
                    <span className="text-[11px] text-wd-muted/60">
                      Alert when SSL certificate is expiring within this window
                    </span>
                  </div>
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          )}

          {/* Notifications */}
          <Accordion.Item id="notifications">
            <Accordion.Heading>
              <Accordion.Trigger className="!px-0 !py-3 group">
                <div className="flex items-center gap-2 flex-1">
                  <Icon icon="solar:bell-outline" width={20} className="text-wd-muted" />
                  <span className="text-sm font-medium text-foreground">Notifications</span>
                </div>
                <Accordion.Indicator className="text-wd-muted transition-transform duration-200 group-data-[expanded]:rotate-180">
                  <Icon icon="solar:alt-arrow-down-linear" width={20} />
                </Accordion.Indicator>
              </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel>
              <Accordion.Body className="!px-0 !pb-4 !pt-0">
                <div className="flex flex-col gap-5">
                  {/* Channel checkboxes */}
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-wd-muted">Alert Channels</span>
                    {channelsLoading ? (
                      <div className="flex items-center gap-2 py-2">
                        <Spinner size="sm" />
                        <span className="text-xs text-wd-muted">Loading channels...</span>
                      </div>
                    ) : channels.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-lg bg-wd-surface-hover/30 px-3 py-2.5">
                        <Icon icon="solar:info-circle-outline" width={16} className="text-wd-muted/60 shrink-0" />
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
                                    width={16}
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
                  </div>

                  <Separator className="!bg-wd-border/20" />

                  {/* Recovery alert toggle */}
                  <Controller
                    name="recoveryAlert"
                    control={control}
                    render={({ field }) => (
                      <div className="flex items-center justify-between">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-foreground">Recovery Alert</span>
                          <span className="text-[11px] text-wd-muted/60">
                            Send notification when endpoint recovers
                          </span>
                        </div>
                        <Switch
                          isSelected={field.value}
                          onChange={field.onChange}
                          size="sm"
                        >
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch>
                      </div>
                    )}
                  />

                  {/* Alert cooldown */}
                  <Controller
                    name="alertCooldown"
                    control={control}
                    render={({ field }) => (
                      <FormSelect
                        label="Alert Cooldown"
                        options={COOLDOWN_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        description="Minimum time between repeated alerts for the same incident"
                      />
                    )}
                  />

                  {/* Escalation delay */}
                  <Controller
                    name="escalationDelay"
                    control={control}
                    render={({ field }) => (
                      <FormSelect
                        label="Escalation Delay"
                        options={ESCALATION_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        description="Time after incident before escalating to a secondary channel"
                      />
                    )}
                  />

                  {/* Escalation channel — only visible when escalation is enabled */}
                  {escalationDelay > 0 && channels.length > 0 && (
                    <Controller
                      name="escalationChannelId"
                      control={control}
                      render={({ field }) => {
                        const selectedCh = channels.find((c) => c._id === field.value)
                        return (
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-wd-muted">Escalate To</span>
                            <Dropdown>
                              <Dropdown.Trigger>
                                <div
                                  className={cn(
                                    'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
                                    'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
                                  )}
                                >
                                  <span className={selectedCh ? 'text-foreground' : 'text-wd-muted/60'}>
                                    {selectedCh?.name ?? 'Select a Channel'}
                                  </span>
                                  <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted" />
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
                                          width={16}
                                          className="text-wd-muted"
                                        />
                                        {ch.name}
                                      </div>
                                    </Dropdown.Item>
                                  ))}
                                </Dropdown.Menu>
                              </Dropdown.Popover>
                            </Dropdown>
                            <span className="text-[11px] text-wd-muted/60">
                              Channel to notify if the incident is not resolved
                            </span>
                          </div>
                        )
                      }}
                    />
                  )}
                </div>
              </Accordion.Body>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        {/* ── Submit Error ──────────────────────────────────────────── */}
        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-wd-danger/30 bg-wd-danger/5 px-3 py-2">
            <Icon icon="solar:danger-triangle-outline" width={20} className="text-wd-danger shrink-0" />
            <span className="text-xs text-wd-danger">{submitError}</span>
          </div>
        )}

        {/* ── Actions ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="!text-xs !px-4"
            onPress={() => {
              if (!isDirty || window.confirm('You have unsaved changes. Discard and leave?')) {
                navigate('/endpoints')
              }
            }}
            isDisabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            className="!bg-wd-primary !text-wd-primary-foreground !text-xs !px-6 !font-medium"
            isDisabled={submitting}
          >
            {submitting ? (
              <>
                <Spinner size="sm" className="mr-1" />
                Creating...
              </>
            ) : (
              <>
                <Icon icon="solar:add-circle-outline" width={20} className="mr-1" />
                Create Endpoint
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
