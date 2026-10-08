// Histogram binning: what distribution the operator sees. Pure numbers, no React and no
// formatting — `scripts/check-histogram.mts` loads this under Node, because a wrong bin draws
// a plausible-looking distribution over correct data. Labels (SI prefix, decimals) are the
// chart's job; that is why bins carry a numeric `value` and not a string.

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

/**
 * One distinct measured value and how many readings landed on it. The histogram is fed
 * counts, not samples: the source is a map keyed on the LSD-snapped value, whose size is
 * bounded by how many distinct values the meter displayed rather than by how long the
 * session ran. That is what lets a multi-day distribution cost ~100 KB instead of
 * re-binning a growing array on every update.
 */
export type Entry = readonly [value: number, count: number];

/** `value` is what the bin is labeled with: the LSD bin centre, the edge bins' window bound
 *  (read as `< value` / `> value`), or an equal-width bin's left edge. */
type Bin = { value: number; count: number; kind: 'under' | 'in' | 'over' };

/** `width` is the effective bin width, which the label decimals derive from. */
type Histogram = { bins: Bin[]; width: number };

/**
 * LSD grid: bins are integer multiples of `width`, anchored at zero, so each bar is
 * centered on (and labeled with) an actual value the meter can display. The window
 * is centered on `centerValue` (the dominant/most-held value when recording, or the
 * live value when empty), shows at least MIN_BINS, and expands to include data
 * within MAX_HALF_BINS of the center. Values beyond the window collect into a single
 * under-range bin (left) and over-range bin (right) so a lone outlier doesn't
 * stretch the whole view.
 */
function buildLsdHistogram(entries: readonly Entry[], width: number, centerValue: number | undefined): Histogram {
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

  const bins: Bin[] = [];
  if (under > 0) bins.push({ value: lo * width, count: under, kind: 'under' });
  for (let i = 0; i < inCount; i++) bins.push({ value: (lo + i) * width, count: inRange[i], kind: 'in' });
  if (over > 0) bins.push({ value: hi * width, count: over, kind: 'over' });
  return { bins, width };
}

/** Fallback when the device LSD is unknown: BIN_COUNT equal-width bins over min→max.
 *  Reachable whenever `binWidth` is undefined — not a dead path. */
function buildEqualWidthHistogram(entries: readonly Entry[]): Histogram {
  if (entries.length === 0) return { bins: [], width: 1 };
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const [v, n] of entries) {
    if (v < min) min = v;
    if (v > max) max = v;
    total += n;
  }
  if (min === max) return { bins: [{ value: min, count: total, kind: 'in' }], width: 1 };
  const width = (max - min) / BIN_COUNT;
  const counts = new Array<number>(BIN_COUNT).fill(0);
  for (const [v, n] of entries) counts[Math.min(BIN_COUNT - 1, Math.floor((v - min) / width))] += n;
  return { bins: counts.map((count, i) => ({ value: min + i * width, count, kind: 'in' })), width };
}

/**
 * Bin numeric measurements (base-unit, OL/null pre-filtered) into a frequency
 * histogram. Uses the LSD grid when `binWidth` is a valid resolution, else the
 * equal-width fallback. `centerValue` frames the empty (pre-recording) window.
 */
export function buildHistogram(
  entries: readonly Entry[],
  binWidth: number | undefined,
  centerValue: number | undefined,
): Histogram {
  return typeof binWidth === 'number' && binWidth > 0 && Number.isFinite(binWidth)
    ? buildLsdHistogram(entries, binWidth, centerValue)
    : buildEqualWidthHistogram(entries);
}
