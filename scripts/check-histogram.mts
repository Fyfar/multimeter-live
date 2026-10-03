// Self-check for lib/histogram.ts. Run by `npm run check` (see docs/quality.md).
//
// A wrong bin is silent: the chart still draws a tidy distribution, just not the one the
// meter measured. Everything goes through the one public `buildHistogram`.

import assert from 'node:assert/strict';
import { buildHistogram, type Entry } from '../lib/histogram.ts';

let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); checks++; };
const close = (a: number, b: number, m: string) => { assert.ok(Math.abs(a - b) < 1e-9, `${m}: got ${a}, want ${b}`); checks++; };
const total = (h: ReturnType<typeof buildHistogram>) => h.bins.reduce((s, b) => s + b.count, 0);
const inRange = (h: ReturnType<typeof buildHistogram>) => h.bins.filter((b) => b.kind === 'in');
const binOf = (h: ReturnType<typeof buildHistogram>, v: number) =>
  h.bins.findIndex((b) => b.kind === 'in' && Math.abs(b.value - v) < h.width / 2);

// --- totals: bars are counts per distinct value, summed (+= n), on every path ----------
const spread: Entry[] = [[9.977, 50], [9.976, 10], [9.978, 7], [12.5, 1], [-3, 2]];
const lsd = buildHistogram(spread, 0.001, 9.977);
eq(total(lsd), 70, 'LSD bars total the entry counts, outliers included');
eq(total(buildHistogram(spread, undefined, undefined)), 70, 'equal-width bars total the entry counts');

// --- LSD grid: zero-anchored multiples of the width, adjacent values in adjacent bins ----
const steps = inRange(lsd).map((b) => Math.round(b.value / lsd.width));
eq(steps.every((k, i) => i === 0 || k === steps[i - 1] + 1), true, 'in-range bins are consecutive LSD multiples');
const [a, b, c] = [9.976, 9.977, 9.978].map((v) => binOf(lsd, v));
eq([b - a, c - b], [1, 1], '9.976 / 9.977 / 9.978 at 0.001 land in adjacent, distinct bins');
eq([lsd.bins[a].count, lsd.bins[b].count, lsd.bins[c].count], [10, 50, 7], 'each LSD value counts into its own bin');
// 0.29 / 0.01 is 28.999999999999996 in floats: snapping must round, not truncate.
const inexact = buildHistogram([[0.29, 3]], 0.01, 0.29);
eq(inexact.bins[binOf(inexact, 0.29)].count, 3, 'a value whose division is inexact still lands in its own bin');

// --- window: MIN_BINS around the centre; most-counted value when no centre is given ------
const empty = buildHistogram([], 0.001, 9.977);
eq(empty.bins.length, 21, 'empty window shows exactly MIN_BINS bins');
eq(binOf(empty, 9.977), 10, 'empty window is centred on the supplied centre');
const noCentre = buildHistogram([[100, 1], [105, 9], [106, 3]], 1, undefined);
eq(noCentre.bins[10].value, 105, 'no centre -> centred on the most-counted value, not the first inserted');

// --- edge bins: beyond MAX_HALF_BINS collects into under/over; absent when nothing is out --
eq(lsd.bins[0].kind, 'under', '-3 (far below) lands in the under-range bin');
eq(lsd.bins[0].count, 2, 'under-range bin carries its count');
eq(lsd.bins.at(-1)?.kind, 'over', '12.5 (far above) lands in the over-range bin');
eq(lsd.bins.at(-1)?.count, 1, 'over-range bin carries its count');
// The edge bins read `< lo` / `> hi`: the window bounds, 10 LSD either side of 9.977 here.
close(lsd.bins[0].value, 9.967, 'under-range bin is labeled with the window low bound');
close(lsd.bins.at(-1)!.value, 9.987, 'over-range bin is labeled with the window high bound');
const tight = buildHistogram([[9.977, 5], [9.99, 1]], 0.001, 9.977);
eq(tight.bins.some((x) => x.kind !== 'in'), false, 'no edge bins when all data is within the window');
eq(binOf(tight, 9.99) >= 0, true, 'data within MAX_HALF_BINS widens the window instead of going to an edge bin');

// --- fallback: invalid LSD -> BIN_COUNT equal-width bins over min..max -------------------
for (const w of [undefined, 0, NaN, Infinity, -1]) {
  eq(buildHistogram(spread, w, 9.977).bins.length, 25, `binWidth ${w} -> equal-width fallback`);
}
const eqw = buildHistogram([[1, 1], [2, 1], [11, 4]], undefined, undefined);
eq(eqw.bins.at(-1)?.count, 4, 'max lands in the last bin, not off the end');
eq(eqw.width, 10 / 25, 'equal-width width is the range over BIN_COUNT');
close(eqw.bins[1].value, 1.4, 'equal-width bins are labeled with their left edge');
close(eqw.bins[24].value, 10.6, 'the last equal-width bin starts one width below max');
eq(buildHistogram([[3.3, 8]], undefined, undefined), { bins: [{ value: 3.3, count: 8, kind: 'in' }], width: 1 },
  'min === max -> one bin carrying the whole total');
eq(buildHistogram([], undefined, undefined).bins, [], 'no data, no LSD -> no bins');

console.log(`check-histogram: ${checks} assertions passed`);
