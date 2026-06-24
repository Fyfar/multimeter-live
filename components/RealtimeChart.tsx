'use client';

import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  Chart,
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  BarController,
  BarElement,
  PointElement,
  Filler,
  Decimation,
  Tooltip,
  Legend,
  type ChartConfiguration,
} from 'chart.js';
import { resolutionDecimals } from '@/lib/parser';

Chart.register(
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  BarController,
  BarElement,
  PointElement,
  Filler,
  Decimation,
  Tooltip,
  Legend,
);

export interface ChartPoint {
  ts: number;    // Date.now() when the reading was parsed
  v: number;     // normalized value (OL readings are skipped, never charted)
  oor?: boolean; // out-of-range: outside user-defined min/max
}

export type TimeRange = '10s' | '1m' | '10m' | '1h' | 'all';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '10s': 10_000,
  '1m': 60_000,
  '10m': 600_000,
  '1h': 3_600_000,
  // Infinity disables the window filter so every buffered point is plotted.
  all: Infinity,
};

const TIME_RANGE_LABELS: TimeRange[] = ['10s', '1m', '10m', '1h', 'all'];

export type ChartType = 'line' | 'histogram';

const CHART_TYPE_LABELS: { type: ChartType; label: string }[] = [
  { type: 'line', label: 'Line' },
  { type: 'histogram', label: 'Histogram' },
];

// Fallback bin count when the device resolution (LSD) isn't known, dividing the
// value range into this many equal-width buckets.
const BIN_COUNT = 25;
// Minimum window the LSD histogram always shows: the center bin plus 10 bins on
// each side, so a steady (or not-yet-started) reading still has visible context
// around it instead of a single fat bar.
const MIN_BINS = 21;
// Cap on the in-range window: the center bin plus this many bins on each side.
// Data within the window shows at native LSD resolution; values beyond it collect
// into under-/over-range edge bins instead of stretching (and flattening) the view.
const MAX_HALF_BINS = 100;

const IN_RANGE_COLOR = 'rgba(59,130,246,0.6)'; // blue — normal bins
const OUTLIER_COLOR = 'rgba(245,158,11,0.7)';  // amber — under/over-range bins

// Bin label tied to width so adjacent labels stay distinct (width 1 -> 0 decimals,
// 0.001 -> 3); avoids the duplicate labels fixed-precision formatting would produce.
const formatBinLabel = (v: number, width: number): string => v.toFixed(resolutionDecimals(width));

type Histogram = { labels: string[]; counts: number[]; colors: string[] };

