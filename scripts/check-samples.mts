// Self-check for lib/samples.ts. Run by `npm run check` (see docs/quality.md).
//
// Every property here is silent when it breaks: a wrong chunk index reads a neighbouring
// sample, a rewound `seq` blanks the chart, a note that migrates on trim is only visible to
// whoever reads the export months later. None of it can be checked by looking at the screen,
// which is why the store lives in `lib/` rather than in component state.
//
// The method throughout: run the store and a plain-array reference model through the same
// operations and assert they agree. A check that only asserts a constant equals its own
// literal is worse than none.

import assert from 'node:assert/strict';
import {
  CHUNK,
  MODES,
  RETENTION_MS,
  SampleStore,
  UNITS,
  type Sample,
} from '../lib/samples.ts';
import { SCALE, type Mode } from '../lib/parser.ts';

let checks = 0;

/** Plain-array reference model: obviously correct, hopelessly inefficient. */
class RefModel {
  rows: Omit<Sample, 'note'>[] = [];
  notes = new Map<number, string>();
  firstSeq = 0;
  append(ts: number, value: number, mode: Mode, unit: string, decimals: number): number {
    const seq = this.firstSeq + this.rows.length;
    const d = Number.isFinite(decimals) ? Math.min(20, Math.max(0, Math.trunc(decimals))) : 0;
    this.rows.push({ seq, ts, value, mode, unit, decimals: d });
    return seq;
  }
  at(i: number): Sample {
    const r = this.rows[i];
    return { ...r, note: this.notes.get(r.seq) ?? '' };
  }
}

const sameSample = (a: Sample, b: Sample, where: string) => {
  assert.equal(a.seq, b.seq, `${where}: seq`);
  assert.equal(a.ts, b.ts, `${where}: ts`);
  assert.equal(a.value, b.value, `${where}: value`);
  assert.equal(a.mode, b.mode, `${where}: mode`);
  assert.equal(a.unit, b.unit, `${where}: unit`);
  assert.equal(a.decimals, b.decimals, `${where}: decimals`);
  assert.equal(a.note, b.note, `${where}: note`);
};

// --- append / at, across three chunk boundaries --------------------------------
// The whole point of chunking is that index arithmetic crosses a boundary without the caller
// noticing. 3.5 chunks exercises three crossings plus a partial tail.
{
  const store = new SampleStore();
  const ref = new RefModel();
  const N = CHUNK * 3 + 1000;
  for (let i = 0; i < N; i++) {
    // Values that are distinct per index, so reading a neighbouring slot cannot pass.
    const ts = 1_000_000 + i * 330; // ~3.03 samples/s
    const value = i * 1e-4;
    const mode = MODES[i % MODES.length];
    const unit = UNITS[1 + (i % (UNITS.length - 1))];
    const a = store.append(ts, value, mode, unit, i % 6);
    const b = ref.append(ts, value, mode, unit, i % 6);
    assert.equal(a, b, `seq returned by append at ${i}`);
  }
  assert.equal(store.count, N, 'count after appends');
  checks += 2;

  for (const i of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 3 * CHUNK, N - 1]) {
    sameSample(store.at(i), ref.at(i), `at(${i})`);
    assert.equal(store.tsAt(i), ref.rows[i].ts, `tsAt(${i})`);
    assert.equal(store.valueAt(i), ref.rows[i].value, `valueAt(${i})`);
  }
  checks += 9 * 3;

  // Every index, not just the interesting ones — a systematic off-by-one in the shift/mask
  // would survive a sampled check.
  for (let i = 0; i < N; i++) {
    assert.equal(store.tsAt(i), ref.rows[i].ts, `tsAt sweep ${i}`);
  }
  checks++;
}

