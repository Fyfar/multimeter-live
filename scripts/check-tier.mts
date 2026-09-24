// Self-check for lib/tier.ts. Run by `npm run check` (see docs/quality.md).
//
// A bug in the tier draws a WRONG PICTURE over CORRECT DATA. Nothing errors, the Data Log and
// the CSV stay right, and the only symptom is a trace that is subtly not what the meter
// measured — a transient smoothed away, a spike drawn minutes from where it happened. That is
// why the reduction lives in `lib/` behind assertions instead of inside the chart component.
//
// Two properties carry the weight:
//   1. a tier that GREW into its column width equals one built at that width directly
//      (this is the merge path, and the only way to catch a broken merge);
//   2. every extreme in the input survives into the output, at its own timestamp.

import assert from 'node:assert/strict';
import {
  DEFAULT_COLUMNS, RenderTier, quantizeAnchor, windowBucketMs, type TierPoint,
} from '../lib/tier.ts';

let checks = 0;

interface S { ts: number; v: number }

/** Brute-force reference: bucket by hand, keep min/max and the timestamp each occurred at. */
function reference(
  samples: S[],
  t0: number,
  bucketMs: number,
  columns: number,
  clampMin?: number,
  clampMax?: number,
): TierPoint[] {
  const cols = new Map<number, { lo: number; hi: number; loTs: number; hiTs: number }>();
  for (const { ts, v } of samples) {
    let i = Math.floor((ts - t0) / bucketMs);
    if (i < 0) i = 0;
    assert.ok(i < columns, 'reference: sample outside the tier — widen bucketMs in the test');
    const b = cols.get(i);
    if (!b) cols.set(i, { lo: v, hi: v, loTs: ts, hiTs: ts });
    else {
      if (v < b.lo) { b.lo = v; b.loTs = ts; }
      if (v > b.hi) { b.hi = v; b.hiTs = ts; }
    }
  }
  const clamp = (v: number) => {
    if (clampMax !== undefined && v > clampMax) return clampMax;
    if (clampMin !== undefined && v < clampMin) return clampMin;
    return v;
  };
  const out: TierPoint[] = [];
  for (const i of [...cols.keys()].sort((a, b) => a - b)) {
    const b = cols.get(i)!;
    const loY = clamp(b.lo);
    const hiY = clamp(b.hi);
    if (b.lo === b.hi) { out.push({ x: b.loTs, y: loY, oor: loY !== b.lo }); continue; }
    const first = b.loTs <= b.hiTs
      ? [{ x: b.loTs, y: loY, oor: loY !== b.lo }, { x: b.hiTs, y: hiY, oor: hiY !== b.hi }]
      : [{ x: b.hiTs, y: hiY, oor: hiY !== b.hi }, { x: b.loTs, y: loY, oor: loY !== b.lo }];
    out.push(...first);
  }
  return out;
}

/**
 * The guarantee, asserted WITHOUT reusing the tier's emission rule: every per-column extreme
 * in the input must appear in the output, at its own timestamp. `reference()` mirrors
 * lib/tier.ts closely enough that a wrong *rule* would be copied into both — this does not.
 */
const everyExtremeSurvives = (
  samples: S[], pts: TierPoint[], t0: number, bucketMs: number, where: string,
) => {
  const cols = new Map<number, { lo: number; hi: number; loTs: number; hiTs: number }>();
  for (const { ts, v } of samples) {
    const i = Math.max(0, Math.floor((ts - t0) / bucketMs));
    const b = cols.get(i);
    if (!b) cols.set(i, { lo: v, hi: v, loTs: ts, hiTs: ts });
    else {
      if (v < b.lo) { b.lo = v; b.loTs = ts; }
      if (v > b.hi) { b.hi = v; b.hiTs = ts; }
    }
  }
  const has = (x: number, y: number) => pts.some((p) => p.x === x && p.y === y);
  for (const b of cols.values()) {
    assert.ok(has(b.loTs, b.lo), `${where}: column minimum ${b.lo}@${b.loTs} survived`);
    assert.ok(has(b.hiTs, b.hi), `${where}: column maximum ${b.hi}@${b.hiTs} survived`);
  }
};

const samePoints = (a: TierPoint[], b: TierPoint[], where: string) => {
  assert.equal(a.length, b.length, `${where}: point count`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x, `${where}: x at ${i}`);
    assert.equal(a[i].y, b[i].y, `${where}: y at ${i}`);
    assert.equal(a[i].oor, b[i].oor, `${where}: oor at ${i}`);
  }
};

