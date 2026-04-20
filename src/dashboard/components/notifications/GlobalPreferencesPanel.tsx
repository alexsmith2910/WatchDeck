/**
 * Notifications → Global preferences panel (§4.4).
 *
 * Renders on the Settings page. Everything here mirrors the
 * `mx_notification_preferences` document (single row, _id = 'global').
 *
 *   - Default severity filter         → channels without override inherit this
 *   - Default event filters           → same
 *   - Global quiet hours              → HH:MM + IANA tz, suppresses non-critical
 *   - Global mute                     → blanket pause for all dispatches
 *   - Digest preview                  → V1 preview-only toggle; full batching in V1.5
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Dropdown, Switch, Input, Spinner, cn } from '@heroui/react'
import type { Selection } from '@heroui/react'
import { Icon } from '@iconify/react'
import { useApi } from '../../hooks/useApi'
import { useSSE } from '../../hooks/useSSE'
import { toast } from '../../ui/toast'
import type {
  ApiNotificationPreferences,
  EventFilters,
  QuietHours,
  SeverityFilter,
} from '../../types/notifications'

const SEVERITY_LABELS: Record<SeverityFilter, string> = {
  'info+': 'info+ (all alerts)',
  'warning+': 'warning+ (skip info)',
  critical: 'critical only',
}

const MUTE_PRESETS: Array<{ id: string; label: string; seconds: number | null }> = [
  { id: 'none', label: 'Not muted', seconds: null },
  { id: '30m', label: '30 minutes', seconds: 30 * 60 },
  { id: '1h', label: '1 hour', seconds: 60 * 60 },
  { id: '4h', label: '4 hours', seconds: 4 * 60 * 60 },
  { id: '24h', label: '24 hours', seconds: 24 * 60 * 60 },
]

const DEFAULT_PREFS: ApiNotificationPreferences = {
  _id: 'global',
  defaultSeverityFilter: 'warning+',
  defaultEventFilters: { sendOpen: true, sendResolved: true, sendEscalation: true },
  globalQuietHours: null,
  globalMuteUntil: null,
  digestMode: null,
  updatedAt: new Date().toISOString(),
}

export function GlobalPreferencesPanel() {
  const { request } = useApi()
  const { subscribe } = useSSE()
  const [prefs, setPrefs] = useState<ApiNotificationPreferences | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<ApiNotificationPreferences>(DEFAULT_PREFS)

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

  const dirty = useMemo(() => prefs !== null && !prefsEqual(prefs, draft), [prefs, draft])

  const save = useCallback(async () => {
    setSaving(true)
    const body: Record<string, unknown> = {
      defaultSeverityFilter: draft.defaultSeverityFilter,
      defaultEventFilters: draft.defaultEventFilters,
    }
    body.globalQuietHours = draft.globalQuietHours ?? null
    body.globalMuteUntil = draft.globalMuteUntil ?? null
    body.digestMode = draft.digestMode ?? null
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
    return { active: true, until: until.toLocaleString() }
  }, [draft.globalMuteUntil])

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
      <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-4 flex items-center justify-center">
        <Spinner size="sm" />
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface">
      <div className="px-4 py-3 border-b border-wd-border/50 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Notification Preferences</h2>
          <p className="text-[11px] text-wd-muted">
            Defaults that new channels inherit, plus global controls that apply to every dispatch.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="bordered"
            className="!text-xs"
            onPress={() => setDraft(prefs ?? DEFAULT_PREFS)}
            isDisabled={!dirty || saving}
          >
            Reset
          </Button>
          <Button
            size="sm"
            className="!text-xs !bg-wd-primary !text-white"
            onPress={() => void save()}
            isDisabled={!dirty || saving}
          >
            {saving ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Defaults */}
        <section className="space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-wd-muted">
            Defaults for new channels
          </h3>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-wd-muted">Severity Filter</label>
            <Dropdown>
              <Dropdown.Trigger>
                <div
                  className={cn(
                    'flex items-center justify-between h-9 px-3 rounded-lg text-xs cursor-pointer',
                    'bg-wd-surface-hover/50 border border-wd-border/50 hover:bg-wd-surface-hover transition-colors',
                  )}
                >
                  <span className="text-foreground">
                    {SEVERITY_LABELS[draft.defaultSeverityFilter]}
                  </span>
                  <Icon icon="solar:alt-arrow-down-linear" width={16} className="text-wd-muted" />
                </div>
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom start" className="!min-w-[220px]">
                <Dropdown.Menu
                  selectionMode="single"
                  selectedKeys={new Set([draft.defaultSeverityFilter])}
                  onSelectionChange={(keys: Selection) => {
                    const id = [...keys][0] as SeverityFilter | undefined
                    if (id) setDraft((d) => ({ ...d, defaultSeverityFilter: id }))
                  }}
                >
                  <Dropdown.Item key="info+" id="info+" className="!text-xs">info+ (all alerts)</Dropdown.Item>
                  <Dropdown.Item key="warning+" id="warning+" className="!text-xs">warning+ (skip info)</Dropdown.Item>
                  <Dropdown.Item key="critical" id="critical" className="!text-xs">critical only</Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-wd-muted">Events channels receive by default</label>
            <EventFilterToggle
              label="Incident Opened"
              value={draft.defaultEventFilters.sendOpen}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  defaultEventFilters: { ...d.defaultEventFilters, sendOpen: v },
                }))
              }
            />
            <EventFilterToggle
              label="Incident Resolved"
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
        </section>

        {/* Quiet hours */}
        <section className="space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-wd-muted">
            Global quiet hours
          </h3>
          <p className="text-[11px] text-wd-muted">
            During the window below, non-critical alerts are held back. Critical always fires.
          </p>
          <QuietHoursEditor
            value={draft.globalQuietHours ?? null}
            onChange={(v) => setDraft((d) => ({ ...d, globalQuietHours: v }))}
          />
        </section>

        {/* Global mute */}
        <section className="space-y-3 md:col-span-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-wd-muted">
            Global mute
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {MUTE_PRESETS.map((p) => {
              const active =
                (p.id === 'none' && !muteStatus.active) ||
                (p.seconds != null && muteStatus.active &&
                  Math.abs(
                    new Date(draft.globalMuteUntil ?? 0).getTime() - (Date.now() + p.seconds * 1000),
                  ) < 10_000)
              return (
                <Button
                  key={p.id}
                  size="sm"
                  variant="bordered"
                  className={`!text-[11px] ${active ? '!border-wd-primary/60 !text-wd-primary' : ''}`}
                  onPress={() => applyMutePreset(p.id)}
                >
                  {p.label}
                </Button>
              )
            })}
          </div>
          {muteStatus.active && (
            <div className="rounded-lg bg-wd-warning/10 border border-wd-warning/30 px-3 py-2 text-[11px] text-wd-warning flex items-center gap-2">
              <Icon icon="solar:bell-off-bold" width={16} />
              All dispatches paused until <span className="font-mono">{muteStatus.until}</span>.
            </div>
          )}
        </section>

        {/* Digest preview */}
        <section className="space-y-3 md:col-span-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-wd-muted">
            Digest mode (preview)
          </h3>
          <div className="flex items-center justify-between rounded-lg border border-wd-border/50 bg-wd-surface-hover/30 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-foreground">Collapse Dispatches Into a Digest</div>
              <div className="text-[11px] text-wd-muted">
                V1 stores the setting for V1.5 batching. Individual dispatches still fire now.
              </div>
            </div>
            <Switch
              isSelected={draft.digestMode?.enabled === true}
              onValueChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  digestMode: v
                    ? { enabled: true, intervalMinutes: d.digestMode?.intervalMinutes ?? 15 }
                    : null,
                }))
              }
            />
          </div>
          {draft.digestMode?.enabled && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-wd-muted">Every</label>
              <Input
                size="sm"
                type="number"
                min={1}
                max={1440}
                value={String(draft.digestMode.intervalMinutes)}
                onChange={(e) => {
                  const v = Math.max(1, Number((e.target as HTMLInputElement).value) || 15)
                  setDraft((d) => ({
                    ...d,
                    digestMode: { enabled: true, intervalMinutes: v },
                  }))
                }}
                className="!w-24 !font-mono"
              />
              <span className="text-[11px] text-wd-muted">minutes</span>
            </div>
          )}
        </section>
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
    <div className="flex items-center justify-between rounded-lg bg-wd-surface-hover/30 px-3 py-1.5">
      <span className="text-xs text-foreground">{label}</span>
      <Switch size="sm" isSelected={value} onValueChange={onChange} />
    </div>
  )
}

