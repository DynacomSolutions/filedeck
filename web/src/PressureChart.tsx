import { linePaths, niceMax, type PressureSample } from "./pressure";

const WIDTH = 300;
const HEIGHT = 84;

export interface ChartSeries {
  key: string;
  label: string;
  pick: (sample: PressureSample) => number;
  /** the second series of a chart is dashed too, so colour is never the only difference */
  dashed?: boolean;
}

export interface PressureChartProps {
  title: string;
  series: ChartSeries[];
  /** samples inside the window, oldest first */
  samples: readonly PressureSample[];
  minutes: number;
  format: (value: number) => string;
  /** fixed top of the axis, for ratios; otherwise the axis follows the data */
  yMax?: number;
  /** smallest top of the axis, so a quiet disk does not fill the chart with noise */
  floor?: number;
  intervalMs?: number;
}

/** A light SVG line chart: axes, one or two series, no dependency. The newest sample ends the time axis. */
export function PressureChart({ title, series, samples, minutes, format, yMax, floor = 1, intervalMs = 1000 }: PressureChartProps) {
  const last = samples.at(-1);
  const to = last?.at ?? 0;
  const from = to - minutes * 60_000;
  const peak = Math.max(0, ...samples.flatMap((sample) => series.map((s) => s.pick(sample))));
  const top = yMax ?? niceMax(peak, floor);
  const summary = last
    ? series.map((s) => `${s.label} ${format(s.pick(last))}`).join(", ") + `. Peak ${format(peak)} in the last ${minutes} min.`
    : "No samples yet.";
  return (
    <figure className="pressure-chart">
      <figcaption>
        <span className="pressure-chart-title">{title}</span>
        <span className="pressure-legend">
          {series.map((s, i) => (
            <span key={s.key} className={`pressure-key pressure-s${i}`}>
              <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true" focusable="false"><line x1="0" y1="4" x2="18" y2="4" strokeDasharray={s.dashed ? "4 3" : undefined} /></svg>
              {s.label} <strong>{last ? format(s.pick(last)) : "–"}</strong>
            </span>
          ))}
        </span>
      </figcaption>
      <div className="pressure-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${title}: ${summary}`} focusable="false">
          {[0, 0.5, 1].map((f) => <line key={f} className="pressure-grid" x1="0" x2={WIDTH} y1={HEIGHT * f} y2={HEIGHT * f} />)}
          {series.map((s, i) => linePaths(samples, s.pick, from, to, top, { width: WIDTH, height: HEIGHT }, intervalMs * 3).map((d, n) => (
            <path key={`${s.key}${n}`} d={d} className={`pressure-line pressure-s${i}`} strokeDasharray={s.dashed ? "5 3" : undefined} />
          )))}
        </svg>
        <span className="pressure-axis pressure-axis-top" aria-hidden="true">{format(top)}</span>
        <span className="pressure-axis pressure-axis-bottom" aria-hidden="true">0</span>
      </div>
      <div className="pressure-time" aria-hidden="true"><span>{minutes} min ago</span><span>now</span></div>
    </figure>
  );
}