/** Min and max of a non-empty array in a single pass. */
function minMax(values: number[]): [number, number] {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * LSD grid: bins are integer multiples of `width`, anchored at zero, so each bar is
 * centered on (and labeled with) an actual value the meter can display. The window
 * is centered on `centerValue` (the dominant/most-held value when recording, or the
 * live value when empty), shows at least MIN_BINS, and expands to include data
 * within MAX_HALF_BINS of the center. Values beyond the window collect into a single
 * under-range bin (left) and over-range bin (right) so a lone outlier doesn't
 * stretch the whole view.
 */
function buildLsdHistogram(values: number[], width: number, centerValue: number | undefined): Histogram {
  const c = Number.isFinite(centerValue) ? (centerValue as number) : (values.length > 0 ? values[0] : 0);
  const centerBin = Math.round(c / width);
  const minHalf = Math.floor((MIN_BINS - 1) / 2);

  // Window: MIN_BINS around the center, expanded to include any data within
  // MAX_HALF_BINS of the center (so a genuine spread still shows in full).
  let lo = centerBin - minHalf;
  let hi = centerBin + minHalf;
  for (const v of values) {
    const b = Math.round(v / width);
    if (b >= centerBin - MAX_HALF_BINS && b <= centerBin + MAX_HALF_BINS) {
      if (b < lo) lo = b;
      if (b > hi) hi = b;
    }
  }

  const inCount = hi - lo + 1;
  const inRange = new Array<number>(inCount).fill(0);
  let under = 0;
  let over = 0;
  for (const v of values) {
    const b = Math.round(v / width);
    if (b < lo) under += 1;
    else if (b > hi) over += 1;
    else inRange[b - lo] += 1;
  }

  const labels: string[] = [];
  const counts: number[] = [];
  const colors: string[] = [];
  if (under > 0) {
    labels.push(`< ${formatBinLabel(lo * width, width)}`);
    counts.push(under);
    colors.push(OUTLIER_COLOR);
  }
  for (let i = 0; i < inCount; i++) {
    labels.push(formatBinLabel((lo + i) * width, width));
    counts.push(inRange[i]);
    colors.push(IN_RANGE_COLOR);
  }
  if (over > 0) {
    labels.push(`> ${formatBinLabel(hi * width, width)}`);
    counts.push(over);
    colors.push(OUTLIER_COLOR);
  }
  return { labels, counts, colors };
}

/** Fallback when the device LSD is unknown: BIN_COUNT equal-width bins over min→max. */
function buildEqualWidthHistogram(values: number[]): Histogram {
  if (values.length === 0) return { labels: [], counts: [], colors: [] };
  const [min, max] = minMax(values);
  if (min === max) return { labels: [formatBinLabel(min, 1)], counts: [values.length], colors: [IN_RANGE_COLOR] };
  const width = (max - min) / BIN_COUNT;
  const counts = new Array<number>(BIN_COUNT).fill(0);
  const labels = new Array<string>(BIN_COUNT);
  for (let i = 0; i < BIN_COUNT; i++) labels[i] = formatBinLabel(min + i * width, width);
  for (const v of values) counts[Math.min(BIN_COUNT - 1, Math.floor((v - min) / width))] += 1;
  return { labels, counts, colors: new Array<string>(BIN_COUNT).fill(IN_RANGE_COLOR) };
}

/**
 * Bin numeric measurements (base-unit, OL/null pre-filtered) into a frequency
 * histogram. Uses the LSD grid when `binWidth` is a valid resolution, else the
 * equal-width fallback. `centerValue` frames the empty (pre-recording) window.
 */
function buildHistogram(values: number[], binWidth: number | undefined, centerValue: number | undefined): Histogram {
  return typeof binWidth === 'number' && binWidth > 0 && Number.isFinite(binWidth)
    ? buildLsdHistogram(values, binWidth, centerValue)
    : buildEqualWidthHistogram(values);
}

const AXIS_COLOR = '#8b949e';
const GRID_COLOR = 'rgba(48,54,61,0.5)';
const MONO_FONT = { size: 11, family: 'var(--font-geist-mono)' };

const TOOLTIP_STYLE = {
  backgroundColor: '#1c2128',
  borderColor: '#30363d',
  borderWidth: 1,
  titleColor: '#f0f6fc',
  bodyColor: AXIS_COLOR,
  titleFont: { family: 'var(--font-geist-mono)', size: 11 },
  bodyFont: { family: 'var(--font-geist-mono)', size: 12 },
  padding: 8,
} as const;

/** Format an absolute timestamp (ms) as a label relative to the window's latest
 *  point: 'Now' for the newest, otherwise a signed second offset like '-12s'. */
function formatTimeOffset(ts: number, latestTs: number): string {
  const off = Math.round((ts - latestTs) / 1000);
  return off === 0 ? 'Now' : `${off}s`;
}

/** Build the (chart-type-dependent) Chart.js configuration. Histogram → bar of
 *  sample counts with a value x-axis; line → value-over-time area on a linear
 *  time axis (required by the decimation plugin — see the line branch). */
function buildChartConfig(isHistogram: boolean, unit: string): ChartConfiguration {
  if (isHistogram) {
    return {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'samples',
            data: [],
            backgroundColor: 'rgba(59,130,246,0.6)',
            borderColor: '#3b82f6',
            borderWidth: 1,
            categoryPercentage: 1,
            barPercentage: 1,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: {
            title: { display: true, text: unit, color: AXIS_COLOR, font: { size: 11 } },
            ticks: { color: AXIS_COLOR, maxTicksLimit: 9, maxRotation: 0, minRotation: 0, font: MONO_FONT },
            grid: { color: GRID_COLOR },
            border: { color: GRID_COLOR },
          },
          y: {
            title: { display: true, text: 'Samples', color: AXIS_COLOR, font: { size: 11 } },
            beginAtZero: true,
            ticks: { color: AXIS_COLOR, font: MONO_FONT },
            grid: { color: GRID_COLOR },
            border: { color: GRID_COLOR },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: TOOLTIP_STYLE,
        },
      },
    };
  }

  // Line: a LINEAR time x-axis (ms timestamps as {x,y}) with parsing disabled so
  // the built-in decimation plugin can downsample (it requires a linear/time axis
  // + parsing:false + sorted data — all satisfied here). This, plus the linear
  // axis pinning points to absolute positions, fixes the phantom *moving* spikes
  // that appeared past ~1300 samples on the old category axis. `min-max` keeps
  // both extremes of every pixel column, so a real transient is never visually
  // dropped (the right guarantee for a meter); the trade-off is that sparse ±1 LSD
  // noise still reads as a faint zig-zag band. Note the plugin only engages above
  // 4×(chart CSS width) points (Chart.js default threshold).
  // Per-point styling is scriptable (reads ctx.raw.oor) so it survives decimation.
  return {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'value',
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.07)',
          borderWidth: 2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pointRadius: (ctx: any) => (ctx.raw?.oor ? 4 : 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pointBackgroundColor: (ctx: any) => (ctx.raw?.oor ? '#ef4444' : '#3b82f6'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pointBorderColor: (ctx: any) => (ctx.raw?.oor ? '#ef4444' : '#3b82f6'),
          tension: 0,
          normalized: true,
          fill: true,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false, // {x,y} data — required by the decimation plugin
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: {
          type: 'linear',
          title: { display: false },
          ticks: {
            color: AXIS_COLOR,
            maxTicksLimit: 9,
            maxRotation: 0,
            minRotation: 0,
            font: MONO_FONT,
            // `this` is the scale; this.max is the newest plotted timestamp ('Now').
            callback(this: { max?: number }, value: string | number) {
              return typeof value === 'number' && this.max != null
                ? formatTimeOffset(value, this.max)
                : (value as string);
            },
          },
          grid: { color: GRID_COLOR },
          border: { color: GRID_COLOR },
        },
        y: {
          title: { display: true, text: unit, color: AXIS_COLOR, font: { size: 11 } },
          beginAtZero: false,
          ticks: { color: AXIS_COLOR, font: MONO_FONT },
          grid: { color: GRID_COLOR },
          border: { color: GRID_COLOR },
        },
      },
      plugins: {
        legend: { display: false },
        decimation: { enabled: true, algorithm: 'min-max' },
        tooltip: {
          ...TOOLTIP_STYLE,
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            title: (items: any[]) => {
              const x = items[0]?.parsed?.x;
              const max = items[0]?.chart?.scales?.x?.max;
              return typeof x === 'number' && max != null ? formatTimeOffset(x, max) : '';
            },
          },
        },
      },
    },
  };
}