/** Deterministic pseudo-random, so a failure is reproducible. */
function makeSamples(n: number, t0: number, stepMs: number): S[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: S[] = [];
  for (let i = 0; i < n; i++) out.push({ ts: t0 + i * stepMs, v: Math.sin(i / 7) + rnd() * 0.1 });
  return out;
}

// --- 1. a tier that GREW equals one built at the final width --------------------
// The merge path. A tier started narrow and doubled into shape must be indistinguishable
// from one that was that shape all along, or the picture depends on when you started looking.
{
  const COLUMNS = 16;
  const t0 = 1_000_000;
  const samples = makeSamples(400, t0, 33);

  const grown = new RenderTier(COLUMNS);
  grown.reset(t0, 1); // absurdly narrow on purpose: forces many doublings
  for (const s of samples) grown.add(s.ts, s.v);
  assert.ok(grown.bucketMs > 4, `at least two doublings happened (bucketMs=${grown.bucketMs})`);

  const direct = new RenderTier(COLUMNS);
  direct.reset(t0, grown.bucketMs);
  for (const s of samples) direct.add(s.ts, s.v);

  samePoints(grown.points(), direct.points(), 'grown vs direct');
  assert.equal(grown.t0, direct.t0, 'doubling does not move t0');
  samePoints(grown.points(), reference(samples, t0, grown.bucketMs, COLUMNS), 'grown vs reference');
  everyExtremeSurvives(samples, grown.points(), t0, grown.bucketMs, 'grown');
  checks += 5;
}

// The same, at several column counts and sample densities — a merge bug that only shows at
// an odd column count or a particular doubling depth would survive a single-shape test.
{
  for (const COLUMNS of [4, 8, 64, 1000]) {
    for (const n of [1, 2, 17, 500, 3000]) {
      const t0 = 500_000;
      const samples = makeSamples(n, t0, 17);
      const grown = new RenderTier(COLUMNS);
      grown.reset(t0, 1);
      for (const s of samples) grown.add(s.ts, s.v);

      const direct = new RenderTier(COLUMNS);
      direct.reset(t0, grown.bucketMs);
      for (const s of samples) direct.add(s.ts, s.v);
      samePoints(grown.points(), direct.points(), `grown vs direct (cols=${COLUMNS}, n=${n})`);
      samePoints(
        grown.points(),
        reference(samples, t0, grown.bucketMs, COLUMNS),
        `grown vs reference (cols=${COLUMNS}, n=${n})`,
      );
      everyExtremeSurvives(samples, grown.points(), t0, grown.bucketMs, `cols=${COLUMNS}, n=${n}`);
    }
  }
  checks += 3;
}

// --- 2. every extreme survives, at its own timestamp ----------------------------
// The guarantee that rules out lttb and averaging: one sample out of thousands, at any zoom.
{
  const COLUMNS = 8;
  const t0 = 2_000_000;
  const samples: S[] = [];
  for (let i = 0; i < 5000; i++) samples.push({ ts: t0 + i * 330, v: 1.5 });
  const spikeIdx = 3137;
  const spikeTs = t0 + spikeIdx * 330;
  samples[spikeIdx] = { ts: spikeTs, v: 99.9 };
  const dipIdx = 812;
  const dipTs = t0 + dipIdx * 330;
  samples[dipIdx] = { ts: dipTs, v: -42.0 };

  const tier = new RenderTier(COLUMNS);
  tier.reset(t0, 1);
  for (const s of samples) tier.add(s.ts, s.v);
  const pts = tier.points();

  // A column here spans ~3.4 minutes of a 27-minute series, yet both singletons survive.
  const spike = pts.find((p) => p.y === 99.9);
  assert.ok(spike, 'a single-sample spike survives reduction');
  assert.equal(spike!.x, spikeTs, 'the spike is drawn at the instant it was measured');
  const dip = pts.find((p) => p.y === -42.0);
  assert.ok(dip, 'a single-sample dip survives reduction');
  assert.equal(dip!.x, dipTs, 'the dip is drawn at the instant it was measured');

  assert.ok(pts.length <= 2 * COLUMNS, `bounded output (${pts.length} <= ${2 * COLUMNS})`);
  assert.ok(pts.length < samples.length / 100, 'and far smaller than the input');

  // Ordering is the property a chart depends on.
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].x >= pts[i - 1].x, `points are in timestamp order at ${i}`);
  }
  const ext = tier.extent();
  assert.equal(ext!.min, -42.0, 'extent sees the dip');
  assert.equal(ext!.max, 99.9, 'extent sees the spike');
  checks += 9;
}

