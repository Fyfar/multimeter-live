'use client';

import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  TIME_RANGES, TIME_RANGE_MS, firstIndexInWindow, resolveTimeWindow, timeAxisTicks,
  type TimeRange,
} from '@/lib/settings';
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
  type Scale,
} from 'chart.js';
import { resolutionDecimals, STABLE_LSD_TOLERANCE } from '@/lib/parser';

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

/** A buffered sample, stored in the shape Chart.js consumes so nothing has to translate
 *  it on the way to the canvas. Named for the axes, not the domain, deliberately: this is
 *  a chart-facing projection of a `Reading` — the canonical record is `recordedRows`. */
export interface ChartPoint {
  x: number;     // Date.now() when the reading was parsed
  y: number;     // normalized value (OL readings are skipped, never charted)
  oor?: boolean; // out-of-range: outside user-defined min/max, clamped to the bound
}

// The valid list lives in lib/settings.ts (it is persisted and validated there, and that
// module must stay importable by the Node check script). Re-exported here so every existing
// `import { type TimeRange } from '@/components/RealtimeChart'` keeps working.
export type { TimeRange };

const TIME_RANGE_LABELS: readonly TimeRange[] = TIME_RANGES;

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

/** Format an absolute timestamp (ms) as a signed second offset from the present: 'Now' at
 *  the present, '-12s' before it, '+12s' after.
 *
 *  The '+' is not decoration. While a young session's window is still filling, the axis
 *  extends past the present, so the right-hand ticks are in the FUTURE — a bare '6s' there
 *  is typographically identical to a past offset and reads as if data existed. */
function formatTimeOffset(ts: number, nowTs: number): string {
  const off = Math.round((ts - nowTs) / 1000);
  if (off === 0) return 'Now';
  return off > 0 ? `+${off}s` : `${off}s`;
}

/** Build the (chart-type-dependent) Chart.js configuration. Histogram → bar of
 *  sample counts with a value x-axis; line → value-over-time area on a linear
 *  time axis (required by the decimation plugin — see the line branch).
 *
 *  `nowRef` carries the present into the tick and tooltip callbacks. It cannot be a
 *  parameter: the config is built once per chart type, while the labels must move with
 *  the clock. It is NOT `scale.max` — while a young session's window is still filling,
 *  `scale.max` is in the FUTURE, and labelling that edge 'Now' would be a lie. */
