// What the chart actually draws: a fixed number of columns, each holding the minimum and the
// maximum measured at that horizontal position, with the timestamp each of those extremes
// actually occurred at. No React, no DOM — `scripts/check-tier.mts` loads this under Node,
// because a bug here produces a WRONG PICTURE over CORRECT DATA, which is the hardest kind
// to notice and impossible to catch by looking at the screen.
//
// Min AND max per column, never an average or a representative neighbour: a multimeter must
// never smooth away a transient. That is the guarantee `min-max` decimation gives and the
// reason `lttb` was rejected. Keeping the real timestamps is what keeps a 3 ms spike at the
// x it happened when a column is five minutes wide.
//
// Cost is O(1) in session length: `add` touches one column, and widening the columns merges
// adjacent pairs in a single O(columns) pass, amortised to nothing.

/** One drawn point. `oor` marks a value the operator's y-range clamped. */
export interface TierPoint {
  x: number;
  y: number;
  oor: boolean;
}

/** Columns the chart reduces to — about one per horizontal pixel of plot area. */
export const DEFAULT_COLUMNS = 1000;

/**
 * Column width for a bounded window of `windowMs`.
 *
 * `columns - 2`, not `columns`: `quantizeAnchor` rounds the window start DOWN to a bucket
 * boundary, which buys up to one extra bucket of span, and a sample arriving at the present
 * would then land one column past the end and trigger a doubling — halving the resolution
 * for exactly one frame and restoring it on the next. Two columns of headroom makes that
 * unrepresentable rather than merely unlikely.
 *
 * Lives here, not in the chart, so `scripts/check-tier.mts` asserts the real formula instead
 * of a copy of it.
 */
export const windowBucketMs = (windowMs: number, columns: number = DEFAULT_COLUMNS): number =>
  windowMs / (columns - 2);

/**
 * Snap a window start down to a bucket boundary, so bucket edges are fixed in ABSOLUTE time.
 *
 * Anchoring a sliding window at `now - windowMs` moves its boundaries a little on every
 * update, so samples are re-dealt into different buckets and the drawn min/max pair changes
 * — a line that jitters by a pixel over completely stable data. Quantized, a sample's bucket
 * is a property of its timestamp alone and the window sliding shifts the tier by whole
 * columns.
 */
export const quantizeAnchor = (t: number, bucketMs: number): number =>
  Math.floor(t / bucketMs) * bucketMs;

const clamp = (v: number, lo: number | undefined, hi: number | undefined): number => {
  if (hi !== undefined && v > hi) return hi;
  if (lo !== undefined && v < lo) return lo;
  return v;
};

export class RenderTier {
  readonly columns: number;
  #minV: Float64Array;
  #maxV: Float64Array;
  #minTs: Float64Array;
  #maxTs: Float64Array;
  #count: Uint32Array;

  #t0 = 0;
  #bucketMs = 0;
  /** Highest occupied column, so `points` and `#double` never scan empty tail columns. */
  #high = -1;

  constructor(columns: number = DEFAULT_COLUMNS) {
    this.columns = columns;
    this.#minV = new Float64Array(columns);
    this.#maxV = new Float64Array(columns);
    this.#minTs = new Float64Array(columns);
    this.#maxTs = new Float64Array(columns);
    this.#count = new Uint32Array(columns);
  }

  /** Current column width. Grows by doubling; exposed so a caller can rebuild at this width. */
  get bucketMs(): number {
    return this.#bucketMs;
  }

  /** Start of column 0. */
  get t0(): number {
    return this.#t0;
  }

  /** Empty the tier and anchor it at `t0` with columns `bucketMs` wide. */
  reset(t0: number, bucketMs: number): void {
    this.#t0 = t0;
    this.#bucketMs = bucketMs > 0 ? bucketMs : 1;
    this.#high = -1;
    this.#count.fill(0);
  }

  /** Whether anything has been added since the last `reset`. */
  get isEmpty(): boolean {
    return this.#high < 0;
  }

