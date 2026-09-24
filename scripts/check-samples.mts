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
  type Snapshot,
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

// --- snapshot round-trip ---------------------------------------------------------
{
  const store = new SampleStore();
  const N = CHUNK + 777;
  for (let i = 0; i < N; i++) {
    store.append(1000 + i * 330, i * 1e-4, MODES[i % MODES.length], UNITS[1 + (i % 5)], i % 5);
  }
  store.trim(1000 + 100 * 330); // exercise a non-zero firstSeq
  store.setNote(store.firstSeq + 3, 'annotated');

  const back = SampleStore.from(store.snapshot());
  assert.equal(back.count, store.count, 'round-trip: count');
  assert.equal(back.firstSeq, store.firstSeq, 'round-trip: firstSeq');
  for (let i = 0; i < store.count; i++) sameSample(back.at(i), store.at(i), `round-trip at(${i})`);
  assert.equal(back.at(3).note, 'annotated', 'round-trip: notes');
  checks += 3;
}

// --- the chart's x-axis anchor across a preserve-log mode change --------------------
// `app/page.tsx` derives the anchor as `tsAt(watermark - firstSeq)` — the oldest sample the
// chart can see. The regression this pins: tracking a candidate DURING the batch instead
// captured it against the pre-advance watermark, so a preserve-log mode change anchored the
// axis to an old-unit sample and `setSessionStart(prev => prev ?? at)` then made it stick
// for the rest of the session.
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

// --- snapshot independence: a restored store must NOT share memory ----------------
// The defect this guards: `snapshot()` handing out the live backing stores makes
// `from(store.snapshot())` alias `store`. Both then write slot N of the SAME chunk, each
// silently overwriting the other, and `from`'s dictionary remap rewrites the original store
// in place. Two "independent" stores corrupting each other is invisible until someone reads
// the data back, which for a restore feature is months later.
{
  const store = new SampleStore();
  for (let i = 0; i < 5; i++) store.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  const back = SampleStore.from(store.snapshot());

  // Each store appends its own 6th sample into what would be the same slot.
  back.append(9999, 777, 'CURRENT', 'A', 3);
  store.append(5000, 42, 'RESISTANCE', 'OM', 1);

  assert.equal(back.at(5).value, 777, 'the restored store kept ITS OWN sample');
  assert.equal(back.at(5).mode, 'CURRENT', 'and its own mode');
  assert.equal(store.at(5).value, 42, 'the source store kept its own sample');
  assert.equal(store.at(5).mode, 'RESISTANCE', 'and its own mode');

  // Mutating one store's existing data must not reach the other.
  back.setNote(back.firstSeq, 'restored only');
  assert.equal(store.noteOf(store.firstSeq), '', 'notes are not shared either');
  checks += 5;
}

// --- one snapshot, restored twice, gives two independent stores --------------------
// The aliasing bug one level removed: with `from()` adopting the snapshot's chunks instead
// of copying them, the SOURCE store is safe but the two restores silently overwrite each
// other. A retry after a failed restore, or two sessions opened from one saved file, is a
// natural way to hit it.
{
  const store = new SampleStore();
  for (let i = 0; i < 5; i++) store.append(1000 + i, i, 'VOLTAGE', 'V', 2);
  const snap = store.snapshot();

  const a = SampleStore.from(snap);
  const b = SampleStore.from(snap);
  a.append(9999, 111, 'CURRENT', 'A', 1);
  b.append(8888, 222, 'RESISTANCE', 'OM', 1);

  assert.equal(a.at(5).value, 111, 'restore A kept its own sample');
  assert.equal(a.at(5).mode, 'CURRENT', 'restore A kept its own mode');
  assert.equal(b.at(5).value, 222, 'restore B kept its own sample');
  assert.equal(store.count, 5, 'the source store is untouched by either restore');
  checks += 4;
}

// --- a snapshot naming a mode this build no longer has must FAIL LOUDLY -------------
// Units auto-extend and can never fail to resolve; MODES is fixed. A silent fallback to
// index 0 would relabel every affected sample as VOLTAGE — wrong data presented as right.
{
  const store = new SampleStore();
  store.append(1000, 1, 'DIODE', 'V', 2);
  const snap = store.snapshot();
  const renamed: Snapshot = {
    ...snap,
    modes: snap.modes.map((m) => (m === 'DIODE' ? 'DIODE_TEST' : m)),
  };
  assert.throws(
    () => SampleStore.from(renamed),
    /unknown mode/,
    'a vanished mode throws instead of silently becoming VOLTAGE',
  );
  checks++;
}

// --- snapshot round-trip through a REORDERED dictionary ---------------------------
// The reason a snapshot carries its dictionaries. Simulates a future edit to MODES/UNITS:
// the stored indices are stale, and `from` must remap them by NAME, not trust the numbers.
{
  const store = new SampleStore();
  const written: { mode: Mode; unit: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const mode = MODES[i % MODES.length];
    const unit = UNITS[1 + (i % 6)];
    store.append(1000 + i, i, mode, unit, 2);
    written.push({ mode, unit });
  }

  const snap = store.snapshot();
  // Reorder both dictionaries and renumber the stored indices to match, exactly as a
  // snapshot written by an older build with a different table order would look.
  const oldModes = [...snap.modes].reverse();
  const oldUnits = [...snap.units].reverse();
  const remap = (list: string[], old: string[]) =>
    list.map((name) => old.indexOf(name));
  const modeTo = remap([...snap.modes], oldModes);
  const unitTo = remap([...snap.units], oldUnits);
  for (let i = 0; i < snap.count; i++) {
    const chunk = snap.chunks[i >>> 14];
    const slot = i & (CHUNK - 1);
    chunk.mode[slot] = modeTo[chunk.mode[slot]];
    chunk.unit[slot] = unitTo[chunk.unit[slot]];
  }
  const reordered: Snapshot = { ...snap, modes: oldModes, units: oldUnits };

  const back = SampleStore.from(reordered);
  assert.equal(back.count, written.length, 'reordered round-trip: count');
  for (let i = 0; i < written.length; i++) {
    assert.equal(back.at(i).mode, written[i].mode, `reordered dictionary: mode at ${i}`);
    assert.equal(back.at(i).unit, written[i].unit, `reordered dictionary: unit at ${i}`);
  }
  checks += 3;
}

// --- retention, measured rather than re-typed -------------------------------------
// A literal compared against a copy of itself proves nothing (docs/quality.md). These
// assert what the memory arithmetic in design.md actually rests on.
{
  // Bytes per sample, MEASURED off a real chunk's backing stores — not the literal 19.
  // A sixth column, or f64 where the design says u8, changes this and must fail here.
  const probe = new SampleStore();
  probe.append(1, 1, 'VOLTAGE', 'V', 2);
  const c = probe.snapshot().chunks[0];
  const bytesPerSample =
    (c.ts.byteLength + c.value.byteLength + c.mode.byteLength +
     c.unit.byteLength + c.decimals.byteLength) / CHUNK;
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
  // ORDER of this list is part of the snapshot format.
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

console.log(`check-samples: ${checks} assertions passed`);