function QuietHoursEditor({
  value,
  onChange,
}: {
  value: QuietHours | null
  onChange: (v: QuietHours | null) => void
}) {
  const enabled = value != null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg bg-wd-surface-hover/30 px-3 py-1.5">
        <span className="text-xs text-foreground">Enable Quiet Hours</span>
        <Switch
          size="sm"
          isSelected={enabled}
          onValueChange={(v) => {
            if (!v) onChange(null)
            else
              onChange({
                start: '22:00',
                end: '06:00',
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              })
          }}
        />
      </div>
      {enabled && value && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-wd-muted">Start (HH:MM)</label>
            <Input
              size="sm"
              value={value.start}
              onChange={(e) => onChange({ ...value, start: (e.target as HTMLInputElement).value })}
              placeholder="22:00"
              className="!font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-wd-muted">End (HH:MM)</label>
            <Input
              size="sm"
              value={value.end}
              onChange={(e) => onChange({ ...value, end: (e.target as HTMLInputElement).value })}
              placeholder="06:00"
              className="!font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-wd-muted">Timezone</label>
            <Input
              size="sm"
              value={value.tz}
              onChange={(e) => onChange({ ...value, tz: (e.target as HTMLInputElement).value })}
              placeholder="Europe/London"
              className="!font-mono"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefsEqual(a: ApiNotificationPreferences, b: ApiNotificationPreferences): boolean {
  if (a.defaultSeverityFilter !== b.defaultSeverityFilter) return false
  if (!eventFiltersEqual(a.defaultEventFilters, b.defaultEventFilters)) return false
  if (!quietHoursEqual(a.globalQuietHours ?? null, b.globalQuietHours ?? null)) return false
  if ((a.globalMuteUntil ?? null) !== (b.globalMuteUntil ?? null)) return false
  if (!digestEqual(a.digestMode ?? null, b.digestMode ?? null)) return false
  return true
}

function eventFiltersEqual(a: EventFilters, b: EventFilters): boolean {
  return (
    a.sendOpen === b.sendOpen &&
    a.sendResolved === b.sendResolved &&
    a.sendEscalation === b.sendEscalation
  )
}

function quietHoursEqual(a: QuietHours | null, b: QuietHours | null): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return a.start === b.start && a.end === b.end && a.tz === b.tz
}

function digestEqual(
  a: { enabled: boolean; intervalMinutes: number } | null,
  b: { enabled: boolean; intervalMinutes: number } | null,
): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return a.enabled === b.enabled && a.intervalMinutes === b.intervalMinutes
}
