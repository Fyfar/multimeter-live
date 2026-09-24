'use client';

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  TIME_RANGES, TIME_RANGE_MS, resolveTimeWindow, timeAxisTicks,
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
  Tooltip,
  Legend,
  type ChartConfiguration,
  type Scale,
} from 'chart.js';
import { resolutionDecimals, STABLE_LSD_TOLERANCE } from '@/lib/parser';
import type { SampleStore } from '@/lib/samples';
import {
  DEFAULT_COLUMNS, RenderTier, quantizeAnchor, windowBucketMs, type TierPoint,
} from '@/lib/tier';

Chart.register(
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  BarController,
  BarElement,
  PointElement,
  Filler,
  Tooltip,
  Legend,
);

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

/**
 * One distinct measured value and how many readings landed on it. The histogram is fed
 * counts, not samples: the source is a map keyed on the LSD-snapped value, whose size is
 * bounded by how many distinct values the meter displayed rather than by how long the
 * session ran. That is what lets a multi-day distribution cost ~100 KB instead of
 * re-binning a growing array on every update.
 */
type Entry = readonly [value: number, count: number];

/**
 * LSD grid: bins are integer multiples of `width`, anchored at zero, so each bar is
 * centered on (and labeled with) an actual value the meter can display. The window
 * is centered on `centerValue` (the dominant/most-held value when recording, or the
 * live value when empty), shows at least MIN_BINS, and expands to include data
 * within MAX_HALF_BINS of the center. Values beyond the window collect into a single
 * under-range bin (left) and over-range bin (right) so a lone outlier doesn't
 * stretch the whole view.
 */
