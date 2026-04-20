/**
 * ToastPlayground — a visual test harness for every toast style the app
 * emits. Lives on the Settings page. Useful for tuning the shell without
 * needing to reproduce the underlying event (db drop, incident, etc.).
 *
 * Buttons are grouped by the subsystem that would normally fire them.
 */
import { Button } from '@heroui/react'
import { Icon } from '@iconify/react'
import { toast, toastPresets } from '../../ui/toast'

interface Trigger {
  label: string
  run: () => void
}

interface Group {
  title: string
  icon: string
  triggers: Trigger[]
}

function mockIncidentId(): string {
  return `inc_${Math.random().toString(36).slice(2, 8)}`
}

const groups: Group[] = [
  {
    title: 'Endpoints',
    icon: 'solar:global-linear',
    triggers: [
      {
        label: 'Endpoint Added',
        run: () =>
          toast.success('Endpoint added', {
            description: 'api.example.com is now being checked every 60s.',
          }),
      },
      {
        label: 'Endpoint Updated',
        run: () =>
          toast.info('Endpoint updated', {
            description: 'Check interval changed from 60s to 30s.',
          }),
      },
      {
        label: 'Endpoint Paused',
        run: () =>
          toast.neutral('Endpoint paused', {
            description: 'auth.example.com is paused until you resume it.',
          }),
      },
      {
        label: 'Endpoint Deleted',
        run: () =>
          toast.neutral('Endpoint deleted', {
            description: '“payments-api” removed along with 42d of history.',
          }),
      },
      {
        label: 'Check Failed',
        run: () =>
          toast.error('Check failed — api.example.com', {
            description: 'HTTP 500 · 1.3s · expected 2xx',
            actions: [
              {
                label: 'View Endpoint',
                variant: 'primary',
                href: '/endpoints',
              },
            ],
          }),
      },
      {
        label: 'Endpoint Degraded',
        run: () =>
          toast.warning('Endpoint degraded — auth.example.com', {
            description: 'p95 latency 2,180ms over last 5 min (threshold 1,500ms).',
          }),
      },
      {
        label: 'SSL Cert Expiring',
        run: () =>
          toast.warning('TLS certificate expires in 9 days', {
            description: 'api.example.com · issued by Let’s Encrypt',
          }),
      },
    ],
  },
  {
    title: 'Incidents',
    icon: 'solar:siren-rounded-linear',
    triggers: [
      {
        label: 'Incident Opened',
        run: () =>
          toastPresets.incidentOpened({
            incidentId: mockIncidentId(),
            endpointName: 'api.example.com',
          }),
      },
      {
        label: 'Incident Resolved',
        run: () =>
          toastPresets.incidentResolved({
            incidentId: mockIncidentId(),
            endpointName: 'api.example.com',
            durationSeconds: 312,
          }),
      },
      {
        label: 'Incident Escalated',
        run: () =>
          toast.error('Incident escalated — payments-api', {
            description: 'Still failing after 15 min · paging on-call.',
            link: { label: 'View', href: '/incidents' },
          }),
      },
      {
        label: 'Maintenance Started',
        run: () =>
          toastPresets.maintenanceStarted(
            'api.example.com',
            new Date(Date.now() + 45 * 60 * 1000),
          ),
      },
      {
        label: 'Maintenance Ended',
        run: () => toastPresets.maintenanceEnded('api.example.com'),
      },
    ],
  },
  {
    title: 'Notifications',
    icon: 'solar:bell-bing-linear',
    triggers: [
      {
        label: 'Dispatched',
        run: () => toastPresets.notificationDispatched('#ops-alerts', 'incident:opened'),
      },
      {
        label: 'Dispatch Failed (With Retry)',
        run: () =>
          toastPresets.notificationFailed({
            channelId: 'ch_slack_ops',
            channelName: '#ops-alerts',
            reason: 'Slack API returned 503 — service unavailable',
            onRetry: () =>
              toast.success('Retry queued', { description: 'We’ll try again in a few seconds.' }),
          }),
      },
      {
        label: 'Channel Saved',
        run: () =>
          toast.success('Channel saved', {
            description: 'Discord · #alerts · severity ≥ warning',
          }),
      },
      {
        label: 'Channel Test Sent',
        run: () =>
          toast.info('Test notification sent', {
            description: 'Check #ops-alerts to confirm delivery.',
          }),
      },
      {
        label: 'Mute Applied',
        run: () =>
          toast.info('All notifications muted for 1h', {
            description: 'Critical alerts will still fire.',
          }),
      },
      {
        label: 'Mute Lifted',
        run: () => toast.neutral('Notifications unmuted'),
      },
    ],
  },
  {
    title: 'System health',
    icon: 'solar:pulse-2-linear',
    triggers: [
      {
        label: 'DB Disconnected',
        run: () => toastPresets.dbDisconnected('connect ECONNREFUSED 127.0.0.1:27017'),
      },
      {
        label: 'DB Reconnected',
        run: () => toastPresets.dbReconnected(),
      },
      {
        label: 'Buffer Pressure',
        run: () =>
          toastPresets.systemWarning('buffer', 'Memory buffer at 82% capacity — flushing to disk'),
      },
      {
        label: 'Disk Buffer Replay',
        run: () =>
          toast.info('Replaying buffered writes', {
            description: '1,204 records queued from the last outage.',
          }),
      },
      {
        label: 'Disk Full (Critical)',
        run: () => toastPresets.systemCritical('buffer', 'Disk buffer full — new events are being dropped'),
      },
      {
        label: 'High Memory Usage',
        run: () =>
          toast.warning('Process memory > 512 MB', {
            description: 'RSS 548 MB · consider lowering retention.',
          }),
      },
    ],
  },
  {
    title: 'Settings & misc',
    icon: 'solar:settings-linear',
    triggers: [
      {
        label: 'Settings Saved',
        run: () => toast.success('Preferences saved'),
      },
      {
        label: 'Save Failed',
        run: () =>
          toast.error('Save failed', {
            description: 'HTTP 500 — could not reach MongoDB.',
          }),
      },
      {
        label: 'With Action + Link',
        run: () =>
          toast.info('New dashboard version available', {
            description: 'Reload to pick up v1.4.2.',
            actions: [{ label: 'Reload', variant: 'primary', onPress: () => {} }],
            link: { label: 'Release notes', href: '/settings' },
            timeout: null,
          }),
      },
      {
        label: 'Promise (Resolves)',
        run: () => {
          void toast.promise(
            new Promise((resolve) => setTimeout(resolve, 1500)),
            {
              loading: 'Saving changes…',
              success: 'Saved',
              error: 'Save failed',
              descriptionLoading: 'Writing to MongoDB',
              descriptionSuccess: 'Config updated',
            },
          )
        },
      },
      {
        label: 'Promise (Rejects)',
        run: () => {
          void toast
            .promise(
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('ECONNREFUSED')), 1500),
              ),
              {
                loading: 'Testing channel…',
                success: 'Channel responded',
                error: (e) => `Test failed — ${e.message}`,
              },
            )
            .catch(() => {})
        },
      },
      {
        label: 'Loading (Manual Dismiss)',
        run: () => {
          const id = `demo-load-${Math.random().toString(36).slice(2, 6)}`
          toast.loading('Running synthetic check…', {
            id,
            description: 'This one stays open until you resolve it.',
            actions: [
              {
                label: 'Mark done',
                variant: 'primary',
                onPress: () => toast.update(id, { kind: 'success', title: 'Synthetic check passed' }),
              },
            ],
          })
        },
      },
      {
        label: 'Clear All',
        run: () => toast.clear(),
      },
    ],
  },
]

export function ToastPlayground() {
  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface">
      <div className="px-4 py-3 border-b border-wd-border/50">
        <h2 className="text-sm font-semibold text-foreground">Toast Playground</h2>
        <p className="text-[11px] text-wd-muted">
          Fire every toast variant without waiting for the real event. Useful for design review.
        </p>
      </div>

      <div className="p-4 space-y-5">
        {groups.map((g) => (
          <section key={g.title} className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon={g.icon} width={16} className="text-wd-muted" />
              <h3 className="text-[11px] font-mono font-semibold uppercase tracking-wide text-wd-muted">
                {g.title}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {g.triggers.map((t) => (
                <Button
                  key={t.label}
                  size="sm"
                  variant="bordered"
                  className="!text-[11px] !h-7 !px-2.5"
                  onPress={t.run}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