// --- the decimals clamp (untrusted serial input) -------------------------------
// `Reading.display` is a raw slice of the serial buffer; `displayDecimals` has no clamp, so a
// garbled packet can report hundreds. A Uint8Array wraps SILENTLY: 300 -> 44.
{
  const store = new SampleStore();
  store.append(1, 1, 'VOLTAGE', 'V', 300);
  assert.equal(store.at(0).decimals, 20, '300 decimals clamps to 20, NOT 44 (u8 wrap)');
  assert.notEqual(store.at(0).decimals, 44, 'the wrap value specifically');

  store.append(2, 1, 'VOLTAGE', 'V', 256);
  assert.equal(store.at(1).decimals, 20, '256 decimals clamps to 20, NOT 0 (u8 wrap)');

  store.append(3, 1, 'VOLTAGE', 'V', -5);
  assert.equal(store.at(2).decimals, 0, 'negative decimals clamp to 0');

  store.append(4, 1, 'VOLTAGE', 'V', NaN);
  assert.equal(store.at(3).decimals, 0, 'NaN decimals store as 0');

  store.append(5, 1, 'VOLTAGE', 'V', 3);
  assert.equal(store.at(4).decimals, 3, 'a real reading is untouched');
  checks += 6;
}

// --- unknown units extend the dictionary rather than throwing ------------------
// lib/parser.ts documents that what the ZT703s sends above nF is unconfirmed.
{
  const store = new SampleStore();
  store.append(1, 1, 'CAPACITANCE', 'GF', 2);
  assert.equal(store.at(0).unit, 'GF', 'an unknown unit round-trips');
  store.append(2, 2, 'CAPACITANCE', 'nF', 2);
  assert.equal(store.at(1).unit, 'nF', 'a known unit still works after extending');
  checks += 2;
}

// --- indexAtOrAfter -------------------------------------------------------------
// Ported from the firstIndexInWindow assertions in scripts/check-settings.mts, which this
// replaces. The boundary rule is load-bearing: a hit is INSIDE the window.
{
  const empty = new SampleStore();
  assert.equal(empty.indexAtOrAfter(30), 0, 'empty store -> 0');

  const store = new SampleStore();
  for (const ts of [10, 20, 30, 40, 50]) store.append(ts, 0, 'VOLTAGE', 'V', 1);
  assert.equal(store.indexAtOrAfter(5), 0, 'everything in window -> 0');
  assert.equal(store.indexAtOrAfter(99), 5, 'nothing in window -> count');
  assert.equal(store.indexAtOrAfter(30), 2, 'a boundary hit is INSIDE the window');
  assert.equal(store.indexAtOrAfter(31), 3, 'just past a point excludes it');

  const one = new SampleStore();
  one.append(10, 0, 'VOLTAGE', 'V', 1);
  assert.equal(one.indexAtOrAfter(10), 0, 'single sample, at the boundary');
  assert.equal(one.indexAtOrAfter(11), 1, 'single sample, out of window');

  const dup = new SampleStore();
  for (const ts of [10, 10, 10, 20]) dup.append(ts, 0, 'VOLTAGE', 'V', 1);
  assert.equal(dup.indexAtOrAfter(10), 0, 'repeated timestamps: FIRST of the run');
  assert.equal(dup.indexAtOrAfter(20), 3, 'repeated timestamps: past the run');

  // Across chunks, where a naive per-chunk search would go wrong.
  const big = new SampleStore();
  for (let i = 0; i < CHUNK * 2 + 5; i++) big.append(1000 + i * 10, 0, 'VOLTAGE', 'V', 1);
  assert.equal(big.indexAtOrAfter(1000 + CHUNK * 10), CHUNK, 'boundary sample across chunks');
  assert.equal(big.indexAtOrAfter(1000 + (CHUNK + 1) * 10 - 1), CHUNK + 1, 'between two chunks');
  checks += 11;
}