function buildChartConfig(
  isHistogram: boolean,
  unit: string,
  nowRef: { current: number },
): ChartConfiguration {
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

  // Line: a LINEAR time x-axis (ms timestamps as {x,y}) with parsing disabled. The
  // linear axis pins points to absolute positions, which is what fixed the phantom
  // *moving* spikes on the old category axis. It also satisfies the decimation
  // plugin's preconditions (linear/time axis + parsing:false + sorted data). It needs
  // 4×(chart CSS width) points, ~4000 at this layout, so it engages in 'all' and now
  // also in '1h' — the buffer keeps a full hour, which is ~10,800 points at this meter's
  // 3/s. `min-max` is the right algorithm for both: it keeps both extremes of every pixel
  // column, so a real transient is never dropped. Out-of-range markers are a separate
  // dataset with their own {x, y}, so they survive decimation too.
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
          // Static, deliberately. These were scriptable (reading ctx.raw.oor per point) and
          // that cost ~2 KB of allocation PER POINT PER FRAME — 64% of everything the page
          // allocated — because Chart.js builds a resolver context and a proxy for every
          // element on every draw whenever any option is a function. The out-of-range
          // markers now live in their own dataset below, so neither dataset needs one.
          pointRadius: 0,
          pointBackgroundColor: '#3b82f6',
          pointBorderColor: '#3b82f6',
          tension: 0,
          // The meter is quantized: it only ever reports integer multiples of one LSD,
          // so the chart must never draw a vertex off that grid. Two independent guards,
          // because either alone is one styling edit away from reopening the bug:
          //
          // 1. borderJoinStyle 'round' — Chart.js defaults joins to 'miter' and never
          //    sets ctx.miterLimit, so Canvas2D's default limit of 10 applies and a tip
          //    may run up to 10×borderWidth past the vertex. That overshoot grows as
          //    segments approach vertical, and the x-axis auto-fits its range, so piling
          //    up samples steepens every segment: measured 6–7px past a 17px LSD at ~800
          //    samples (0.4 LSD of pure fiction) versus 1px at ~200. A round join is an
          //    arc of radius borderWidth/2 centred on the vertex — bounded at any angle.
          // 2. stepped 'middle' — there are no values between LSD levels, so a sloped
          //    segment asserts readings the meter cannot produce. Stepping is both the
          //    honest depiction and a geometry with no segment steep enough to overshoot.
          //    'middle' puts the edge between the two samples so it is not attributed to
          //    either timestamp. (tension is ignored under stepped; it is already 0.)
          //
          // borderWidth is the one remaining knob — residual extent is half of it, 1px
          // today, within antialiasing. Deliberately left at 2. See docs/gotchas.md.
          borderJoinStyle: 'round',
          stepped: 'middle',
          normalized: true,
          fill: true,
        },
        {
          // Out-of-range markers: the readings clamped to the operator's range bound, which
          // is how a dropped measurement shows up while the part stays connected. Its own
          // dataset so that BOTH datasets can be styled with constants.
          //
          // This is not the parallel-array mistake gotchas.md rejected: each marker carries
          // its own {x, y}, so decimation may drop or reorder points in either dataset
          // without a marker ever landing on the wrong sample. Index alignment is what was
          // unsafe, not a second dataset.
          label: 'out of range',
          // Chart.js draws datasets in REVERSE of (order, index), so with both at the
          // default order 0 this dataset paints first and the line paints over it. The
          // markers were dataset-0 points before this split and sat on top; worse, the
          // out-of-range value is CLAMPED to the range bound, so every marker lies exactly
          // on the line's path and the 2px stroke bisects it instead of missing it.
          // order -1 sorts this dataset first, so it is drawn last.
          order: -1,
          data: [],
          showLine: false,
          pointRadius: 4,
          pointBackgroundColor: '#ef4444',
          pointBorderColor: '#ef4444',
          normalized: true,
          fill: false,
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
          // Only consulted in 'all', the one range with no min/max pinned (see the update
          // effect). 'ticks' — the default — would round the fitted range out to the next
          // tick boundary at BOTH ends, padding the plot with an empty band each side.
          bounds: 'data',
          title: { display: false },
          // Ticks are placed relative to the PRESENT, replacing the ones Chart.js generates
          // from the axis minimum. Those are evenly spaced either way, but only aligned
          // with the present when min === now - window, i.e. once the window has filled.
          // While it is still filling, min is the session start and the '1h' view showed
          // '-1484s, -884s, -284s, 316s…' with no 'Now' anywhere. No stepSize means 'all',
          // which has no fixed window to align to — leave Chart.js's choice alone.
          afterBuildTicks(axis: Scale) {
            // `Scale` is typed with CoreScaleOptions, which knows nothing of ticks.stepSize
            // — the update effect writes it there per range.
            const step = (axis.options as { ticks?: { stepSize?: number } }).ticks?.stepSize;
            if (!step) return;
            axis.ticks = timeAxisTicks(axis.min, axis.max, step, nowRef.current)
              .map((value) => ({ value }));
          },
          ticks: {
            color: AXIS_COLOR,
            maxTicksLimit: 9,
            maxRotation: 0,
            minRotation: 0,
            font: MONO_FONT,
            callback(value: string | number) {
              return typeof value === 'number'
                ? formatTimeOffset(value, nowRef.current)
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
          // Dataset 1 (the out-of-range markers) is for drawing, not for reading. Without
          // this, `interaction.mode: 'index'` takes the element at the SAME INDEX in every
          // dataset — and dataset 1 is a short, separately-indexed array, so hovering any
          // point would add a second row showing an unrelated marker's value. Dataset 0
          // already holds every sample, out-of-range ones included (clamped to the bound).
          filter: (item: { datasetIndex: number }) => item.datasetIndex === 0,
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            title: (items: any[]) => {
              const x = items[0]?.parsed?.x;
              return typeof x === 'number' ? formatTimeOffset(x, nowRef.current) : '';
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
  sessionStart,
}: {
  data: ChartPoint[];
  unit: string;
  yMin?: number;
  yMax?: number;
  timeRange: TimeRange;
  onTimeRangeChange: (r: TimeRange) => void;
  binWidth?: number;
  centerValue?: number;
  /** When this session's first point arrived; null between sessions. Anchors the
   *  x-axis while the session is younger than the selected window. */
  sessionStart?: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  // The present, as the axis labels see it. Written by the update effect before every
  // draw and read by the tick/tooltip callbacks, which the config closes over. Seeded in
  // the create effect, not here: `Date.now()` during render is impure (lint enforces it),
  // and the chart's very first draw happens before the update effect has run.
  const nowRef = useRef(0);
  const [chartType, setChartType] = useState<ChartType>('line');

  useEffect(() => {
    if (!canvasRef.current) return;
    nowRef.current = Date.now();
    const chart = new Chart(canvasRef.current, buildChartConfig(chartType === 'histogram', unit, nowRef));
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
      // Histogram bins the whole RETAINED buffer, independent of the time-range window —
      // but not independent of the range that was last selected: outside 'all' the buffer
      // is trimmed to BUFFER_RETENTION_MS (app/page.tsx), and the range selector is hidden
      // in this view, so nothing on screen says what is bounding the distribution. The
      // statistics panel is never trimmed and so can report a longer span than this.
      // (OL readings are already excluded upstream.)
      const values = data.map((d) => d.y);
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
    nowRef.current = now; // what the tick and tooltip labels are offsets from
    const windowMs = TIME_RANGE_MS[timeRange];
    // {x: timestamp, y: value, oor} for the linear axis + parsing:false; the
    // decimation plugin min-max downsamples this to the canvas width before draw.
    // The visible window is a tail slice of the buffer (appended in timestamp order), and
    // the buffer is already in Chart.js's shape — so this is one slice, not a per-sample
    // rebuild. 'all' has no window: the dataset IS the buffer, no search and no copy.
    const from = Number.isFinite(windowMs) ? firstIndexInWindow(data, now - windowMs) : 0;
    const points = from === 0 ? data : data.slice(from);

    // One pass for the two things that must look at every visible point: the window extent
    // (for the y-axis floor) and the out-of-range subset (dataset 1). Allocates one short
    // array and nothing per point — the markers are references into `points`, not copies.
    const oorPoints: ChartPoint[] = [];
    // Window extent, tracked in the pass that is already running (see the y-axis floor).
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
      if (p.oor) oorPoints.push(p);
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    chart.data.datasets[0].data = points as any;
    chart.data.datasets[1].data = oorPoints as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // X range. A bounded range spans exactly its window, so pixels-per-second is a
    // constant: the axis is anchored at the session start while the window fills (the
    // trace grows rightward and nothing already drawn moves), then rolls with the clock.
    // 'all' sets nothing and the axis fits the data instead — see resolveTimeWindow.
    const xScale = chart.options.scales?.x as
      | { min?: number; max?: number; ticks?: { stepSize?: number } }
      | undefined;
    if (xScale) {
      const { min, max, stepSize } = resolveTimeWindow(timeRange, sessionStart ?? null, now);
      // Assigned unconditionally, `undefined` included: Chart.js reuses this options
      // object across updates, so a bounded range's min/max left behind would pin 'all'
      // to a dead window — the same trap the y-axis floor below guards against.
      xScale.min = min;
      xScale.max = max;
      if (xScale.ticks) xScale.ticks.stepSize = stepSize;
    }

    const yScale = chart.options.scales?.y as
      | {
          title?: { text?: string };
          min?: number;
          max?: number;
          suggestedMin?: number;
          suggestedMax?: number;
        }
      | undefined;
    if (yScale) {
      if (yScale.title) yScale.title.text = unit;
      yScale.min = yMin; // undefined => Chart.js auto-scales
      yScale.max = yMax;

      // Auto-scale fits [dataMin, dataMax] — which on a settled reading IS the meter's
      // own ±1-count dither, so one count of noise gets magnified to the full canvas
      // height and a steady measurement is displayed as violent movement. Floor the
      // span at ±STABLE_LSD_TOLERANCE counts around the window's midpoint: reusing the
      // stability gate's constant keeps ONE number in the codebase for "a change
      // smaller than this is not a measurement" (docs/gotchas.md explains why it is 20
      // and why 2 was too tight), so the chart stops resolving below the noise floor
      // the app has already declared.
      //
      // suggestedMin/Max are soft — Chart.js takes min(dataMin, suggestedMin) — so real
      // spread still widens the axis and a transient is never clipped. A hard min/max
      // here would be wrong for a meter.
      const floored =
        yMin === undefined &&
        yMax === undefined &&
        typeof binWidth === 'number' &&
        binWidth > 0 &&
        Number.isFinite(binWidth) &&
        lo <= hi;
      // Cleared when not applicable: Chart.js reuses this options object across
      // updates, so a stale suggestion would outlive the condition that set it.
      if (floored) {
        const half = STABLE_LSD_TOLERANCE * binWidth;
        const mid = (lo + hi) / 2;
        yScale.suggestedMin = mid - half;
        yScale.suggestedMax = mid + half;
      } else {
        yScale.suggestedMin = undefined;
        yScale.suggestedMax = undefined;
      }
    }
    chart.update('none');
  }, [data, unit, yMin, yMax, timeRange, chartType, binWidth, centerValue, sessionStart]);
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