// An extreme must survive EVERY doubling, not just the first — walk the tier as it grows.
{
  const tier = new RenderTier(4);
  const t0 = 0;
  tier.reset(t0, 1);
  tier.add(0, 5);
  tier.add(1, 1000); // the extreme, added early so it is merged repeatedly
  for (let ts = 2; ts < 400; ts++) tier.add(ts, 5);
  const p = tier.points().find((q) => q.y === 1000);
  assert.ok(p, 'an extreme survives repeated merges');
  assert.equal(p!.x, 1, 'and keeps its ORIGINAL timestamp, not the column start');
  checks += 2;
}

// --- 2b. duplicate timestamps: the case the parser actually produces --------------
// `parseMeasurement` stamps every reading `ts: Date.now()`, and a batch of 3-10 readings is
// parsed synchronously — so several readings PER MILLISECOND is the normal case, not an edge
// one. Deduping a column on timestamp equality instead of value equality silently deletes
// the larger of two same-millisecond readings, which is exactly a lost transient.
{
  const t = new RenderTier(16);
  t.reset(0, 1000);
  t.add(100, 5);
  t.add(100, 999); // a spike in the same millisecond as a normal reading
  const pts = t.points();
  assert.equal(pts.length, 2, 'same-ts different-value emits BOTH, not one');
  assert.ok(pts.some((p) => p.y === 999), 'the spike is not swallowed by the dedup');
  assert.ok(pts.some((p) => p.y === 5), 'and neither is the normal reading');
  assert.equal(pts[0].x, pts[1].x, 'both at the same x — a vertical stroke is correct here');
  assert.deepEqual(t.extent(), { min: 5, max: 999 }, 'extent agrees with points');

  // A whole batch inside one millisecond, which is what a real capture batch looks like.
  const batch = new RenderTier(8);
  batch.reset(0, 10_000);
  for (const v of [1.0, 1.1, 42.0, 1.2, -7.0]) batch.add(500, v);
  const bp = batch.points();
  assert.ok(bp.some((p) => p.y === 42.0), 'batch maximum survives');
  assert.ok(bp.some((p) => p.y === -7.0), 'batch minimum survives');
  const batchSamples = [1.0, 1.1, 42.0, 1.2, -7.0].map((v) => ({ ts: 500, v }));
  everyExtremeSurvives(batchSamples, bp, 0, 10_000, 'one-ms batch');
  // Full-set comparison too, not just presence: `everyExtremeSurvives` cannot see a spurious
  // extra point, wrong ordering, or a wrong `oor` flag, so it never stands alone.
  samePoints(bp, reference(batchSamples, 0, 10_000, 8), 'one-ms batch full set');

  // -0 and 0 are the same measurement, so a column holding both is ONE point. Asserted so a
  // future reader does not mistake it for the same-ts-different-value bug fixed above.
  const zeros = new RenderTier(8);
  zeros.reset(0, 10_000);
  zeros.add(10, -0);
  zeros.add(20, 0);
  assert.equal(zeros.points().length, 1, '-0 and 0 are one measurement, not a divergence');

  // Genuinely identical value AND timestamp still collapses to one point.
  const flat = new RenderTier(8);
  flat.reset(0, 10_000);
  flat.add(500, 3); flat.add(500, 3);
  assert.equal(flat.points().length, 1, 'same ts AND same value is still one point');
  checks += 11;
}

// --- 2c. an odd column count must not discard the unpaired last column -------------
// `columns >> 1` leaves column `columns-1` out of the merge loop and then zeroes it.
{
  const t = new RenderTier(3);
  t.reset(0, 1);
  t.add(0, 1);
  t.add(1, 2);
  t.add(2, 999); // the extreme, in the column with no merge partner
  t.add(10, 5);  // forces a doubling
  const pts = t.points();
  assert.ok(pts.some((p) => p.y === 999), 'an extreme in the unpaired last column survives');
  assert.equal(pts.find((p) => p.y === 999)!.x, 2, 'and keeps its timestamp');

  // Odd counts behave like even ones under the grown-vs-direct property.
  for (const COLUMNS of [3, 5, 7, 17, 999]) {
    const t0 = 1000;
    const samples = makeSamples(300, t0, 21);
    const grown = new RenderTier(COLUMNS);
    grown.reset(t0, 1);
    for (const sm of samples) grown.add(sm.ts, sm.v);
    const direct = new RenderTier(COLUMNS);
    direct.reset(t0, grown.bucketMs);
    for (const sm of samples) direct.add(sm.ts, sm.v);
    samePoints(grown.points(), direct.points(), `odd columns=${COLUMNS}`);
    everyExtremeSurvives(samples, grown.points(), t0, grown.bucketMs, `odd columns=${COLUMNS}`);
  }
  checks += 4;
}

