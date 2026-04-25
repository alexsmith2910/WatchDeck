/**
 * Modules panel — read-only view of `ctx.config.modules`. Which backend
 * modules are loaded into memory is decided at boot, so changing any of
 * these requires editing `watchdeck.config.js` and restarting the process.
 *
 *   GET /modules
 */
import { Icon } from '@iconify/react'
import { cn } from '@heroui/react'
import { SectionHead } from '../../endpoint-detail/primitives'
import { useModules } from '../../../hooks/useModules'

interface ModuleInfo {
  key: keyof ReturnType<typeof useModules>['modules']
  label: string
  description: string
  icon: string
}

const MODULES: ModuleInfo[] = [
  {
    key: 'sslChecks',
    label: 'SSL checks',
    description: 'Capture TLS certificate expiry on every HTTPS probe.',
    icon: 'solar:shield-keyhole-linear',
  },
  {
    key: 'portChecks',
    label: 'Port checks',
    description: 'TCP connection-attempt endpoints (type: "port").',
    icon: 'solar:lan-connection-linear',
  },
]

export function ModulesPanel() {
  const { modules, loaded } = useModules()

  return (
    <div className="rounded-xl border border-wd-border/50 bg-wd-surface p-5">
      <SectionHead
        icon="solar:layers-minimalistic-outline"
        title="Modules"
        sub="Each module is loaded into memory at boot. Changing state requires a restart."
      />

      <div className="space-y-2">
        {MODULES.map((m) => {
          const on = loaded ? modules[m.key] : true
          return (
            <div
              key={m.key}
              className="flex items-center gap-3 rounded-lg border border-wd-border/40 bg-wd-surface-hover/30 px-3 py-2.5"
            >
              <div
                className={cn(
                  'flex items-center justify-center w-8 h-8 rounded-lg shrink-0',
                  on ? 'bg-wd-primary/10 text-wd-primary' : 'bg-wd-muted/10 text-wd-muted',
                )}
              >
                <Icon icon={m.icon} width={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-foreground">{m.label}</div>
                <div className="text-[11px] text-wd-muted">{m.description}</div>
              </div>
              <ModulePill on={on} />
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-wd-border/40 bg-wd-surface-hover/20 px-3 py-2 text-[11.5px] text-wd-muted">
        <Icon icon="solar:info-circle-linear" width={14} className="mt-0.5 shrink-0" />
        <span>
          To change module state, edit <span className="font-mono text-foreground">watchdeck.config.js</span> under{' '}
          <span className="font-mono text-foreground">modules.*</span> and restart the process.
        </span>
      </div>
    </div>
  )
}

function ModulePill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-mono font-medium uppercase tracking-wide',
        on ? 'bg-wd-success/15 text-wd-success' : 'bg-wd-muted/15 text-wd-muted',
      )}
    >
      <span className={cn('inline-block w-1.5 h-1.5 rounded-full', on ? 'bg-wd-success' : 'bg-wd-muted')} />
      {on ? 'Enabled' : 'Disabled'}
    </span>
  )
}