// --- trim: whole chunks only, seq stable, notes follow their row ----------------
{
  const store = new SampleStore();
  const N = CHUNK * 3 + 500;
  for (let i = 0; i < N; i++) store.append(1000 + i, i, 'VOLTAGE', 'V', 2);

  // A note on a row that will survive, and one on a row that will not.
  const doomedSeq = 5;
  const survivorSeq = CHUNK * 2 + 7;
  store.setNote(doomedSeq, 'gone');
  store.setNote(survivorSeq, 'kept');
  const survivorBefore = store.at(survivorSeq - store.firstSeq);

  // Cut inside chunk 1 -> only chunk 0 is entirely older, so only chunk 0 goes.
  const dropped = store.trim(1000 + CHUNK + 10);
  assert.equal(dropped, true, 'trim reports that it dropped something');
  assert.equal(store.firstSeq, CHUNK, 'exactly one whole chunk left');
  assert.equal(store.count, N - CHUNK, 'count drops by exactly one chunk');
  // A partial chunk is never dropped: samples newer than the cut are still here.
  assert.equal(store.tsAt(0), 1000 + CHUNK, 'oldest retained sample is the chunk boundary');
  checks += 4;

  // seq is an identity, not an index: the survivor is at a new index under the same seq.
  const survivorAfter = store.at(survivorSeq - store.firstSeq);
  sameSample(survivorAfter, survivorBefore, 'survivor across a trim');
  assert.equal(survivorAfter.note, 'kept', 'a note stays on ITS OWN row after a trim');
  assert.equal(store.noteOf(doomedSeq), '', 'a note on a discarded row is released');
  checks += 3;

  // Trimming below the oldest retained sample is a no-op.
  assert.equal(store.trim(0), false, 'nothing to drop -> false');
  assert.equal(store.count, N - CHUNK, 'a no-op trim changes nothing');
  checks += 2;

  // A cut past everything empties the store (a session abandoned for over a week).
  const all = new SampleStore();
  for (let i = 0; i < 100; i++) all.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  assert.equal(all.trim(99_999), true, 'everything older -> dropped');
  assert.equal(all.count, 0, 'store is empty');
  assert.equal(all.firstSeq, 100, 'firstSeq advanced past every discarded sample');
  checks += 3;
}

// --- clear keeps seq monotonic --------------------------------------------------
// A rewind to 0 would let a watermark held across a Clear sit AHEAD of every new sample:
// permanently blank chart over a full Data Log. Make that unrepresentable.
{
  const store = new SampleStore();
  for (let i = 0; i < 50; i++) store.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  const lastSeq = store.firstSeq + store.count - 1;

  store.clear();
  assert.equal(store.count, 0, 'clear empties the store');
  assert.equal(store.firstSeq, lastSeq + 1, 'firstSeq is the next UNUSED seq, not 0');
  assert.notEqual(store.firstSeq, 0, 'clear does NOT rewind seq');

  const reused = store.append(2000, 1, 'VOLTAGE', 'V', 2);
  assert.equal(reused, lastSeq + 1, 'the first seq after a clear continues the sequence');
  assert.ok(reused > lastSeq, 'no seq is ever reused');
  checks += 5;

  // Clear after a trim also continues, rather than resetting to the trimmed firstSeq.
  const t = new SampleStore();
  for (let i = 0; i < CHUNK + 10; i++) t.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  t.trim(1000 + CHUNK);
  const next = t.firstSeq + t.count;
  t.clear();
  assert.equal(t.firstSeq, next, 'clear after trim still advances to the next unused seq');
  checks++;
}

// --- notes ----------------------------------------------------------------------
{
  const store = new SampleStore();
  for (let i = 0; i < 10; i++) store.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  store.setNote(3, 'hello');
  assert.equal(store.at(3).note, 'hello', 'a note reads back on its row');
  assert.equal(store.at(4).note, '', 'and only on its row');
  store.setNote(3, '');
  assert.equal(store.at(3).note, '', 'clearing a note removes it');
  checks += 3;
}

// --- the chart's x-axis anchor across a preserve-log mode change --------------------
// `CaptureEngine` derives the anchor as `tsAt(watermark - firstSeq)` — the oldest sample the
// chart can see. The regression this pins: tracking a candidate DURING the batch instead
// captured it against the pre-advance watermark, so a preserve-log mode change anchored the
// axis to an old-unit sample and the session-start latch then made it stick for the rest of
// the session.
{
  const store = new SampleStore();
  const anchorOf = (watermark: number): number | null => {
    const i = Math.max(0, watermark - store.firstSeq);
    return store.count > i ? store.tsAt(i) : null;
  };

  // Two Voltage samples logged, then the operator's meter switches to Current.
  store.append(1000, 1, 'VOLTAGE', 'V', 3);
  store.append(1330, 2, 'VOLTAGE', 'V', 3);
  let watermark = 0;
  assert.equal(anchorOf(watermark), 1000, 'before the change, the anchor is the first sample');

  // Preserve-log mode change: the rows stay, the chart restarts past them.
  watermark = store.firstSeq + store.count; // 2
  assert.equal(anchorOf(watermark), null, 'right after the change there is nothing to anchor to');
  assert.equal(store.count, 2, 'and the Voltage rows are still in the log');

  store.append(9000, 5, 'CURRENT', 'A', 3);
  store.append(9330, 6, 'CURRENT', 'A', 3);
  assert.equal(anchorOf(watermark), 9000, 'the anchor is the first CURRENT sample');
  assert.notEqual(anchorOf(watermark), 1000, 'NOT the old-unit sample the regression picked');
  assert.equal(store.count, 4, 'all four rows remain for the table and the CSV');

  // A retention trim can carry the watermark below firstSeq; the clamp must hold.
  const big = new SampleStore();
  for (let i = 0; i < CHUNK * 2 + 10; i++) big.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  big.trim(1000 + CHUNK + 5);
  const stale = 3; // a watermark from before the trim
  const idx = Math.max(0, stale - big.firstSeq);
  assert.equal(idx, 0, 'a watermark older than the retained window clamps to the oldest sample');
  assert.equal(big.tsAt(idx), 1000 + CHUNK, 'and resolves to a real retained sample');
  checks += 8;
}