// --- 2d. non-finite input is dropped, never stored ---------------------------------
// A NaN reaching a column poisons it permanently: every later `value < NaN` is false, so no
// real extreme can replace it, and `extent()` returns null over perfectly good data.
{
  const t = new RenderTier(16);
  t.reset(0, 100_000);
  t.add(10, NaN);
  t.add(20, 5);
  t.add(30, 999);
  t.add(40, -999);
  const pts = t.points();
  assert.ok(pts.every((p) => Number.isFinite(p.y)), 'no NaN reaches the drawn series');
  assert.ok(pts.some((p) => p.y === 999), 'a real extreme after a NaN is still recorded');
  assert.ok(pts.some((p) => p.y === -999), 'in both directions');
  assert.deepEqual(t.extent(), { min: -999, max: 999 }, 'extent is not poisoned');

  const inf = new RenderTier(16);
  inf.reset(0, 1000);
  inf.add(10, Infinity);
  inf.add(20, -Infinity);
  inf.add(30, 7);
  assert.deepEqual(inf.points(), [{ x: 30, y: 7, oor: false }], 'infinities are dropped');

  // A non-finite TIMESTAMP must not churn the tier through ~1000 doublings, coarsening
  // every real column on the way, before discarding the sample anyway.
  const churn = new RenderTier(16);
  churn.reset(0, 1000);
  for (let i = 0; i < 10; i++) churn.add(i * 1000, i);
  const widthBefore = churn.bucketMs;
  churn.add(Infinity, 1);
  churn.add(NaN, 1);
  assert.equal(churn.bucketMs, widthBefore, 'a non-finite ts does not widen the columns');
  assert.equal(churn.points().length, 10, 'and adds nothing');
  checks += 7;
}

// --- 2e. a timestamp before t0 (a clock step over a seven-day session) --------------
// NTP correction or a DST change can make Date.now() step backwards. The sample is folded
// into column 0 rather than dropped, and must keep its own timestamp.
{
  const t = new RenderTier(16);
  t.reset(1000, 10);
  t.add(1005, 5);
  t.add(900, 77); // before t0
  const pts = t.points();
  assert.ok(pts.some((p) => p.y === 77), 'a sample before t0 is folded in, not lost');
  assert.equal(pts.find((p) => p.y === 77)!.x, 900, 'and keeps its ORIGINAL timestamp');
  assert.equal(t.extent()!.max, 77, 'extent sees it');
  checks += 3;
}

// --- 2f. bucket boundaries must be QUANTIZED to absolute time ----------------------
// A sliding window re-anchored at `now - windowMs` moves its bucket boundaries a little on
// every update, so samples get re-dealt into different buckets and the drawn min/max pair
// changes — a line that jitters by a pixel over completely stable data. Quantizing t0 to a
// multiple of bucketMs makes a sample's bucket a property of its timestamp alone, so the
// window sliding shifts the tier by whole columns instead.
{
  // Enough columns that the samples below never trigger a doubling: the property under
  // test is bucket ASSIGNMENT, and a doubling mid-test would compare two different widths.
  const COLUMNS = 256;
  const bucketMs = 1000;
  const samples: S[] = [];
  for (let i = 0; i < 300; i++) samples.push({ ts: 500_000 + i * 330, v: Math.sin(i / 5) });

  const build = (t0: number) => {
    const t = new RenderTier(COLUMNS);
    t.reset(t0, bucketMs);
    for (const sm of samples) t.add(sm.ts, sm.v);
    return t.points();
  };

  // Three quantized anchors, all at or below the oldest sample so every sample is included.
  const q = Math.floor(samples[0].ts / bucketMs) * bucketMs;
  const a = build(q);
  const b = build(q - bucketMs);
  const c = build(q - 5 * bucketMs);
  samePoints(a, b, 'quantized t0, shifted one bucket');
  samePoints(a, c, 'quantized t0, shifted five buckets');
  everyExtremeSurvives(samples, a, q, bucketMs, 'quantized t0');

  // The bounded-window configuration must never double. Quantizing t0 DOWN buys up to one
  // extra bucket of span, so a full window plus that slack has to still fit — which is why
  // the chart divides by `DEFAULT_COLUMNS - 2` rather than by `DEFAULT_COLUMNS`. Without
  // the headroom a sample arriving at `now` lands one column past the end, doubles the
  // width and halves the resolution for exactly one frame.
  for (const windowMs of [10_000, 60_000, 600_000, 3_600_000]) {
    const cols = DEFAULT_COLUMNS;
    const bw = windowBucketMs(windowMs);
    for (const now of [1_700_000_000, 1_700_000_137, 1_700_000_999]) {
      const anchor = quantizeAnchor(now - windowMs, bw);
      const t = new RenderTier(cols);
      t.reset(anchor, bw);
      // The whole window, plus a sample landing exactly at `now` — the worst case.
      for (let ts = now - windowMs; ts < now; ts += 330) t.add(ts, 1);
      t.add(now, 1);
      assert.equal(t.bucketMs, bw, `window ${windowMs} at now=${now}: no doubling`);
    }
  }

  // The contrapositive, so this test can actually fail: an UNQUANTIZED anchor regroups the
  // samples and yields a different picture from the same data. If this ever stops differing,
  // the assertions above have stopped meaning anything.
  const drifted = build(q + Math.floor(bucketMs / 3));
  const differs =
    drifted.length !== a.length ||
    drifted.some((p, i) => p.x !== a[i].x || p.y !== a[i].y);
  assert.ok(differs, 'an unquantized anchor regroups samples — which is the bug being prevented');
  checks += 5;
}

