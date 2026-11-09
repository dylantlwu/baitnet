import { useState } from "react";

export interface Series {
  key: string;
  label: string;
  /** CSS color (token) */
  color: string;
  /** y = null means "no data" (e.g. no regression cases yet): no point is drawn and the line breaks. */
  points: { x: number; y: number | null }[];
}

/** Tick values: quarters for percentages, distinct integers for counts (no "2, 2, 1, 1, 0"). */
export function chartTicks(top: number, integer: boolean): number[] {
  if (!integer) return [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const max = Math.max(1, Math.ceil(top));
  const step = Math.max(1, Math.ceil(max / 4));
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

/** Small dependency-free SVG line chart: integer x (playbook version), shared y scale. */
export function LineChart({
  series, yMax, yFmt, xLabel, title, height = 200, integer = false, emptyLabel,
}: {
  series: Series[];
  yMax: number;
  yFmt: (v: number) => string;
  xLabel: (x: number) => string;
  title: string;
  height?: number;
  integer?: boolean;
  /** Legend text when the hovered/last point has no data. */
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Narrower viewBox on phones so axis text stays legible after scaling.
  const narrow = typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches;
  const W = narrow ? 330 : 480;
  const H = height;
  const pad = { l: 40, r: 14, t: 12, b: 28 };
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const sx = (x: number) => pad.l + (x1 === x0 ? (W - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const ticks = chartTicks(yMax > 0 ? yMax : 1, integer);
  const top = ticks[ticks.length - 1] || 1;
  const sy = (y: number) => pad.t + (1 - y / top) * (H - pad.t - pad.b);
  // Split each series into continuous runs so missing points break the line.
  const runs = (pts: Series["points"]) => {
    const out: { x: number; y: number }[][] = [];
    let cur: { x: number; y: number }[] = [];
    for (const p of pts) {
      if (p.y === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push({ x: p.x, y: p.y });
    }
    if (cur.length) out.push(cur);
    return out;
  };

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={pad.l - 6} y={sy(v) + 3.5} textAnchor="end" className="axis">
              {yFmt(v)}
            </text>
          </g>
        ))}
        {xs.map((x) => (
          <text key={x} x={sx(x)} y={H - 8} textAnchor="middle" className="axis">
            {xLabel(x)}
          </text>
        ))}
        {hover !== null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} className="hover-line" />}
        {series.map((s) => (
          <g key={s.key}>
            {runs(s.points).map((run, i) => (
              <polyline
                key={i}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                points={run.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
              />
            ))}
            {s.points.map((p) =>
              p.y === null ? null : <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={hover === p.x ? 4.5 : 3} fill={s.color} className="pt" />,
            )}
          </g>
        ))}
        {xs.map((x, i) => {
          const prev = i ? sx(xs[i - 1]) : pad.l;
          const next = i < xs.length - 1 ? sx(xs[i + 1]) : W - pad.r;
          const a = i ? (prev + sx(x)) / 2 : pad.l;
          const b = i < xs.length - 1 ? (sx(x) + next) / 2 : W - pad.r;
          return <rect key={x} x={a} y={pad.t} width={b - a} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(x)} onClick={() => setHover(x)} />;
        })}
      </svg>
      <div className="chart-legend">
        {series.map((s) => {
          const p = hover !== null ? s.points.find((q) => q.x === hover) : s.points[s.points.length - 1];
          return (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
              {p && <b>{p.y === null ? (emptyLabel ?? "—") : yFmt(p.y)}</b>}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