function buildLsdHistogram(entries: Entry[], width: number, centerValue: number | undefined): Histogram {
  // Fallback centre when the caller supplies none. `entries` comes from a Map, so
  // `entries[0]` is whichever value happened to be logged FIRST this session — session-order
  // noise, not a centre. The most-counted value is the same thing `centerValue` normally
  // carries, so falling back to it degrades gracefully instead of arbitrarily.
  let c = Number.isFinite(centerValue) ? (centerValue as number) : 0;
  if (!Number.isFinite(centerValue) && entries.length > 0) {
    let best = -1;
    for (const [v, n] of entries) if (n > best) { best = n; c = v; }
  }
  const centerBin = Math.round(c / width);
  const minHalf = Math.floor((MIN_BINS - 1) / 2);

  // Window: MIN_BINS around the center, expanded to include any data within
  // MAX_HALF_BINS of the center (so a genuine spread still shows in full).
  let lo = centerBin - minHalf;
  let hi = centerBin + minHalf;
  for (const [v] of entries) {
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
  // `+= n`, never `+= 1`: the input is counts per distinct value, so counting each
  // distinct value once would make every bar height wrong — most visibly on the steady
  // readings a distribution exists to show.
  for (const [v, n] of entries) {
    const b = Math.round(v / width);
    if (b < lo) under += n;
    else if (b > hi) over += n;
    else inRange[b - lo] += n;
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

/** Fallback when the device LSD is unknown: BIN_COUNT equal-width bins over min→max.
 *  Reachable whenever `binWidth` is undefined — not a dead path. */
function buildEqualWidthHistogram(entries: Entry[]): Histogram {
  if (entries.length === 0) return { labels: [], counts: [], colors: [] };
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const [v, n] of entries) {
    if (v < min) min = v;
    if (v > max) max = v;
    total += n;
  }
  if (min === max) return { labels: [formatBinLabel(min, 1)], counts: [total], colors: [IN_RANGE_COLOR] };
  const width = (max - min) / BIN_COUNT;
  const counts = new Array<number>(BIN_COUNT).fill(0);
  const labels = new Array<string>(BIN_COUNT);
  for (let i = 0; i < BIN_COUNT; i++) labels[i] = formatBinLabel(min + i * width, width);
  for (const [v, n] of entries) counts[Math.min(BIN_COUNT - 1, Math.floor((v - min) / width))] += n;
  return { labels, counts, colors: new Array<string>(BIN_COUNT).fill(IN_RANGE_COLOR) };
}

/**
 * Bin numeric measurements (base-unit, OL/null pre-filtered) into a frequency
 * histogram. Uses the LSD grid when `binWidth` is a valid resolution, else the
 * equal-width fallback. `centerValue` frames the empty (pre-recording) window.
 */
function buildHistogram(entries: Entry[], binWidth: number | undefined, centerValue: number | undefined): Histogram {
  return typeof binWidth === 'number' && binWidth > 0 && Number.isFinite(binWidth)
    ? buildLsdHistogram(entries, binWidth, centerValue)
    : buildEqualWidthHistogram(entries);
}

/**
 * Column width the 'all' view starts at, before it begins doubling. Deliberately far finer
 * than the meter's ~330 ms sample interval so a short session is drawn sample-for-sample
 * rather than as coarse steps; 50 ms x 1,000 columns covers the first ~50 s, and the tier
 * widens itself from there (seven days is about fourteen doublings, each O(columns)).
 */
const ALL_INITIAL_BUCKET_MS = 50;

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
 *  time axis, which pins points to absolute positions rather than to slot order.
 *
 *  `nowRef` carries the present into the tick and tooltip callbacks. It cannot be a
 *  parameter: the config is built once per chart type, while the labels must move with
 *  the clock. It is NOT `scale.max` — while a young session's window is still filling,
 *  `scale.max` is in the FUTURE, and labelling that edge 'Now' would be a lie. */
function buildChartConfig(
  isHistogram: boolean,
  unit: string,
  nowRef: { current: number },
  unitRef: { current: string },
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
  // *moving* spikes on the old category axis.
  //
  // Chart.js's `decimation` plugin is gone — no longer imported, registered or enabled. It
  // engaged when this was handed the raw buffer (~10,800 points at '1h'), but `RenderTier`
  // reduces to at most 2 x DEFAULT_COLUMNS points in every mode, far below the plugin's
  // 4x-canvas-width activation threshold, so it could never fire again. The same `min-max`
  // guarantee it provided is now the tier's, asserted in scripts/check-tier.mts rather than
  // trusted to a plugin.
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
          // its own {x, y}, so the two datasets can hold different numbers of points —
          // which they do, the markers being a filtered subset — without a marker ever
          // landing on the wrong sample. Index alignment is what was unsafe, not a second
          // dataset.
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
      parsing: false, // {x,y} data: read as given, no per-point key lookup
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
          // The unit goes on the TICKS, not in a scale title. Chart.js v4 has no rotation
          // option for a scale title, so a y-axis title is always drawn sideways — which
          // reads as a broken glyph for a symbol like the ohm sign, where `V` merely looks
          // conventional. Repeating it per tick costs axis width and reads correctly.
          title: { display: false },
          beginAtZero: false,
          ticks: {
            color: AXIS_COLOR,
            font: MONO_FONT,
            callback(this: { getLabelForValue: (v: number) => string }, value: string | number) {
              const label = this.getLabelForValue(Number(value));
              const u = unitRef.current;
              return u ? `${label} ${u}` : label;
            },
          },
          grid: { color: GRID_COLOR },
          border: { color: GRID_COLOR },
        },
      },
      plugins: {
        legend: { display: false },
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
  store,
  sampleVersion,
  chartFromSeq,
  chartEpoch,
  counts,
  stableOnly,
  unit,
  yMin,
  yMax,
  timeRange,
  onTimeRangeChange,
  binWidth,
  centerValue,
  sessionStart,
}: {
  /** THE canonical store. Read, never copied — this component keeps no per-sample state. */
  store: SampleStore;
  /** Bumped once per batch; the store is a ref, so this is what makes the effect re-run. */
  sampleVersion: number;
  /** Physical reading starts here: a preserve-log mode change leaves older rows in the
   *  store that the table keeps and the chart must not draw. */
  chartFromSeq: number;
  /** Bumped when the incremental tier is invalidated — watermark advance, or a retention
   *  trim dropping a chunk out from under its oldest columns. */
  chartEpoch: number;
  /** Readings per LSD-snapped value. Bounded by distinct values, not by sample count. */
  counts: Map<number, number>;
  /**
   * Whether "Log distinct parts only" is active. The line view is UNAVAILABLE while it is.
   *
   * The filter is a gate: a reading that is not a confirmed, materially-changed measurement
   * is never recorded anywhere. So the recorded series is a sequence of discrete
   * measurements, minutes apart, not a time series — a `10s` window routinely contains none
   * of them, and a line drawn between two of them would assert a value held across a gap
   * where the meter was measuring something else entirely (a probe lift, the next part).
   * Drawing nothing is honest but looks broken; drawing a line is dishonest. So the view
   * says why and points at the histogram, which plots the same recorded entries.
   *
   * Note this is about the SECOND gate as much as the first: on top of stability, a settled
   * value is only recorded if it differs from the last recorded one by 50% or more. One part
   * held on the probes therefore produces exactly one entry, ever.
   */
  stableOnly: boolean;
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
  // The unit, as the y-axis tick callback sees it. A ref for the same reason `nowRef` is
  // one: the config closes over it and the chart is only re-created on `chartType`. Seeded
  // from the initializer so the very first draw has it, then written by the update effect —
  // never during render, which lint enforces.
  const unitRef = useRef(unit);
  const [chartType, setChartType] = useState<ChartType>('line');
  // No canvas is mounted while this is true, so the create effect must re-run when it
  // clears — hence its presence in that effect's dependency list.
  const lineUnavailable = stableOnly && chartType === 'line';
  // What the line view draws: min and max per column, ~2,000 points however long the
  // session is. A ref because it is mutated in place across updates.
  const tierRef = useRef<RenderTier>(new RenderTier(DEFAULT_COLUMNS));
  // Incremental-feed bookkeeping for 'all'. `fedTo` is the physical index already folded
  // in; -1 means the tier holds something else (a bounded window) and must be rebuilt.
  const fedToRef = useRef(-1);
  const fedFromRef = useRef(-1);
  const epochRef = useRef(-1);

  useEffect(() => {
    if (lineUnavailable || !canvasRef.current) return;
    nowRef.current = Date.now();
    const chart = new Chart(canvasRef.current, buildChartConfig(chartType === 'histogram', unit, nowRef, unitRef));
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, lineUnavailable]);

  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || lineUnavailable) return;

    unitRef.current = unit;
    if (chartType === 'histogram') {
      // Counts per distinct value, accumulated as entries are recorded — NOT a re-bin of
      // the stored samples, which is what keeps a multi-day distribution affordable. Fed by
      // the same `logSample` gate as everything else, so the bars always total the session's
      // sample count. They have no time dimension, though, so the distribution covers the
      // whole recording session even after retention has dropped the oldest samples from the
      // table and the CSV. (OL and no-part readings are excluded upstream, as everywhere.)
      const entries: Entry[] = [...counts];
      const { labels, counts: binCounts, colors } = buildHistogram(entries, binWidth, centerValue);

      chart.data.labels = labels;
      chart.data.datasets[0].data = binCounts;
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
    unitRef.current = unit; // what the y-axis tick callback appends
    const windowMs = TIME_RANGE_MS[timeRange];
    const tier = tierRef.current;
    // Physical index the chart may start at. A preserve-log mode change advances the
    // watermark instead of clearing the store, so older rows survive in the table and the
    // CSV while the trace restarts in the new unit.
    const from = Math.max(0, Math.min(store.count, chartFromSeq - store.firstSeq));

    if (Number.isFinite(windowMs)) {
      // Bounded window: rebuild every update. The window SLIDES, so columns expire from the
      // left and cannot be maintained incrementally — and it is bounded by definition, so
      // the rebuild is cheap (1h is ~11,000 samples at this meter's rate, well under a
      // millisecond). `tsAt`/`valueAt` are scalar reads, so the scan allocates nothing.
      // Both defined in lib/tier.ts, where the self-check can assert them: the width leaves
      // two columns of headroom, and the anchor is snapped to an absolute bucket boundary so
      // a sliding window shifts the tier by whole columns instead of re-dealing every sample
      // into a different bucket each frame.
      const bucketMs = windowBucketMs(windowMs);
      const t0 = quantizeAnchor(now - windowMs, bucketMs);
      // Start ONE sample before the window so the trace enters from the left edge instead
      // of starting wherever the first in-window sample happens to fall. At 10s that gap is
      // up to 3% of the width; with "Stable values only" on it can be the whole window,
      // leaving an empty chart while the meter is plainly reading. `add` folds a pre-t0
      // sample into column 0 and keeps its own timestamp, so Chart.js clips the segment at
      // the edge correctly.
      const start = Math.max(from, store.indexAtOrAfter(t0) - 1);
      tier.reset(t0, bucketMs);
      for (let i = start; i < store.count; i++) tier.add(store.tsAt(i), store.valueAt(i));
      fedToRef.current = -1; // the tier now holds a window, not the session
    } else {
      // 'all': maintained incrementally, so per-update work does not grow with the session.
      // Rebuilt only when the tier's contents are invalidated — a watermark advance, a
      // retention trim that shifted indices, or arriving here from a bounded window.
      const stale =
        fedToRef.current < 0 ||
        epochRef.current !== chartEpoch ||
        fedFromRef.current !== from ||
        fedToRef.current > store.count;
      if (stale) {
        tier.reset(store.count > from ? store.tsAt(from) : now, ALL_INITIAL_BUCKET_MS);
        for (let i = from; i < store.count; i++) tier.add(store.tsAt(i), store.valueAt(i));
        fedFromRef.current = from;
        epochRef.current = chartEpoch;
      } else {
        for (let i = fedToRef.current; i < store.count; i++) tier.add(store.tsAt(i), store.valueAt(i));
      }
      fedToRef.current = store.count;
    }

    // The drawn series and the out-of-range markers, both from the reduction. The
    // operator's y-range is applied HERE, not at capture, so changing it re-clamps the
    // whole session rather than only what arrives afterwards.
    const points = tier.points(yMin, yMax);
    const oorPoints = points.filter((p: TierPoint) => p.oor);
    const extent = tier.extent();
    const lo = extent ? extent.min : Infinity;
    const hi = extent ? extent.max : -Infinity;

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
      const win = resolveTimeWindow(timeRange, sessionStart ?? null, now);
      const { stepSize } = win;
      let min = win.min;
      let max = win.max;
      if (!Number.isFinite(windowMs)) {
        // 'all' has no fixed window, so the axis fits the data — but "the data" must mean
        // the STORE's bounds, not the tier's last emitted point. A bucket emits its min and
        // max, and which of those is newest hops around inside the newest bucket as samples
        // arrive, so letting Chart.js auto-fit made the axis maximum jump every update: the
        // whole plot area re-laid-out and the right-hand label flickered between `Now` and
        // `-1s`. Real sample timestamps only ever move forward.
        min = store.count > from ? store.tsAt(from) : undefined;
        max = store.count > 0 ? store.tsAt(store.count - 1) : undefined;
      }
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
      // Line view: the unit is rendered by the tick callback, which reads `unitRef`.
      // Histogram: it is the x-axis title, set in that branch above.
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
    // `counts` is listed for the linter and for documentation only: its identity is stable
    // (it is cleared in place, never replaced), so it can never re-run this effect by
    // itself. `sampleVersion` is what actually does — including for the counts-only case,
    // where the stable filter suppresses logging but the histogram still changes.
  }, [store, sampleVersion, chartFromSeq, chartEpoch, counts, unit, yMin, yMax, timeRange,
      chartType, binWidth, centerValue, sessionStart, lineUnavailable]);
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
            {CHART_TYPE_LABELS.map(({ type, label }) => {
              const unavailable = stableOnly && type === 'line';
              return (
                <button
                  key={type}
                  onClick={() => setChartType(type)}
                  disabled={unavailable}
                  title={unavailable ? 'Not available while "Log distinct parts only" is on' : undefined}
                  className={clsx(
                    'px-3 py-1 text-xs font-medium transition-colors',
                    chartType === type
                      ? 'bg-accent text-white'
                      : 'text-muted hover:bg-surface hover:text-fg',
                    unavailable && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Time-range selector (line view only, and only when it is actually drawn) */}
          {chartType === 'line' && !lineUnavailable && (
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

      {/* Chart canvas — or, while the line view is unavailable, why it is. */}
      <div className="relative h-80">
        {lineUnavailable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-8 text-center">
            <p className="text-sm font-semibold text-fg">
              Line view is not available with “Log distinct parts only”
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted">
              That filter records one entry per settled measurement, so entries can be minutes
              apart. A line drawn between two of them would claim the value was held in
              between, when the meter was measuring something else — a probe lift, or the next
              The histogram plots the recorded entries, so a batch of parts reads as a
              distribution of their measured values.
            </p>
            <button
              onClick={() => setChartType('histogram')}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:brightness-125"
            >
              Show histogram
            </button>
          </div>
        ) : (
          <canvas ref={canvasRef} />
        )}
      </div>
    </section>
  );
}