// --- 2g. KNOWN LIMITATION: a window with no sample in it is not drawable -----------
// Pinned deliberately, so the next person to touch this knows it is understood rather than
// overlooked. Feeding the last sample BEFORE the window (so the trace enters from the left
// edge) leaves exactly one point when the window itself holds nothing, and Chart.js cannot
// draw a segment from one point. Under "Stable values only" that is the ordinary case, not
// an edge one. See docs/limitations.md; fixing it is a product decision about what a sparse
// filtered series should look like, not a bug in this module.
{
  const now = 1_700_000_000_000;
  const windowMs = 10_000;
  const bucketMs = windowBucketMs(windowMs);
  const t0 = quantizeAnchor(now - windowMs, bucketMs);

  const t = new RenderTier(DEFAULT_COLUMNS);
  t.reset(t0, bucketMs);
  t.add(now - 300_000, 1.52); // the only relevant sample: five minutes before the window
  assert.equal(t.points().length, 1, 'a window with no sample inside yields ONE point');
  assert.equal(t.points()[0].x, now - 300_000, 'kept at its own timestamp, not snapped to t0');

  // With a sample actually inside the window there is a segment, and it starts left of it.
  const t2 = new RenderTier(DEFAULT_COLUMNS);
  t2.reset(t0, bucketMs);
  t2.add(now - 300_000, 1.52);
  t2.add(now - 5_000, 1.53);
  const pts = t2.points();
  assert.ok(pts.length >= 2, 'a sample inside the window gives a drawable segment');
  assert.ok(pts[0].x < t0, 'which enters from outside the left edge');
  checks += 4;
}

// --- 3. clamping, in both directions --------------------------------------------
// Clamping happens at draw, over columns, not at capture over samples. It is equivalent
// because clamping is monotonic — assert that equivalence rather than assuming it.
{
  const COLUMNS = 32;
  const t0 = 0;
  const samples: S[] = [];
  for (let i = 0; i < 600; i++) samples.push({ ts: i * 10, v: Math.sin(i / 11) * 10 });

  const tier = new RenderTier(COLUMNS);
  tier.reset(t0, 1);
  for (const s of samples) tier.add(s.ts, s.v);

  for (const [lo, hi] of [[-2, 2], [undefined, 3], [-3, undefined], [-100, 100]] as const) {
    const got = tier.points(lo, hi);
    samePoints(got, reference(samples, t0, tier.bucketMs, COLUMNS, lo, hi), `clamp ${lo}..${hi}`);

    // Monotonicity, stated precisely. Clamping commutes with min/max on VALUES, so
    // reduce-then-clamp and clamp-then-reduce agree on every extreme. They do NOT agree on
    // x: clamping first destroys which sample was extreme, so the clipped point lands on
    // whichever sample happened to come first. Reduce-then-clamp keeps the real extreme's
    // timestamp, which is the order this module uses and the more faithful one.
    const preClamped = new RenderTier(COLUMNS);
    preClamped.reset(t0, tier.bucketMs);
    for (const s of samples) {
      const v = hi !== undefined && s.v > hi ? hi : lo !== undefined && s.v < lo ? lo : s.v;
      preClamped.add(s.ts, v);
    }
    const clampV = (v: number) =>
      hi !== undefined && v > hi ? hi : lo !== undefined && v < lo ? lo : v;
    const e = tier.extent()!;
    assert.deepEqual(
      { min: clampV(e.min), max: clampV(e.max) },
      preClamped.extent(),
      `clamping commutes with min/max on values (${lo}..${hi})`,
    );
  }

  const tight = tier.points(-1, 1);
  assert.ok(tight.some((p) => p.oor), 'a clamped point is flagged out-of-range');
  assert.ok(tight.every((p) => p.y >= -1 && p.y <= 1), 'nothing escapes the range');
  const wide = tier.points(-1000, 1000);
  assert.ok(wide.every((p) => !p.oor), 'nothing is flagged when the range covers the data');
  assert.ok(tier.points().every((p) => !p.oor), 'no range means no clamping');
  checks += 8;
}

