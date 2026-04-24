/**
 * Check defaults panel — runtime override of the per-endpoint defaults in
 * `watchdeck.config.js`, plus the global SLO. New endpoints inherit these
 * values at creation time through `adapter.getEffectiveDefaults()`, which
 * merges the `mx_settings.defaults` / `mx_settings.slo` subdocuments over
 * the config-file values.
 *
 *   GET  /settings/defaults
 *   PUT  /settings/defaults
 *   GET  /settings/slo
 *   PUT  /settings/slo
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Spinner } from '@heroui/react'
import { Icon } from '@iconify/react'
import { SectionHead, FilterDropdown } from '../../endpoint-detail/primitives'
import {
  Field,
  CHECK_INTERVAL_PRESETS,
  TIMEOUT_PRESETS,
  LATENCY_PRESETS,
  SSL_WARNING_PRESETS,
  FAILURE_THRESHOLD_PRESETS,
  RECOVERY_THRESHOLD_PRESETS,
  ALERT_COOLDOWN_PRESETS,
  ESCALATION_DELAY_PRESETS,
  withCustomOption,
  fmtSeconds,
  fmtMs,
  fmtDays,
} from '../../endpoint-detail/SettingsTab'
import { useApi } from '../../../hooks/useApi'
import { toast } from '../../../ui/toast'

interface Props {
  onDirtyChange?: (dirty: boolean) => void
}

interface EffectiveDefaults {
  checkInterval: number
  timeout: number
  expectedStatusCodes: number[]
  latencyThreshold: number
  sslWarningDays: number
  failureThreshold: number
  recoveryThreshold: number
  alertCooldown: number
  recoveryAlert: boolean
  escalationDelay: number
}

interface EffectiveSlo {
  target: number
  windowDays: number
}

const SLO_WINDOW_OPTIONS = [
  { id: '7', label: '7 days' },
  { id: '14', label: '14 days' },
  { id: '30', label: '30 days' },
  { id: '60', label: '60 days' },
  { id: '90', label: '90 days' },
]

const RECOVERY_ALERT_OPTIONS = [
  { id: 'on', label: 'Send recovery alert' },
  { id: 'off', label: 'No recovery alert' },
]

const FALLBACK_DEFAULTS: EffectiveDefaults = {
  checkInterval: 60,
  timeout: 10_000,
  expectedStatusCodes: [200],
  latencyThreshold: 5_000,
  sslWarningDays: 14,
  failureThreshold: 3,
  recoveryThreshold: 2,
  alertCooldown: 900,
  recoveryAlert: true,
  escalationDelay: 1_800,
}

const FALLBACK_SLO: EffectiveSlo = { target: 99.9, windowDays: 30 }

export function CheckDefaultsPanel({ onDirtyChange }: Props) {
  const { request } = useApi()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [base, setBase] = useState<EffectiveDefaults>(FALLBACK_DEFAULTS)
  const [draft, setDraft] = useState<EffectiveDefaults>(FALLBACK_DEFAULTS)
  const [sloBase, setSloBase] = useState<EffectiveSlo>(FALLBACK_SLO)
  const [sloDraft, setSloDraft] = useState<EffectiveSlo>(FALLBACK_SLO)

  const load = useCallback(async () => {
    const [d, s] = await Promise.all([
      request<{ data: EffectiveDefaults }>('/settings/defaults'),
      request<{ data: EffectiveSlo }>('/settings/slo'),
    ])
    const defaults = d.data?.data ?? FALLBACK_DEFAULTS
    const slo = s.data?.data ?? FALLBACK_SLO
    setBase(defaults)
    setDraft(defaults)
    setSloBase(slo)
    setSloDraft(slo)
    setLoading(false)
  }, [request])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(
    () => !defaultsEqual(base, draft) || !sloEqual(sloBase, sloDraft),
    [base, draft, sloBase, sloDraft],
  )

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const checkIntervalOptions = useMemo(
    () => withCustomOption(CHECK_INTERVAL_PRESETS, draft.checkInterval, fmtSeconds),
    [draft.checkInterval],
  )
  const timeoutOptions = useMemo(
    () => withCustomOption(TIMEOUT_PRESETS, draft.timeout, fmtMs),
    [draft.timeout],
  )
  const latencyOptions = useMemo(
    () => withCustomOption(LATENCY_PRESETS, draft.latencyThreshold, fmtMs),
    [draft.latencyThreshold],
  )
  const sslOptions = useMemo(
    () => withCustomOption(SSL_WARNING_PRESETS, draft.sslWarningDays, fmtDays),
    [draft.sslWarningDays],
  )
  const failureOptions = useMemo(
    () => withCustomOption(FAILURE_THRESHOLD_PRESETS, draft.failureThreshold, (n) => String(n)),
    [draft.failureThreshold],
  )
  const recoveryOptions = useMemo(
    () => withCustomOption(RECOVERY_THRESHOLD_PRESETS, draft.recoveryThreshold, (n) => String(n)),
    [draft.recoveryThreshold],
  )
  const alertCooldownOptions = useMemo(
    () => withCustomOption(ALERT_COOLDOWN_PRESETS, draft.alertCooldown, fmtSeconds),
    [draft.alertCooldown],
  )
  const escalationOptions = useMemo(
    () => withCustomOption(ESCALATION_DELAY_PRESETS, draft.escalationDelay, fmtSeconds),
    [draft.escalationDelay],
  )
  const sloWindowOptions = useMemo(
    () => {
      const id = String(sloDraft.windowDays)
      if (SLO_WINDOW_OPTIONS.some((o) => o.id === id)) return SLO_WINDOW_OPTIONS
      return [{ id, label: `${sloDraft.windowDays} days (custom)` }, ...SLO_WINDOW_OPTIONS]
    },
    [sloDraft.windowDays],
  )

  const save = useCallback(async () => {
    setSaving(true)
    const defaultsBody: Record<string, unknown> = {
      checkInterval: draft.checkInterval,
      timeout: draft.timeout,
      latencyThreshold: draft.latencyThreshold,
      sslWarningDays: draft.sslWarningDays,
      failureThreshold: draft.failureThreshold,
      recoveryThreshold: draft.recoveryThreshold,
      alertCooldown: draft.alertCooldown,
      recoveryAlert: draft.recoveryAlert,
      escalationDelay: draft.escalationDelay,
    }
    const sloBody: Record<string, unknown> = {
      target: sloDraft.target,
      windowDays: sloDraft.windowDays,
    }
    const [d, s] = await Promise.all([
      request<{ data: EffectiveDefaults }>('/settings/defaults', { method: 'PUT', body: defaultsBody }),
      request<{ data: EffectiveSlo }>('/settings/slo', { method: 'PUT', body: sloBody }),
    ])
    setSaving(false)
    if (d.status >= 400 || s.status >= 400) {
      toast.error('Save Failed', { description: `HTTP ${d.status} / ${s.status}` })
      return
    }
    const nextDefaults = d.data?.data ?? draft
    const nextSlo = s.data?.data ?? sloDraft
    setBase(nextDefaults)
    setDraft(nextDefaults)
    setSloBase(nextSlo)
    setSloDraft(nextSlo)
    toast.success('Defaults saved', { description: 'New endpoints will inherit these values.' })
  }, [draft, sloDraft, request])

  if (loading) {
    return (
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5 flex items-center justify-center min-h-[200px]">
        <Spinner size="sm" />
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:radar-linear"
        title="Check defaults"
        sub="Applied to every new endpoint at creation time. Existing endpoints keep their own values."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Check interval" hint="How often new endpoints are probed.">
          <FilterDropdown<string>
            value={String(draft.checkInterval)}
            options={checkIntervalOptions}
            onChange={(id) => setDraft((d) => ({ ...d, checkInterval: Number(id) }))}
            ariaLabel="Check interval"
            fullWidth
          />
        </Field>
        <Field label="Timeout" hint="Wait time before a probe is marked as timed-out.">
          <FilterDropdown<string>
            value={String(draft.timeout)}
            options={timeoutOptions}
            onChange={(id) => setDraft((d) => ({ ...d, timeout: Number(id) }))}
            ariaLabel="Timeout"
            fullWidth
          />
        </Field>
        <Field label="Latency threshold" hint="Response time above this is flagged 'degraded'.">
          <FilterDropdown<string>
            value={String(draft.latencyThreshold)}
            options={latencyOptions}
            onChange={(id) => setDraft((d) => ({ ...d, latencyThreshold: Number(id) }))}
            ariaLabel="Latency threshold"
            fullWidth
          />
        </Field>
        <Field label="SSL warning" hint="Alert window before the certificate expires.">
          <FilterDropdown<string>
            value={String(draft.sslWarningDays)}
            options={sslOptions}
            onChange={(id) => setDraft((d) => ({ ...d, sslWarningDays: Number(id) }))}
            ariaLabel="SSL warning"
            fullWidth
          />
        </Field>
        <Field label="Failure threshold" hint="Consecutive failures before an incident opens.">
          <FilterDropdown<string>
            value={String(draft.failureThreshold)}
            options={failureOptions}
            onChange={(id) => setDraft((d) => ({ ...d, failureThreshold: Number(id) }))}
            ariaLabel="Failure threshold"
            fullWidth
          />
        </Field>
        <Field label="Recovery threshold" hint="Consecutive healthy checks required to auto-resolve.">
          <FilterDropdown<string>
            value={String(draft.recoveryThreshold)}
            options={recoveryOptions}
            onChange={(id) => setDraft((d) => ({ ...d, recoveryThreshold: Number(id) }))}
            ariaLabel="Recovery threshold"
            fullWidth
          />
        </Field>
        <Field label="Alert cooldown" hint="Minimum gap between repeat alerts on the same incident.">
          <FilterDropdown<string>
            value={String(draft.alertCooldown)}
            options={alertCooldownOptions}
            onChange={(id) => setDraft((d) => ({ ...d, alertCooldown: Number(id) }))}
            ariaLabel="Alert cooldown"
            fullWidth
          />
        </Field>
        <Field label="Escalation delay" hint="Time after open before escalating to the escalation channel.">
          <FilterDropdown<string>
            value={String(draft.escalationDelay)}
            options={escalationOptions}
            onChange={(id) => setDraft((d) => ({ ...d, escalationDelay: Number(id) }))}
            ariaLabel="Escalation delay"
            fullWidth
          />
        </Field>
        <Field label="Recovery alert" hint="Whether a 'recovered' notification fires when an incident resolves.">
          <FilterDropdown<'on' | 'off'>
            value={draft.recoveryAlert ? 'on' : 'off'}
            options={RECOVERY_ALERT_OPTIONS}
            onChange={(id) => setDraft((d) => ({ ...d, recoveryAlert: id === 'on' }))}
            ariaLabel="Recovery alert"
            fullWidth
          />
        </Field>
      </div>

      <div className="mt-6 pt-4 border-t border-wd-border/40">
        <SectionHead
          icon="solar:shield-check-linear"
          title="Service level objective"
          sub="Target uptime drives the SLO burn-rate KPI on endpoint detail pages."
          className="mb-3"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Target uptime (%)" hint="90–99.999. 99.9 gives ~43 min monthly error budget.">
            <input
              type="number"
              min={90}
              max={99.999}
              step={0.001}
              value={sloDraft.target}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isFinite(v)) return
                setSloDraft((s) => ({ ...s, target: v }))
              }}
              className="w-full h-9 rounded-lg bg-wd-surface border border-wd-border/60 px-3 text-[12.5px] text-foreground font-mono focus:outline-none focus:border-wd-primary transition-colors"
            />
          </Field>
          <Field label="Rolling window" hint="Days used to compute error-budget consumption.">
            <FilterDropdown<string>
              value={String(sloDraft.windowDays)}
              options={sloWindowOptions}
              onChange={(id) => setSloDraft((s) => ({ ...s, windowDays: Number(id) }))}
              ariaLabel="SLO window"
              fullWidth
            />
          </Field>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5 pt-4 border-t border-wd-border/40">
        <Button
          size="sm"
          variant="outline"
          className="!rounded-lg"
          onPress={() => void save()}
          isDisabled={!dirty || saving}
        >
          {saving ? <Spinner size="sm" /> : <Icon icon="solar:diskette-outline" width={16} />}
          Save changes
        </Button>
        <Button
          size="sm"
          variant="bordered"
          className="!rounded-lg !text-[12px]"
          onPress={() => {
            setDraft(base)
            setSloDraft(sloBase)
          }}
          isDisabled={!dirty || saving}
        >
          Discard
        </Button>
        <span className="text-[11px] text-wd-muted ml-auto">
          Runtime override. Resets to <span className="font-mono">watchdeck.config.js</span> defaults on save with empty body.
        </span>
      </div>
    </div>
  )
}

function defaultsEqual(a: EffectiveDefaults, b: EffectiveDefaults): boolean {
  return (
    a.checkInterval === b.checkInterval &&
    a.timeout === b.timeout &&
    a.latencyThreshold === b.latencyThreshold &&
    a.sslWarningDays === b.sslWarningDays &&
    a.failureThreshold === b.failureThreshold &&
    a.recoveryThreshold === b.recoveryThreshold &&
    a.alertCooldown === b.alertCooldown &&
    a.recoveryAlert === b.recoveryAlert &&
    a.escalationDelay === b.escalationDelay
  )
}

function sloEqual(a: EffectiveSlo, b: EffectiveSlo): boolean {
  return a.target === b.target && a.windowDays === b.windowDays
}
