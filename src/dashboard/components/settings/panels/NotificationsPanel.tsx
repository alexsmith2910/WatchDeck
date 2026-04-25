/**
 * Notifications panel — dashboard-configurable notification policy.
 *
 *   • Default severity filter  — inherited by new channels at creation time
 *   • Default event filters    — inherited by new channels at creation time
 *   • Global mute              — blanket pause across all dispatches
 *
 * Backed by `GET|PUT /notifications/preferences` (mx_notification_preferences).
 * Per-channel policy still lives on the channel row itself; this panel only
 * sets the seed values new channels start with, and the global mute switch
 * that trumps per-channel settings while active.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Spinner, Switch, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { SectionHead, FilterDropdown } from '../../endpoint-detail/primitives'
import { Field } from '../../endpoint-detail/SettingsTab'
import { useApi } from '../../../hooks/useApi'
import { useSSE } from '../../../hooks/useSSE'
import { toast } from '../../../ui/toast'
import type {
  ApiNotificationPreferences,
  EventFilters,
  SeverityFilter,
} from '../../../types/notifications'
import { useFormat } from '../../../hooks/useFormat'

interface Props {
  onDirtyChange?: (dirty: boolean) => void
}

const SEVERITY_OPTIONS: Array<{ id: SeverityFilter; label: string; dot: string }> = [
  { id: 'info+', label: 'info+ (all alerts)', dot: 'var(--wd-primary)' },
  { id: 'warning+', label: 'warning+ (skip info)', dot: 'var(--wd-warning)' },
  { id: 'critical', label: 'critical only', dot: 'var(--wd-danger)' },
]

const MUTE_PRESETS: Array<{ id: string; label: string; seconds: number | null }> = [
  { id: 'none', label: 'Not muted', seconds: null },
  { id: '30m', label: '30 minutes', seconds: 30 * 60 },
  { id: '1h', label: '1 hour', seconds: 60 * 60 },
  { id: '4h', label: '4 hours', seconds: 4 * 60 * 60 },
  { id: '24h', label: '24 hours', seconds: 24 * 60 * 60 },
]

const DEFAULT_PREFS: ApiNotificationPreferences = {
  id: 'global',
  defaultSeverityFilter: 'warning+',
  defaultEventFilters: { sendOpen: true, sendResolved: true, sendEscalation: true },
  globalMuteUntil: null,
  updatedAt: new Date().toISOString(),
}

export function NotificationsPanel({ onDirtyChange }: Props) {
  const { request } = useApi()
  const { subscribe } = useSSE()
  const fmt = useFormat()

  const [prefs, setPrefs] = useState<ApiNotificationPreferences | null>(null)
  const [draft, setDraft] = useState<ApiNotificationPreferences>(DEFAULT_PREFS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await request<{ data: ApiNotificationPreferences }>('/notifications/preferences')
    const next = res.data?.data ?? DEFAULT_PREFS
    setPrefs(next)
    setDraft(next)
    setLoading(false)
  }, [request])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const offs = [
      subscribe('notification:muted', () => { void load() }),
      subscribe('notification:unmuted', () => { void load() }),
    ]
    return () => { for (const off of offs) off() }
  }, [subscribe, load])

  const dirty = useMemo(
    () => prefs !== null && !prefsEqual(prefs, draft),
    [prefs, draft],
  )

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const save = useCallback(async () => {
    setSaving(true)
    const body: Record<string, unknown> = {
      defaultSeverityFilter: draft.defaultSeverityFilter,
      defaultEventFilters: draft.defaultEventFilters,
      globalMuteUntil: draft.globalMuteUntil ?? null,
    }
    const res = await request<{ data: ApiNotificationPreferences }>(
      '/notifications/preferences',
      { method: 'PUT', body },
    )
    setSaving(false)
    if (res.status >= 400) {
      toast.error('Save Failed', { description: `HTTP ${res.status}` })
      return
    }
    const next = res.data?.data ?? draft
    setPrefs(next)
    setDraft(next)
    toast.success('Preferences Saved')
  }, [draft, request])

  const muteStatus = useMemo(() => {
    if (!draft.globalMuteUntil) return { active: false, until: null as string | null }
    const until = new Date(draft.globalMuteUntil)
    if (until.getTime() <= Date.now()) return { active: false, until: null }
    return { active: true, until: fmt.ts(until) }
  }, [draft.globalMuteUntil, fmt])

  const applyMutePreset = useCallback(
    (presetId: string) => {
      const preset = MUTE_PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      const next = preset.seconds
        ? new Date(Date.now() + preset.seconds * 1000).toISOString()
        : null
      setDraft((d) => ({ ...d, globalMuteUntil: next }))
    },
    [],
  )

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
        icon="solar:bell-bing-outline"
        title="Notifications"
        sub="Seed policy for new channels plus the global mute switch."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Default severity filter" hint="Applied to new channels unless the creation form overrides it.">
          <FilterDropdown<SeverityFilter>
            value={draft.defaultSeverityFilter}
            options={SEVERITY_OPTIONS}
            onChange={(id) => setDraft((d) => ({ ...d, defaultSeverityFilter: id }))}
            ariaLabel="Default severity filter"
            fullWidth
          />
        </Field>

        <Field label="Events channels receive by default" hint="New channels inherit these toggles. Existing channels are unchanged.">
          <div className="space-y-1.5">
            <EventFilterToggle
              label="Incident opened"
              value={draft.defaultEventFilters.sendOpen}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  defaultEventFilters: { ...d.defaultEventFilters, sendOpen: v },
                }))
              }
            />
            <EventFilterToggle
              label="Incident resolved"
              value={draft.defaultEventFilters.sendResolved}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  defaultEventFilters: { ...d.defaultEventFilters, sendResolved: v },
                }))
              }
            />
            <EventFilterToggle
              label="Escalation"
              value={draft.defaultEventFilters.sendEscalation}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  defaultEventFilters: { ...d.defaultEventFilters, sendEscalation: v },
                }))
              }
            />
          </div>
        </Field>

        <div className="md:col-span-2">
          <Field label="Global mute" hint="Blanket pause for every dispatch, regardless of severity.">
            <div className="flex flex-wrap items-center gap-2">
              {MUTE_PRESETS.map((p) => {
                const active =
                  (p.id === 'none' && !muteStatus.active) ||
                  (p.seconds != null &&
                    muteStatus.active &&
                    Math.abs(
                      new Date(draft.globalMuteUntil ?? 0).getTime() -
                        (Date.now() + p.seconds * 1000),
                    ) < 10_000)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyMutePreset(p.id)}
                    className={cn(
                      'inline-flex items-center h-8 px-3 rounded-lg text-[11.5px] border transition-colors cursor-pointer',
                      active
                        ? 'border-wd-primary/60 text-wd-primary bg-wd-primary/5'
                        : 'border-wd-border/50 bg-wd-surface hover:bg-wd-surface-hover',
                    )}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            {muteStatus.active && (
              <div className="mt-2 rounded-lg bg-wd-warning/10 border border-wd-warning/30 px-3 py-2 text-[11px] text-wd-warning flex items-center gap-2">
                <Icon icon="solar:bell-off-bold" width={16} />
                All dispatches paused until <span className="font-mono">{muteStatus.until}</span>.
              </div>
            )}
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
          onPress={() => setDraft(prefs ?? DEFAULT_PREFS)}
          isDisabled={!dirty || saving}
        >
          Discard
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function EventFilterToggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-wd-surface-hover/30 px-3 py-1.5 border border-wd-border/40">
      <span className="text-[12px] text-foreground">{label}</span>
      <Switch size="sm" isSelected={value} onValueChange={onChange} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Equality helpers — keep the dirty flag from firing on references alone.
// ---------------------------------------------------------------------------

function prefsEqual(a: ApiNotificationPreferences, b: ApiNotificationPreferences): boolean {
  if (a.defaultSeverityFilter !== b.defaultSeverityFilter) return false
  if (!eventFiltersEqual(a.defaultEventFilters, b.defaultEventFilters)) return false
  if ((a.globalMuteUntil ?? null) !== (b.globalMuteUntil ?? null)) return false
  return true
}

function eventFiltersEqual(a: EventFilters, b: EventFilters): boolean {
  return a.sendOpen === b.sendOpen && a.sendResolved === b.sendResolved && a.sendEscalation === b.sendEscalation
}
