import { useXAxisScale, usePlotArea } from 'recharts'
import type { IncidentRange } from '../utils/format'

/**
 * Renders incident/degraded shading in the **foreground** SVG layer.
 *
 * Recharts' built-in <ReferenceArea> always renders behind Area fills,
 * making it invisible when the Area gradient covers the same region.
 * This component uses Recharts 3.x hooks to read axis scales and draws
 * SVG <rect> elements that sit on top of the area fills.
 */
export default function ForegroundReferenceArea({ ranges }: { ranges: IncidentRange[] }) {
  const xScale = useXAxisScale()
  const plotArea = usePlotArea()

  if (!xScale || !plotArea || ranges.length === 0) return null

  return (
    <g className="foreground-reference-areas">
      {ranges.map((r, i) => {
        const x1 = xScale(r.x1)
        const x2 = xScale(r.x2)
        if (x1 == null || x2 == null || isNaN(x1) || isNaN(x2)) return null

        const left = Math.min(x1, x2)
        const width = Math.abs(x2 - x1) || 4 // min 4px so single-point is visible
        const top = plotArea.y
        const height = plotArea.height

        const color = r.type === 'down'
          ? 'var(--wd-danger)'
          : 'var(--wd-warning)'

        return (
          <g key={`fg-ref-${i}`}>
            <rect
              x={left}
              y={top}
              width={width}
              height={height}
              fill={color}
              fillOpacity={0.13}
            />
            {/* Left border */}
            <line
              x1={left}
              y1={top}
              x2={left}
              y2={top + height}
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            {/* Right border */}
            <line
              x1={left + width}
              y1={top}
              x2={left + width}
              y2={top + height}
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          </g>
        )
      })}
    </g>
  )
}