// --- retention, measured rather than re-typed -------------------------------------
// A literal compared against a copy of itself proves nothing (docs/quality.md). These
// assert what the memory arithmetic in design.md actually rests on.
{
  // Bytes per sample, MEASURED off real columns — not the literal 19. A segment copies the
  // chunk's typed arrays, so a sixth column, or f64 where the design says u8, changes this.
  const probe = new SampleStore();
  probe.append(1, 1, 'VOLTAGE', 'V', 2);
  const c = probe.segment(0, 1);
  const bytesPerSample =
    c.ts.byteLength + c.value.byteLength + c.mode.byteLength +
    c.unit.byteLength + c.decimals.byteLength;
  assert.equal(bytesPerSample, 19, `19 B/sample (measured ${bytesPerSample})`);

  const samples = Math.round((RETENTION_MS / 1000) * 3.03); // the meter's measured rate
  assert.ok(samples > 1_800_000 && samples < 1_900_000, `~1.83M samples at 3.03/s (${samples})`);
  assert.equal(Math.ceil(samples / CHUNK), 112, 'seven days is 112 chunks');
  assert.ok((samples * bytesPerSample) / 1e6 < 40, 'under 40 MB at seven days');

  // Behavioural: retention is a FLOOR. Nothing inside the window is ever discarded, and
  // what survives past it is at most one chunk's worth of extra history.
  const now = 1_000_000_000;
  const store = new SampleStore();
  const n = CHUNK * 3;
  for (let i = 0; i < n; i++) store.append(now - (n - i) * 330, i, 'VOLTAGE', 'V', 2);
  const cut = now - CHUNK * 330; // one chunk's worth of history
  store.trim(cut);
  assert.ok(store.count >= CHUNK, 'everything inside the window is retained');
  for (let i = 0; i < store.count; i++) {
    assert.ok(store.tsAt(i) >= cut - CHUNK * 330, 'nothing older than window + one chunk survives');
  }
  assert.ok(store.tsAt(store.count - 1) >= cut, 'the newest sample is inside the window');
  checks += 7;
}

// --- the dictionaries match lib/parser.ts -----------------------------------------
{
  assert.equal(MODES.length, 6, 'six modes');
  assert.equal(new Set(MODES).size, MODES.length, 'no duplicate mode');
  assert.equal(new Set(UNITS).size, UNITS.length, 'no duplicate unit');
  assert.equal(UNITS[0], '', 'the empty unit is index 0');
  assert.ok(UNITS.length <= 256, 'the unit dictionary fits a Uint8Array');
  // Written out INDEPENDENTLY, not re-derived from SCALE. Comparing UNITS against
  // `['', ...Object.keys(SCALE)]` would compare the definition to itself and could only fail
  // if someone hand-edited UNITS — it gives no protection against SCALE itself gaining,
  // losing or misspelling a unit, which is the drift that actually matters, because the
  // ORDER of this list is part of the saved-session format.
  const EXPECTED_UNITS = [
    '', 'V', 'mV', 'A', 'mA', 'OM', 'KOM', 'MOM',
    'pF', 'nF', 'uF', '\u00B5F', '\u03BCF', 'mF',
  ];
  assert.deepEqual([...UNITS], EXPECTED_UNITS, 'the unit dictionary is exactly this, in this order');
  // All three micro spellings are distinct codepoints; parser.ts lists them deliberately.
  assert.equal(new Set(['\u00B5F', '\u03BCF', 'uF']).size, 3, 'the three micro spellings differ');
  assert.equal(Object.keys(SCALE).length, EXPECTED_UNITS.length - 1, 'SCALE has not gained or lost a unit');
  checks += 8;
}