export function RealtimeChart({
  data,
  unit,
  yMin,
  yMax,
  timeRange,
  onTimeRangeChange,
  binWidth,
  centerValue,
}: {
  data: ChartPoint[];
  unit: string;
  yMin?: number;
  yMax?: number;
  timeRange: TimeRange;
  onTimeRangeChange: (r: TimeRange) => void;
  binWidth?: number;
  centerValue?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const [chartType, setChartType] = useState<ChartType>('line');

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, buildChartConfig(chartType === 'histogram', unit));
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (chartType === 'histogram') {
      // Histogram bins the entire buffer (every captured sample), independent of
      // the time-range window. (OL readings are already excluded upstream.)
      const values = data.map((d) => d.v);
      const { labels, counts, colors } = buildHistogram(values, binWidth, centerValue);

      chart.data.labels = labels;
      chart.data.datasets[0].data = counts;
      // Per-bar color so under-/over-range outlier bins read as distinct (amber).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chart.data.datasets[0] as any).backgroundColor = colors;

      const yScale = chart.options.scales?.y as { min?: number; max?: number } | undefined;
      if (yScale) {
        // Counts only grow — always auto-scale the y-axis.
        yScale.min = undefined;
        yScale.max = undefined;
      }
      const xScale = chart.options.scales?.x as { title?: { text?: string } } | undefined;
      if (xScale?.title) xScale.title.text = unit;

      chart.update('none');
      return;
    }

    const now = Date.now();
    const windowMs = TIME_RANGE_MS[timeRange];
    // {x: timestamp, y: value, oor} for the linear axis + parsing:false; the
    // decimation plugin min-max downsamples this to the canvas width before draw.
    const points: { x: number; y: number; oor?: boolean }[] = [];
    for (const d of data) {
      if (now - d.ts <= windowMs) points.push({ x: d.ts, y: d.v, oor: d.oor });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chart.data.datasets[0].data = points as any;

    const yScale = chart.options.scales?.y as
      | { title?: { text?: string }; min?: number; max?: number }
      | undefined;
    if (yScale) {
      if (yScale.title) yScale.title.text = unit;
      yScale.min = yMin; // undefined => Chart.js auto-scales
      yScale.max = yMax;
    }
    chart.update('none');
  }, [data, unit, yMin, yMax, timeRange, chartType, binWidth, centerValue]);
  /* eslint-enable react-hooks/immutability */

  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">
          {chartType === 'histogram' ? 'Value Distribution' : 'Measurement Over Time'}
        </h2>
        <div className="flex items-center gap-2">
          {/* Chart-type selector */}
          <div className="flex overflow-hidden rounded-md border border-border">
            {CHART_TYPE_LABELS.map(({ type, label }) => (
              <button
                key={type}
                onClick={() => setChartType(type)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  chartType === type
                    ? 'bg-accent text-white'
                    : 'text-muted hover:bg-surface hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Time-range selector (line view only) */}
          {chartType === 'line' && (
            <div className="flex overflow-hidden rounded-md border border-border">
              {TIME_RANGE_LABELS.map((r) => (
                <button
                  key={r}
                  onClick={() => onTimeRangeChange(r)}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    timeRange === r
                      ? 'bg-accent text-white'
                      : 'text-muted hover:bg-surface hover:text-fg'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* All-mode performance note */}
      {chartType === 'line' && timeRange === 'all' && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-amber/40 px-3 py-2 text-xs text-amber">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>
            Showing all points — rendering a large session may impact performance.
          </span>
        </div>
      )}

      {/* Chart canvas */}
      <div className="relative h-80">
        <canvas ref={canvasRef} />
      </div>
    </section>
  );
}
