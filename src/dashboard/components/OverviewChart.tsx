import { useState, useCallback, useEffect } from 'react'
import { Card, Dropdown, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { IncidentRange } from '../utils/format'
import ForegroundReferenceArea from './ForegroundReferenceArea'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeriesConfig {
  key: string
  label: string
  color: string
  icon: string
  /** Current / summary value shown in the mini KPI */
  value: string
  /** Change text e.g. "+2.1%" */
  change: string
  /** Whether change is positive (green) or negative (red) */
  changeType: 'positive' | 'negative' | 'neutral'
}

interface OverviewChartProps {
  title: string
  icon: string
  series: SeriesConfig[]
  data: Record<string, string | number>[]
  unit?: string
  /** Series keys to start toggled off */
  defaultHidden?: string[]
  /** Optional incident/degraded ranges to shade on the chart */
  highlightRanges?: IncidentRange[]
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltipContent({
  active,
  payload,
  label,
  series,
  unit,
  highlightRanges,
}: {
  active?: boolean
  payload?: Array<{ dataKey: string; value: number; color: string }>
  label?: string
  series: SeriesConfig[]
  unit?: string
  highlightRanges?: IncidentRange[]
}) {
  if (!active || !payload?.length) return null

  const matchedRange = highlightRanges?.find(
    (r) => label != null && label >= r.x1 && label <= r.x2,
  )

  return (
    <div className="rounded-lg bg-wd-surface border border-wd-border px-3 py-2 shadow-lg max-w-[280px]">
      <div className="text-[11px] font-mono text-wd-muted mb-1.5">{label}</div>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => {
          const s = series.find((s) => s.key === entry.dataKey)
          return (
            <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
              {s?.icon ? (
                <Icon icon={s.icon} width={16} style={{ color: entry.color }} className="shrink-0" />
              ) : (
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
              )}
              <span className="text-wd-muted [word-break:normal] [overflow-wrap:normal]">{s?.label ?? entry.dataKey}:</span>
              <span className="font-mono font-semibold text-foreground">
                {entry.value}
                {unit}
              </span>
            </div>
          )
        })}
      </div>
      {matchedRange && (
        <div className="flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-wd-border/50 text-[11px] font-medium text-wd-warning">
          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-wd-warning" />
          {matchedRange.type === 'down' ? 'Endpoint outage during this period' : 'Degraded performance during this period'}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const changeColor = (type: SeriesConfig['changeType']) => {
  if (type === 'positive') return 'text-wd-success'
  if (type === 'negative') return 'text-wd-danger'
  return 'text-wd-muted'
}

const changeBg = (type: SeriesConfig['changeType']) => {
  if (type === 'positive') return 'bg-wd-success/10'
  if (type === 'negative') return 'bg-wd-danger/10'
  return 'bg-wd-surface-hover'
}

// ---------------------------------------------------------------------------
// OverviewChart
// ---------------------------------------------------------------------------

export default function OverviewChart({ title, icon: titleIcon, series, data, unit, defaultHidden, highlightRanges }: OverviewChartProps) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(defaultHidden ?? []))

  // Sync defaultHidden when data changes (e.g. time range switch)
  useEffect(() => {
    setHiddenSeries(new Set(defaultHidden ?? []))
  }, [defaultHidden?.join(',')])

  const toggleSeries = useCallback((key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <Card className="relative !bg-wd-surface !shadow-none !border !border-wd-border/50 !rounded-xl !p-0 !overflow-visible">
      {/* Dropdown menu — top right */}
      <div className="absolute top-3 right-3 z-20" onClick={(e) => e.stopPropagation()}>
        <Dropdown>
          <Dropdown.Trigger>
            <div
              role="button"
              tabIndex={0}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:bg-wd-surface-hover cursor-pointer transition-colors"
            >
              <Icon className="text-wd-muted" height={16} icon="solar:menu-dots-bold" width={16} />
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end" className="!min-w-[120px]">
            <Dropdown.Menu>
              <Dropdown.Item id="export-csv" className="!text-xs">Export CSV</Dropdown.Item>
              <Dropdown.Item id="export-png" className="!text-xs">Export PNG</Dropdown.Item>
              <Dropdown.Item id="fullscreen" className="!text-xs">Fullscreen</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      <div className="p-4 pb-0">
        {/* Title with icon */}
        <div className="flex items-center gap-2 mb-4">
          <Icon icon={titleIcon} width={20} className="text-wd-muted" />
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>

        {/* Toggleable KPI stat cards — clicking hides/shows the series */}
        <div className={cn('grid gap-3 mb-4', series.length <= 3 ? 'grid-cols-3' : 'grid-cols-4')}>
          {series.map((s) => {
            const hidden = hiddenSeries.has(s.key)
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleSeries(s.key)}
                className={cn(
                  'flex flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left transition-all cursor-pointer',
                  'bg-wd-surface-hover/50 hover:bg-wd-surface-hover',
                  hidden ? 'opacity-40' : 'opacity-100',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Icon icon={s.icon} width={16} style={{ color: s.color }} className="shrink-0" />
                  <span className="text-[11px] text-wd-muted">{s.label}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-mono font-semibold tracking-tight text-foreground">{s.value}</span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-1.5 py-0 text-[10px] font-mono font-medium',
                      changeBg(s.changeType),
                      changeColor(s.changeType),
                    )}
                  >
                    {s.change}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Chart */}
      <div className="h-56 px-2 pb-4 select-none">
        <ResponsiveContainer className="[&_.recharts-surface]:outline-hidden [&_*:focus]:!outline-none" width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`overviewGrad-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.12} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--wd-border)"
              strokeOpacity={0.5}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--wd-muted)' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--wd-muted)' }}
              tickLine={false}
              axisLine={false}
              domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 100]}
            />
            <RechartsTooltip
              content={<ChartTooltipContent series={series} unit={unit} highlightRanges={highlightRanges} />}
              cursor={{ stroke: 'var(--wd-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            {series.map((s) =>
              hiddenSeries.has(s.key) ? null : (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#overviewGrad-${s.key})`}
                  fillOpacity={1}
                  type="monotone"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              ),
            )}
            {/* Foreground incident/degraded shading — must be AFTER Areas
                so the SVG elements render on top of area fills */}
            {highlightRanges && highlightRanges.length > 0 && (
              <ForegroundReferenceArea ranges={highlightRanges} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