// --- 4. edges ---------------------------------------------------------------------
{
  const empty = new RenderTier(16);
  empty.reset(1000, 10);
  assert.deepEqual(empty.points(), [], 'an empty tier draws nothing');
  assert.equal(empty.extent(), null, 'an empty tier has no extent');
  assert.equal(empty.isEmpty, true, 'and says so');

  const one = new RenderTier(16);
  one.reset(1000, 10);
  one.add(1005, 7);
  assert.deepEqual(one.points(), [{ x: 1005, y: 7, oor: false }], 'one sample draws ONE point');
  assert.equal(one.isEmpty, false, 'a tier with a sample is not empty');
  assert.deepEqual(one.extent(), { min: 7, max: 7 }, 'extent of a single sample');

  // A flat column: min and max share a timestamp, so it must not emit a zero-width segment.
  const flat = new RenderTier(16);
  flat.reset(0, 1000);
  for (let i = 0; i < 50; i++) flat.add(i, 3);
  const fp = flat.points();
  assert.equal(fp.length, 1, 'a perfectly flat column yields one point, not a duplicate x');
  assert.equal(fp[0].y, 3, 'at the flat value');

  // Everything inside one column.
  const single = new RenderTier(16);
  single.reset(0, 10_000);
  single.add(10, 1);
  single.add(20, 5);
  single.add(30, 3);
  assert.deepEqual(
    single.points(),
    [{ x: 10, y: 1, oor: false }, { x: 20, y: 5, oor: false }],
    'one column emits its min and max, in timestamp order',
  );

  // Descending order: the max occurs BEFORE the min, so the emitted pair must swap.
  const desc = new RenderTier(16);
  desc.reset(0, 10_000);
  desc.add(10, 9);
  desc.add(20, 2);
  assert.deepEqual(
    desc.points(),
    [{ x: 10, y: 9, oor: false }, { x: 20, y: 2, oor: false }],
    'max-before-min is emitted in timestamp order, not min-first',
  );

  // reset really clears: a stale column from a previous session must not be drawn.
  const reused = new RenderTier(16);
  reused.reset(0, 10);
  for (let i = 0; i < 100; i++) reused.add(i, i);
  reused.reset(10_000, 10);
  assert.deepEqual(reused.points(), [], 'reset drops every previous column');
  reused.add(10_005, 1);
  assert.deepEqual(reused.points(), [{ x: 10_005, y: 1, oor: false }], 'and starts clean');
  checks += 12;
}

// --- 5. output stays bounded however long the session runs ------------------------
// The whole reason the tier exists: drawing cost must not grow with the session.
{
  const COLUMNS = 1000;
  const t0 = 0;
  for (const n of [1_000, 50_000, 500_000]) {
    const tier = new RenderTier(COLUMNS);
    tier.reset(t0, 1000);
    for (let i = 0; i < n; i++) tier.add(i * 330, Math.sin(i / 1000));
    const len = tier.points().length;
    assert.ok(len <= 2 * COLUMNS, `${n} samples -> ${len} points, bounded by 2x columns`);
    // Span grows 500x across these runs; the drawn series must not. (A previous version
    // re-asserted the same `len` after the loop, which could not fail.)
    assert.ok(tier.bucketMs >= 1000, `${n} samples: columns widened rather than overflowed`);
  }
  checks += 3;
}

console.log(`check-tier: ${checks} assertions passed`);