// --- generation: advanced by clear() and by nothing else --------------------------
// A trim that empties the store leaves firstSeq/count identical to a clear(), so the saved
// copy can only tell "operator cleared" from "retention expired" through this counter.
{
  const s = new SampleStore();
  assert.equal(s.generation, 0, 'a new store starts at generation 0');
  s.append(1, 1, 'VOLTAGE', 'V', 1);
  s.clear();
  assert.equal(s.generation, 1, 'clear() advances the generation');
  s.append(2, 1, 'VOLTAGE', 'V', 1);
  assert.equal(s.trim(Infinity), true, 'the trim emptied the store');
  assert.equal(s.count, 0, 'store is empty after the trim');
  assert.equal(s.generation, 1, 'a trim that empties the store does NOT advance it');
  checks += 5;
}

// --- segments: independent copies; load() rebuilds the store row for row ------------
const allRows = (s: SampleStore) => Array.from({ length: s.count }, (_, i) => s.at(i));
const segmentsOf = (s: SampleStore, size: number) => {
  const out = [];
  for (let i = 0; i < s.count; i += size) out.push(s.segment(i, Math.min(size, s.count - i)));
  return out;
};
const loadableOf = (s: SampleStore, size = 256) => ({
  firstSeq: s.firstSeq,
  modes: [...MODES],
  units: s.unitDictionary,
  segments: segmentsOf(s, size),
  notes: [...allRows(s)].filter((r) => r.note !== '').map((r) => [r.seq, r.note] as [number, string]),
});
const sameStore = (a: SampleStore, b: SampleStore, where: string) => {
  checks += 2 + a.count * 7;
  assert.equal(a.count, b.count, `${where}: count`);
  assert.equal(a.firstSeq, b.firstSeq, `${where}: firstSeq`);
  for (let i = 0; i < a.count; i++) sameSample(a.at(i), b.at(i), `${where} row ${i}`);
};

// A session across three chunks and a partial tail, with a unit added mid-session (index
// past the built-ins) and notes on rows either side of a chunk boundary.
const sessionStore = (rows: number, startOffset = 0) => {
  const s = new SampleStore();
  if (startOffset > 0) {
    for (let i = 0; i < startOffset; i++) s.append(i, i, 'VOLTAGE', 'V', 1);
    s.clear();
  }
  for (let i = 0; i < rows; i++) {
    const unit = i < 5000 ? UNITS[1 + (i % (UNITS.length - 1))] : 'GF';
    s.append(2_000_000 + i * 330, i * 1e-3 + 0.5, MODES[i % MODES.length], unit, i % 7);
  }
  s.setNote(s.firstSeq + 3, 'first');
  s.setNote(s.firstSeq + CHUNK - 1, 'edge a');
  s.setNote(s.firstSeq + CHUNK, 'edge b');
  s.setNote(s.firstSeq + rows - 1, 'last');
  return s;
};

