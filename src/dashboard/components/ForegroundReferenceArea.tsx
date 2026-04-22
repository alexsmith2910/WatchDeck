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

  // Minimum visible width for a shaded range. On dense charts (e.g. 1440
  // raw checks across 24h), a single failing point spans well under 1px
  // when drawn between two adjacent label positions — enough to be
  // mathematically correct but invisible. Clamping ensures every range
  // reads as a real band.
  const MIN_WIDTH_PX = 6

  return (
    <g className="foreground-reference-areas">
      {ranges.map((r, i) => {
        const x1 = xScale(r.x1)
        const x2 = xScale(r.x2)
        if (x1 == null || x2 == null || isNaN(x1) || isNaN(x2)) return null

        const rawLeft = Math.min(x1, x2)
        const rawWidth = Math.abs(x2 - x1)
        const width = Math.max(rawWidth, MIN_WIDTH_PX)
        // If we expanded the width, center the band on the original midpoint
        // so a single-point shade stays visually anchored to its data point.
        const left = rawWidth < MIN_WIDTH_PX
          ? rawLeft + rawWidth / 2 - width / 2
          : rawLeft
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
