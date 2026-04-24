/**
 * Ring chart of healthy / degraded / down / paused fleet counts.
 * Pure SVG — no recharts so the inner number stays crisp at small sizes.
 */
import { memo } from "react";

interface FleetRingProps {
  healthy: number;
  degraded: number;
  down: number;
  paused: number;
  size?: number;
  thickness?: number;
}

function FleetRingBase({
  healthy,
  degraded,
  down,
  paused,
  size = 128,
  thickness = 10,
}: FleetRingProps) {
  const total = healthy + degraded + down + paused;
  const r = size / 2 - thickness;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;

  const segs = [
    { v: healthy, color: "var(--wd-success)" },
    { v: degraded, color: "var(--wd-warning)" },
    { v: down, color: "var(--wd-danger)" },
    { v: paused, color: "var(--wd-muted)" },
  ];

  let offset = 0;
  const drawn = segs
    .filter((s) => s.v > 0)
    .map((s, i) => {
      const len = total > 0 ? (s.v / total) * C : 0;
      const arc = (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth={thickness}
          strokeDasharray={`${len} ${C - len}`}
          strokeDashoffset={-offset}
          strokeLinecap="butt"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      );
      offset += len;
      return arc;
    });

  return (
    <svg width={size} height={size} className="shrink-0">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--wd-border)"
        strokeOpacity="0.6"
        strokeWidth={thickness}
      />
      {total > 0 && drawn}
      <text
        x={cx}
        y={cy - 2}
        textAnchor="middle"
        className="font-mono fill-foreground"
        fontSize={size >= 160 ? 34 : size > 100 ? 26 : 20}
        fontWeight={600}
        letterSpacing="-0.02em"
      >
        {total}
      </text>
      <text
        x={cx}
        y={cy + (size >= 160 ? 20 : 14)}
        textAnchor="middle"
        className="fill-wd-muted"
        fontSize={size >= 160 ? 11 : 9.5}
        fontFamily="var(--font-mono)"
        letterSpacing="0.06em"
      >
        TOTAL
      </text>
    </svg>
  );
}

export const FleetRing = memo(FleetRingBase);