{
  const N = CHUNK * 2 + 700;
  const src = sessionStore(N);

  // Not views: structured clone serializes a view's WHOLE backing buffer, so a subarray of
  // a 304 KB chunk would persist 304 KB per 256-sample segment.
  const seg = src.segment(0, 256);
  assert.equal(seg.ts.buffer.byteLength, 256 * 8, 'a segment owns exactly its own bytes');
  assert.equal(seg.mode.buffer.byteLength, 256, 'u8 columns too');
  const before = src.at(10).value;
  seg.value[10] = -1;
  assert.equal(src.at(10).value, before, 'writing a segment does not touch the store');

  // A read that straddles a chunk boundary (the 256 grid never does, but a copy that stops
  // at the edge would persist zeros).
  const straddle = src.segment(CHUNK - 100, 256);
  for (let k = 0; k < 256; k++) {
    assert.equal(straddle.ts[k], src.tsAt(CHUNK - 100 + k), `straddle ts ${k}`);
    assert.equal(straddle.value[k], src.valueAt(CHUNK - 100 + k), `straddle value ${k}`);
  }
  assert.equal(straddle.seq, src.firstSeq + CHUNK - 100, 'a segment is keyed by absolute seq');
  checks += 5 + 512;

  // Loaded store == original, row for row, notes included; into an EMPTY store and into a
  // store that already holds a different session (the live one a restore replaces).
  for (const size of [256, 1000, N]) {
    const dst = new SampleStore();
    dst.load(loadableOf(src, size));
    sameStore(dst, src, `load(${size}) into empty`);
  }
  const live = sessionStore(50);
  const gen = live.generation;
  assert.equal(live.load(loadableOf(src)), false, 'this build\'s own dictionaries: nothing remapped');
  sameStore(live, src, 'load into a populated store');
  assert.equal(live.generation, gen, 'load() leaves generation to the caller');
  assert.deepEqual(live.unitDictionary, src.unitDictionary, 'dictionary is the loaded one, not merged');
  // The loaded store is live: appending continues the seq line, and the rows are independent.
  const nextSeq = live.append(9e9, 1, 'VOLTAGE', 'V', 1);
  assert.equal(nextSeq, src.firstSeq + N, 'appending after a load continues the seq line');
  assert.equal(src.count, N, 'the source store is unaffected');
  checks += 3;
}

// Saved by a build whose unit dictionary had two entries swapped and whose mode list ran in
// reverse: the bytes are rewritten by NAME, the rows keep their mode and unit, and load() says
// so (the persister must then rewrite storage whole).
{
  const dict = new SampleStore().unitDictionary;
  const old = [dict[1], dict[0], ...dict.slice(2)];
  const oldModes = [...MODES].reverse();
  const seg = { seq: 0, n: 2, ts: new Float64Array([1, 2]), value: new Float64Array([1, 2]),
    mode: new Uint8Array([0, oldModes.length - 1]), unit: new Uint8Array([0, 1]), decimals: new Uint8Array([3, 3]) };
  const dst = new SampleStore();
  assert.equal(dst.load({ firstSeq: 0, modes: oldModes, units: old, segments: [seg], notes: [] }), true, 'a reordered dictionary is remapped');
  assert.deepEqual([dst.unitAt(0), dst.unitAt(1)], [dict[1], dict[0]], 'each row keeps the unit it was saved with');
  assert.deepEqual([dst.at(0).mode, dst.at(1).mode], [oldModes[0], oldModes[oldModes.length - 1]], 'and the mode');
  checks += 3;
}

// firstSeq unaligned after a clear(), as a second session in the same page
{
  const src = sessionStore(CHUNK + 300, 12_345);
  assert.equal(src.firstSeq, 12_345, 'precondition: firstSeq is not chunk-aligned');
  const dst = new SampleStore();
  dst.load(loadableOf(src));
  sameStore(dst, src, 'load with unaligned firstSeq');
}

// A rejected load changes nothing: the live session survives a bad restore
{
  const src = sessionStore(2000);
  const good = loadableOf(src);
  const live = sessionStore(40);
  const frozen = allRows(live);

  const gap = { ...good, segments: good.segments.filter((_, i) => i !== 3) };
  assert.throws(() => live.load(gap), /does not follow/, 'a missing middle segment is rejected');
  const badMode = { ...good, modes: ['VOLTAGE', 'BOGUS'] };
  assert.throws(() => live.load(badMode), /unknown mode/, 'an unknown mode is rejected');
  const badLen = { ...good, segments: [{ ...good.segments[0], n: 999 }, ...good.segments.slice(1)] };
  assert.throws(() => live.load(badLen), /inconsistent lengths/, 'a segment whose arrays disagree with n');
  const badStart = { ...good, firstSeq: good.firstSeq + 1 };
  assert.throws(() => live.load(badStart), /does not follow/, 'segments that do not start at firstSeq');

  assert.equal(live.count, 40, 'live count unchanged after rejected loads');
  frozen.forEach((row, i) => sameSample(live.at(i), row, `live row ${i} after rejected loads`));
  checks += 4 + 1 + 40;
}

console.log(`check-samples: ${checks} assertions passed`);