  /**
   * Fold one sample in. Widens the columns — doubling, merging adjacent pairs — as many times
   * as it takes for `ts` to land inside the tier, so an unbounded session never outgrows it.
   *
   * Samples arrive in timestamp order, so a sample before `t0` is not reachable from the
   * capture path; one is folded into column 0 rather than dropped, because silently losing a
   * sample is worse than drawing it a fraction of a column early.
   */
  add(ts: number, value: number): void {
    // Not a measurement, so it does not belong in the picture. Dropped rather than stored:
    // a NaN reaching a column poisons it permanently (every later `value < NaN` is false, so
    // no real extreme can ever replace it), and a non-finite `ts` drives the widening loop
    // through ~1000 doublings, coarsening every real column on the way, before discarding
    // the sample anyway. `lib/parser.ts` already filters both, but this is public API.
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return;
    if (this.#bucketMs <= 0) this.reset(ts, 1);

    let i = Math.floor((ts - this.#t0) / this.#bucketMs);
    while (i >= this.columns) {
      this.#double();
      i = Math.floor((ts - this.#t0) / this.#bucketMs);
    }
    if (i < 0) i = 0;

    if (this.#count[i] === 0) {
      this.#minV[i] = value;
      this.#maxV[i] = value;
      this.#minTs[i] = ts;
      this.#maxTs[i] = ts;
    } else {
      if (value < this.#minV[i]) {
        this.#minV[i] = value;
        this.#minTs[i] = ts;
      }
      if (value > this.#maxV[i]) {
        this.#maxV[i] = value;
        this.#maxTs[i] = ts;
      }
    }
    this.#count[i] += 1;
    if (i > this.#high) this.#high = i;
  }

  /**
   * Double the column width, merging columns `2j` and `2j+1` into `j`. One pass, in place.
   *
   * `t0` does not move, so merged column `j` spans exactly what the pair spanned — the
   * reason this is a pure widening and not a re-bucketing, and why no sample can change
   * column membership except by merging with its neighbour.
   */
  #double(): void {
    // Round UP: with an odd column count the last column has no partner, and `columns >> 1`
    // would leave it out of the loop and then zero it — discarding whatever extreme it held,
    // silently. It merges with an empty partner instead.
    const half = (this.columns + 1) >> 1;
    for (let j = 0; j < half; j++) {
      const a = 2 * j;
      const b = a + 1;
      const ca = this.#count[a];
      const cb = b < this.columns ? this.#count[b] : 0;

      if (ca === 0 && cb === 0) {
        this.#count[j] = 0;
        continue;
      }
      if (cb === 0) {
        this.#minV[j] = this.#minV[a]; this.#minTs[j] = this.#minTs[a];
        this.#maxV[j] = this.#maxV[a]; this.#maxTs[j] = this.#maxTs[a];
        this.#count[j] = ca;
        continue;
      }
      if (ca === 0) {
        this.#minV[j] = this.#minV[b]; this.#minTs[j] = this.#minTs[b];
        this.#maxV[j] = this.#maxV[b]; this.#maxTs[j] = this.#maxTs[b];
        this.#count[j] = cb;
        continue;
      }
      // Both occupied: the surviving extreme keeps ITS OWN timestamp, not the column's.
      if (this.#minV[b] < this.#minV[a]) {
        this.#minV[j] = this.#minV[b]; this.#minTs[j] = this.#minTs[b];
      } else {
        this.#minV[j] = this.#minV[a]; this.#minTs[j] = this.#minTs[a];
      }
      if (this.#maxV[b] > this.#maxV[a]) {
        this.#maxV[j] = this.#maxV[b]; this.#maxTs[j] = this.#maxTs[b];
      } else {
        this.#maxV[j] = this.#maxV[a]; this.#maxTs[j] = this.#maxTs[a];
      }
      this.#count[j] = ca + cb;
    }
    this.#count.fill(0, half);
    this.#high = this.#high < 0 ? -1 : this.#high >> 1;
    this.#bucketMs *= 2;
  }

  /**
   * The drawable series: every occupied column's min and max, in timestamp order.
   *
   * The operator's y-range is applied HERE rather than at capture, so changing it re-clamps
   * the whole session instead of only what arrives afterwards. Clamping a column's min and
   * max is identical to clamping every sample in it and re-taking the extremes, because
   * clamping is monotonic — that is what makes reducing first and clamping second correct.
   *
   * A column whose min and max are the SAME VALUE yields one point — there is nothing to
   * distinguish. Deduping on the *timestamp* instead would be a silent data loss: the parser
   * stamps every reading with `Date.now()`, so a batch of readings parsed in one millisecond
   * shares a timestamp, and a spike arriving in the same millisecond as a normal reading
   * would be dropped. Two points at one x draw the vertical stroke that a transient should
   * look like. (min === max implies both timestamps are equal, since neither is updated by a
   * value that does not beat it — so this case subsumes the single-sample one.)
   *
   * `-0 === 0` is true, so a column holding both collapses to one point. That is correct and
   * not an instance of the bug above: the meter displaying `-0.000` and `0.000` reported the
   * same measurement, and there is no divergence to draw.
   */
  points(clampMin?: number, clampMax?: number): TierPoint[] {
    const out: TierPoint[] = [];
    for (let i = 0; i <= this.#high; i++) {
      if (this.#count[i] === 0) continue;
      const lo = this.#minV[i];
      const hi = this.#maxV[i];
      const loTs = this.#minTs[i];
      const hiTs = this.#maxTs[i];

      const loY = clamp(lo, clampMin, clampMax);
      const hiY = clamp(hi, clampMin, clampMax);

      if (lo === hi) {
        out.push({ x: loTs, y: loY, oor: loY !== lo });
        continue;
      }
      if (loTs <= hiTs) {
        out.push({ x: loTs, y: loY, oor: loY !== lo });
        out.push({ x: hiTs, y: hiY, oor: hiY !== hi });
      } else {
        out.push({ x: hiTs, y: hiY, oor: hiY !== hi });
        out.push({ x: loTs, y: loY, oor: loY !== lo });
      }
    }
    return out;
  }

  /**
   * The extent of every occupied column, unclamped. The y-axis floor needs this and would
   * otherwise rescan the visible samples — the single largest per-update cost this replaces.
   * Returns `null` when the tier is empty.
   */
  extent(): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= this.#high; i++) {
      if (this.#count[i] === 0) continue;
      if (this.#minV[i] < min) min = this.#minV[i];
      if (this.#maxV[i] > max) max = this.#maxV[i];
    }
    return min === Infinity ? null : { min, max };
  }
}
