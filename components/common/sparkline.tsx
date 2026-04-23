import React, { useMemo } from "react";

/**
 * Pure-SVG sparkline. No dependencies. Pass a numeric series; it renders a
 * baselined line chart that fills the supplied width × height.
 *
 * Data layout: `points` is in chronological order (oldest → newest). The
 * component doesn't care about gaps — it just evenly distributes points
 * along the x-axis. If you want gap-aware rendering (skip missing days),
 * preprocess the series on the call site.
 *
 * Design choices:
 * - Baseline is the series minimum, not zero — sparkline is about shape,
 *   not absolute scale. If every point is identical, the line sits mid-height.
 * - Single color via `stroke`. A filled gradient area is toggleable via
 *   `fill` (emits a <path> that closes to the baseline).
 * - A terminal dot on the last point helps the eye anchor the "current"
 *   value. Toggleable via `showLast`.
 */

type Point = number | { value: number; label?: string };

type SparklineProps = {
  points:       Point[];
  width?:       number;   // px, default 80
  height?:      number;   // px, default 24
  stroke?:      string;   // CSS color
  fill?:        string;   // optional area fill under the line (color w/ alpha)
  strokeWidth?: number;   // default 1.5
  showLast?:    boolean;  // draw a terminal dot at the last point
  className?:   string;
  title?:       string;   // SVG <title> for accessibility
};

function asNumber(p: Point): number {
  return typeof p === "number" ? p : p.value;
}

export function Sparkline({
  points,
  width = 80,
  height = 24,
  stroke = "currentColor",
  fill,
  strokeWidth = 1.5,
  showLast = true,
  className,
  title,
}: SparklineProps) {
  const { linePath, areaPath, lastCoord } = useMemo(() => {
    const values = points.map(asNumber);
    const n = values.length;
    if (n === 0) return { linePath: "", areaPath: "", lastCoord: null };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1; // avoid div-by-zero for flat series

    // Add half-pixel padding so the stroke isn't clipped at the edges.
    const pad = strokeWidth / 2;
    const w = width  - pad * 2;
    const h = height - pad * 2;
    const stepX = n > 1 ? w / (n - 1) : 0;

    const coords: Array<[number, number]> = values.map((v, i) => {
      const x = pad + i * stepX;
      // Flat series renders mid-height instead of pinned to top.
      const t = span === 1 && max === min ? 0.5 : (v - min) / span;
      const y = pad + (1 - t) * h;
      return [x, y];
    });

    const linePath = coords
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");

    const areaPath = fill
      ? `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${(pad + h).toFixed(1)} L${coords[0][0].toFixed(1)},${(pad + h).toFixed(1)} Z`
      : "";

    return { linePath, areaPath, lastCoord: coords[coords.length - 1] };
  }, [points, width, height, strokeWidth, fill]);

  if (points.length === 0) return null;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? "sparkline"}
    >
      {title && <title>{title}</title>}
      {areaPath && (
        <path d={areaPath} fill={fill} stroke="none" />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showLast && lastCoord && (
        <circle
          cx={lastCoord[0]}
          cy={lastCoord[1]}
          r={Math.max(1.5, strokeWidth)}
          fill={stroke}
        />
      )}
    </svg>
  );
}
