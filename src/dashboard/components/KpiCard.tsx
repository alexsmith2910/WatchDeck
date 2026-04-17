import React from 'react'
import { Card, Dropdown, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { Area, AreaChart, ResponsiveContainer, YAxis, Tooltip as RechartsTooltip } from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendDirection = 'up' | 'down' | 'flat'

type KpiColor = 'primary' | 'success' | 'warning' | 'danger'

interface ChartData {
  label: string
  value: number
}

interface ChangeSegment {
  text: string
  color: KpiColor
}

interface KpiCardProps {
  title: string
  value: string | number
  /** Simple string change with trend arrow, OR use changeSegments for multi-colored text */
  change?: string
  changeColor?: KpiColor
  changeLabel?: string
  trend?: TrendDirection
  /** Multi-colored change segments (e.g. "7 up" green + "1 down" red) */
  changeSegments?: ChangeSegment[]
  icon: string
  color: KpiColor
  chartData: ChartData[]
  index: number
  unit?: string
  onClick?: () => void
}

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

const colorMap: Record<KpiColor, { iconBg: string; iconText: string; chartColor: string }> = {
  primary: {
    iconBg: 'bg-wd-primary/15',
    iconText: 'text-wd-primary',
    chartColor: 'var(--wd-primary)',
  },
  success: {
    iconBg: 'bg-wd-success/15',
    iconText: 'text-wd-success',
    chartColor: 'var(--wd-success)',
  },
  warning: {
    iconBg: 'bg-wd-warning/15',
    iconText: 'text-wd-warning',
    chartColor: 'var(--wd-warning)',
  },
  danger: {
    iconBg: 'bg-wd-danger/15',
    iconText: 'text-wd-danger',
    chartColor: 'var(--wd-danger)',
  },
}

const changeColorClass: Record<KpiColor, string> = {
  primary: 'text-wd-primary',
  success: 'text-wd-success',
  warning: 'text-wd-warning',
  danger: 'text-wd-danger',
}

const trendIcons: Record<TrendDirection, string> = {
  up: 'solar:arrow-right-up-linear',
  down: 'solar:arrow-right-down-linear',
  flat: 'solar:arrow-right-linear',
}

// ---------------------------------------------------------------------------
// Custom chart tooltip
// ---------------------------------------------------------------------------

function ChartTooltipContent({ active, payload, unit }: { active?: boolean; payload?: Array<{ value: number; payload: ChartData }>; unit?: string }) {
  if (!active || !payload?.length) return null
  const data = payload[0]
  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-2.5 py-1.5 shadow-lg">
      <div className="text-[11px] text-wd-muted">{data.payload.label}</div>
      <div className="text-xs font-semibold text-foreground">{data.value}{unit}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KpiCard
// ---------------------------------------------------------------------------

const KpiCard = React.forwardRef<HTMLDivElement, KpiCardProps>(
  ({ title, value, change, changeColor, changeLabel, trend, changeSegments, icon, color, chartData, index, unit, onClick }, ref) => {
    const colors = colorMap[color]

    return (
      <Card
        ref={ref}
        className={cn(
          'relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible',
          onClick && 'cursor-pointer active:scale-[0.98] transition-transform',
        )}
        onClick={onClick}
      >
        {/* Dropdown — z-20 so it sits on top of chart */}
        <div className="absolute top-2 right-2 z-20" onClick={(e) => e.stopPropagation()}>
          <Dropdown>
            <Dropdown.Trigger>
              <div
                role="button"
                tabIndex={0}
                className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:bg-wd-surface-hover cursor-pointer transition-colors"
              >
                <Icon className="text-wd-muted" height={14} icon="solar:menu-dots-bold" width={14} />
              </div>
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="!min-w-[120px]">
              <Dropdown.Menu>
                <Dropdown.Item id="view-details" className="!text-xs">View Details</Dropdown.Item>
                <Dropdown.Item id="export-data" className="!text-xs">Export Data</Dropdown.Item>
                <Dropdown.Item id="set-alert" className="!text-xs">Set Alert</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
        <section className="flex flex-nowrap justify-between">
          <div className="flex flex-col justify-between gap-y-2 p-3">
            <div className="flex flex-col gap-y-3">
              <div className="flex items-center gap-x-2.5">
                <div className={cn('rounded-lg p-1.5', colors.iconBg, colors.iconText)}>
                  <Icon className="text-inherit" height={16} icon={icon} width={16} />
                </div>
                <dt className="text-sm font-medium text-wd-muted">{title}</dt>
              </div>
              <dd className="text-3xl font-semibold text-foreground">{value}</dd>
            </div>
            <div className="mt-1 flex items-center gap-x-1 text-xs font-medium">
              {changeSegments ? (
                <div className="flex items-center gap-x-1.5">
                  {changeSegments.map((seg, i) => (
                    <span key={i} className={changeColorClass[seg.color]}>{seg.text}</span>
                  ))}
                </div>
              ) : (
                <>
                  {trend && <Icon height={16} icon={trendIcons[trend]} width={16} className={changeColor ? changeColorClass[changeColor] : ''} />}
                  {change && <span className={changeColor ? changeColorClass[changeColor] : ''}>{change}</span>}
                  {changeLabel && <span className="text-wd-muted"> {changeLabel}</span>}
                </>
              )}
            </div>
          </div>
          <div className="mt-8 min-h-24 flex-1 min-w-[100px] shrink-0 overflow-hidden select-none pr-3">
            <ResponsiveContainer className="[&_.recharts-surface]:outline-hidden [&_*:focus]:!outline-none" width="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id={`kpiGrad${index}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="5%" stopColor={colors.chartColor} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={colors.chartColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <YAxis domain={[Math.min(...chartData.map((d) => d.value)), 'auto']} hide />
                <RechartsTooltip
                  content={<ChartTooltipContent unit={unit} />}
                  cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                />
                <Area
                  dataKey="value"
                  fill={`url(#kpiGrad${index})`}
                  stroke={colors.chartColor}
                  type="monotone"
                  fillOpacity={1}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      </Card>
    )
  },
)

KpiCard.displayName = 'KpiCard'

export default KpiCard
export type { KpiCardProps }
