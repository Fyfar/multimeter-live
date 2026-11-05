// Self-check for lib/capture.ts. Run by `npm run check` (see docs/quality.md).
//
// Characterization: these assert what the engine does TODAY, including the accepted
// limitations in docs/limitations.md. A wrong capture rule records the wrong rows and the
// screen still looks fine, so this is the only place a regression in what gets recorded shows.

import assert from 'node:assert/strict';
import { CaptureEngine, displayScale, type CaptureSettings, type EngineView } from '../lib/capture.ts';
import { SampleStore, CHUNK, MODES, RETENTION_MS } from '../lib/samples.ts';
import { isSupportedMode, livePassFail, parseEntry, resolveBand } from '../lib/passfail.ts';
import type { Mode, Reading } from '../lib/parser.ts';

let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); checks++; };

let clock = Date.now() - 60_000;
const rd = (mode: Mode, display: string, unit: string, ts = clock++): Reading => {
  const ol = display === 'OL';
  return { mode, value: ol ? null : Number.parseFloat(display), display, unit, isOverload: ol, isMeasuring: false, ts };
};
const R = (d: string) => rd('RESISTANCE', d, 'KOM'); // "10.000" -> 10 000 Ω, LSD 1 Ω
const OL = () => rd('RESISTANCE', 'OL', 'KOM');
const times = <T,>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

const BASE: CaptureSettings = {
  stabilityCount: 2, hysteresisPct: 10, stableOnly: false, preserveOnModeChange: false, capNoPartFloor: 0.005,
};
const fresh = (s: Partial<CaptureSettings> = {}) => {
  const store = new SampleStore();
  const e = new CaptureEngine(store);
  e.configure({ ...BASE, ...s });
  e.setPassFailActive(true);
  return { store, e };
};
// The state a batch leaves, as the page reads it.
const view = (e: CaptureEngine, rs: Reading[]) => { e.ingest(rs); return e.view; };
const passFail = (e: CaptureEngine, ref: number, pct: number) =>
  e.setPassFailConfig(ref, pct, resolveBand(ref, pct, 'percent'), 'percent');
// A 10 kΩ part already on the probes when Pass/Fail is set to 10 kΩ ±5%; the next R('10.000') captures.
const tenKOnView = () => {
  const { e } = fresh();
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
  return e;
};

// --- first detection is not a mode change ---------------------------------------------
{
  const { e } = fresh();
  e.setTriggerArmed(true); e.setTriggerThreshold(5);
  const r = e.ingest([rd('VOLTAGE', '10.00', 'V')]);
  eq([r.unit, r.reset, r.modeReset], ['V', true, false], 'first reading: flush, no mode reset');
  eq(e.recording, true, 'a pre-typed threshold survives first detection and fires');
}

// --- stable run: band around the anchor, not pairwise ---------------------------------
{
  const { e } = fresh();
  eq(view(e, [R('10.000')]).currentStable, false, 'one reading is not a run');
  eq(view(e, [R('10.015')]).currentStable, true, '15 LSD from the anchor joins the run');
  eq(view(e, [R('10.030')]).currentStable, false, '30 LSD from the ANCHOR restarts, though 15 from the previous');
}

// --- Data Log: recording gate, stats and counts behind the same gate -----------------
{
  const { store, e } = fresh();
  e.ingest([R('10.000')]);
  const idle = e.ingest(times(3, () => R('10.000')));
  eq([store.count, idle.touched, e.view.stats], [0, false, null], 'nothing recorded while idle');
  e.setRecording(true, true);
  const v = view(e, [R('10.000'), R('10.002'), OL()]);
  eq(store.count, 2, 'OL is never stored');
  eq([v.stats?.count, v.stats?.min, v.stats?.max, v.stats?.mean], [2, 10_000, 10_002, 10_001], 'Welford stats');
  eq([v.recordedResolution, v.dominantValue], [1, 10_000], 'resolution + dominant from logged readings');
  eq(view(e, [OL()]).stats === v.stats, true, 'a batch that appends nothing keeps the same stats object');
}

// --- stable-only: first settled value, then only a >= 50% change ---------------------
{
  const { store, e } = fresh({ stableOnly: true });
  e.setRecording(true, true);
  e.ingest(times(5, () => R('10.000')));
  eq(store.count, 1, 'a held part logs once');
  const held = e.view;
  e.ingest([R('10.010'), R('10.010')]);
  eq(store.count, 1, 'drift is not logged');
  eq([e.view === held, e.view.stats === held.stats], [true, true],
    'a filtered-out batch leaves the view, stats included, the same object');
  e.ingest([OL(), R('10.000'), R('10.000')]);
  eq(store.count, 2, 'OL re-arms the latch: the same value logs again');
  e.ingest([R('14.000'), R('14.000')]);
  eq(store.count, 2, 'accepted: a second part within 50% and no probe lift is not logged');
  const v = view(e, [R('16.000'), R('16.000')]);
  eq([store.count, v.stats?.count, [...e.counts.values()].reduce((a, b) => a + b)], [3, 3, 3],
    'store, stats and histogram counts agree under the filter');
}

{
  const { store, e } = fresh({ stableOnly: true });
  e.ingest([R('10.000'), R('10.000'), R('10.000')]);
  e.setRecording(true);
  e.ingest([R('10.000')]);
  eq(store.count, 0, 'starting a session does not inherit a run settled while idle');
  e.ingest([R('10.000')]);
  eq(store.count, 1, 'it logs once its own run settles');
}

// --- Pass/Fail capture ----------------------------------------------------------------
{
  const e = tenKOnView();
  const first = e.ingest([R('10.000')]);
  eq([first.rowsChanged, first.verdicts.map((v) => v.verdict)], [true, ['PASS']], 'captured once stable');
  eq(e.ingest(times(4, () => R('10.001'))).verdicts.length, 0, 'a held part is not captured twice');
  e.ingest([OL(), R('50.000'), R('30.000'), R('10.000'), R('10.000')]);
  eq(e.passFailRows.map((v) => v.verdict), ['PASS', 'PASS'], 'a probe sweeping through intermediates is not captured');
  e.ingest([OL(), R('12.000'), R('12.000')]);
  eq(e.passFailRows.map((v) => v.verdict), ['PASS', 'PASS', 'FAIL'], 'a probe lift re-arms; out of band is FAIL');
  e.ingest([R('10.000'), R('10.000')]);
  eq(e.passFailRows.length, 3, 'accepted: a re-seat within 50% without a lift is not re-captured');
  e.ingest([rd('RESISTANCE', '0.000', 'OM'), R('12.000'), R('12.000')]);
  eq(e.passFailRows.length, 4, 'an exact zero re-arms and records nothing itself');
  e.clearVerdicts();
  const held = e.ingest([R('12.000'), R('12.000')]);
  eq([e.passFailRows.length, held.rowsChanged], [0, false], 'Clear Batch does not re-capture a held part');
  e.ingest([rd('RESISTANCE', '5', ''), rd('RESISTANCE', '5', '')]);
  eq(e.passFailRows.length, 0, 'an unrecognized unit is never judged against the reference');
}
{
  const { store, e } = fresh();
  const C = (d: string) => rd('CAPACITANCE', d, 'nF');
  e.ingest([C('100.0')]);
  e.setPassFailConfig(100e-9, 10, resolveBand(100e-9, 10, 'percent'), 'percent');
  e.setRecording(true, true);
  e.ingest([C('100.0'), C('100.0'), C('0.004'), C('100.0'), C('100.0')]);
  eq(e.passFailRows.length, 2, 'below the capacitance floor is a probe lift');
  eq(store.count, 4, 'and is never stored');
}
{
  const { e } = fresh();
  e.ingest([rd('VOLTAGE', '1.000', 'V')]);
  e.setPassFailConfig(1, 5, resolveBand(1, 5, 'percent'), 'percent');
  e.ingest(times(3, () => rd('VOLTAGE', '1.000', 'V')));
  eq(e.passFailRows.length, 0, 'unsupported mode captures nothing');
}

// --- parity: the live panel judges exactly what the engine captures ---------------------
// The view and the engine share one rule; this is what fails if either grows its own copy.
{
  const { e } = fresh();
  const entry = { RESISTANCE: ['4k7', '1'], CAPACITANCE: ['100n', '10'] } as const;
  type M = keyof typeof entry;
  const configure = (m: M) => {
    const { ref, tol, band } = parseEntry(entry[m][0], entry[m][1], 'percent');
    e.setPassFailConfig(ref, tol, band, 'percent');
  };
  const C = (d: string) => rd('CAPACITANCE', d, 'nF');
  const noPart = new Set<Reading>();
  const none = (r: Reading) => { noPart.add(r); return r; };
  const seq = [
    R('4.700'), R('4.700'), OL(), R('4.800'), R('4.800'), OL(), R('4.747'), R('4.747'),
    none(rd('RESISTANCE', '0.000', 'KOM')), R('4.652'), R('4.652'),
    C('100.0'), C('100.0'), none(C('0.002')), C('108.0'), C('108.0'), none(C('0.002')), C('120.0'), C('120.0'),
  ];
  configure('RESISTANCE');
  e.ingest([R('4.700')]);
  const captured: string[] = [];
  for (const r of seq) {
    const res = e.ingest([r]);
    if (res.modeReset) configure(r.mode as M);
    const [ref, tol] = entry[r.mode as M];
    const lv = livePassFail({
      reading: r, stable: true, mode: isSupportedMode(r.mode) ? r.mode : null,
      capNoPartFloor: BASE.capNoPartFloor, referenceSettled: ref, toleranceSettled: tol, toleranceMode: 'percent',
    });
    for (const v of res.verdicts) {
      captured.push(v.verdict);
      eq([lv.verdict, lv.deviation], [v.verdict, v.deviation], `live verdict == captured row at ${r.display} ${r.unit}`);
    }
    if (noPart.has(r)) eq([res.verdicts.length, lv.status], [0, 'no-part'], `${r.display} ${r.unit}: no row, and "no part" live`);
  }
  eq(captured, ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS', 'PASS', 'FAIL'], 'parity sequence captured the expected rows');
}

// --- Pass/Fail works only on its own view -------------------------------------------
{
  const e = tenKOnView();
  e.ingest([R('10.000')]);
  eq(e.passFailRows.length, 1, 'captured on the view');
  e.setPassFailActive(false);
  const away = e.ingest([OL(), R('12.000'), R('12.000'), OL(), R('10.000'), R('10.000')]);
  eq([away.verdicts.length, away.rowsChanged, e.passFailRows.length], [0, false, 1],
    'off the view: no verdict, no tone, stored rows untouched');
  eq(e.view.currentStable, true, 'stability is still tracked off the view');
  e.setPassFailActive(true);
  e.ingest([R('10.000')]);
  eq(e.passFailRows.length, 2, 'back on the view: a part swapped in while away is captured');
  e.ingest([R('10.000'), R('10.000')]);
  eq(e.passFailRows.length, 2, 'and only once');
}
{
  const e = tenKOnView();
  e.ingest([R('10.000')]);
  e.setPassFailActive(false);
  e.ingest([R('10.000'), R('10.000')]);
  e.setPassFailActive(true);
  e.ingest([R('10.000'), R('10.000')]);
  eq(e.passFailRows.length, 1, 'a part captured before leaving, still held, is not captured again');
}

// --- trigger --------------------------------------------------------------------------
{
  const { store, e } = fresh();
  e.ingest([R('1.000')]);
  e.setRecording(true, true);
  e.ingest([R('1.000'), R('1.000')]);
  e.setRecording(false);
  e.setTriggerArmed(true); e.setTriggerThreshold(5_000);
  const r = e.ingest([R('1.000'), R('6.000'), R('6.000'), R('4.000'), R('6.000')]);
  eq([r.recordingChanged, e.recording], [true, true], 'crossing starts a trigger-owned session');
  eq(store.count, 1, 'a re-trigger mid-batch flushes everything staged; the crossing sample is kept');
  eq(r.reset, true, 'the trigger edge resets the projections');
  e.ingest([R('4.600')]);
  eq(e.recording, true, 'above the release level keeps recording');
  e.ingest([R('4.400')]);
  eq(e.recording, false, 'below threshold x (1 - hysteresis) stops it');
  e.setTriggerArmed(false); e.setTriggerThreshold(5_000);
  e.setRecording(true, true);
  e.ingest([R('1.000')]);
  eq(e.recording, true, 'a manual session is never auto-stopped');
}

// --- mode change -------------------------------------------------------------------------
{
  const { store, e } = fresh();
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
  e.setTriggerArmed(true); e.setTriggerThreshold(50_000);
  e.setRecording(true, true);
  e.ingest([R('10.000'), R('10.000')]);
  const r = e.ingest([R('10.000'), rd('VOLTAGE', '99.00', 'V'), rd('VOLTAGE', '99.00', 'V')]);
  eq([r.unit, r.modeReset, r.reset, r.recordingChanged, r.rowsChanged], ['V', true, true, true, true], 'flags');
  eq([store.count, e.recording, e.passFailRows.length], [0, false, 0], 'flushed, stopped, verdicts cleared');
  eq(e.view.stats, null, 'nothing appended after the reset');
}
{
  const { store, e } = fresh({ preserveOnModeChange: true });
  e.ingest([R('10.000')]);
  e.setRecording(true, true);
  const v0 = view(e, [R('10.000'), R('10.000')]);
  const v1 = view(e, [R('10.000'), rd('VOLTAGE', '1.000', 'V')]);
  eq(store.count, 3, 'old-unit rows, including the one staged this batch, are kept');
  eq(v1.stats, null, 'rows flushed before the reset do not commit the zeroed stats');
  eq([e.chartFromSeq, v1.sessionStart], [store.firstSeq + 3, null], 'watermark past them; no anchor yet');
  eq(v0.sessionStart !== null, true, 'the first session had an anchor');
  eq([v1.chartEpoch > v0.chartEpoch, v1.chartFromSeq], [true, store.firstSeq + 3], 'the reset bumps the epoch');
  e.setRecording(true, true);
  const v = rd('VOLTAGE', '1.000', 'V');
  const v2 = view(e, [v, rd('VOLTAGE', '1.000', 'V')]);
  eq([store.count, v2.sessionStart, v2.unit], [5, v.ts, 'V'], 'the anchor is the first NEW-unit sample');
}

// --- display scale: recorded values while the chart has samples, else the live reading ---
{
  const scale = (store: SampleStore, e: CaptureEngine, live: Reading | null) => {
    const s = displayScale(store, e.view, live);
    return [s.binWidth, s.centerValue];
  };
  const { store, e } = fresh({ preserveOnModeChange: true });
  e.ingest([R('10.000')]);
  eq(scale(store, e, R('9.50')), [10, 9_500], 'empty: the live reading\'s LSD and value');
  eq([scale(store, e, OL()), scale(store, e, null)], [[undefined, undefined], [undefined, undefined]], 'empty, live OL or none: nothing');
  e.setRecording(true, true);
  e.ingest([R('10.000'), R('10.000')]);
  eq(scale(store, e, OL()), [1, 10_000], 'recorded: frozen resolution and dominant value, live OL ignored');
  const volts = rd('VOLTAGE', '1.000', 'V');
  e.ingest([volts]);
  eq([store.count > 0, e.view.recordedResolution], [true, null], 'preserve-log change: old rows kept, resolution nulled');
  eq(scale(store, e, volts), [0.001, 1], 'past the watermark nothing is visible: the live reading, not the old rows');
}

// --- Pass/Fail rows follow "Keep log on mode change" -----------------------------------
{
  const { e } = fresh({ preserveOnModeChange: true });
  const D = (d: string) => rd('DIODE', d, 'V');
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
  e.ingest([R('10.000')]);
  const r = e.ingest([R('10.000'), D('0.650'), D('0.650')]);
  eq([r.modeReset, r.rowsChanged, e.passFailRows.length], [true, false, 1], 'keep on: stored verdicts survive');
  eq(r.verdicts.length, 0, 'the old reference is still cleared: nothing judged in the new unit');
  passFail(e, 0.65, 5);
  e.ingest([D('0.650')]);
  eq(e.passFailRows.map((v) => v.mode), ['RESISTANCE', 'DIODE'], 'new-mode rows append after the kept ones');
  eq(new Set(e.passFailRows.map((v) => v.id)).size, 2, 'row ids stay unique across the change');
}

// --- retention -------------------------------------------------------------------------
{
  const { store, e } = fresh();
  const old = Date.now() - RETENTION_MS - 600_000;
  e.ingest([rd('RESISTANCE', '1.000', 'KOM', old)]);
  e.setRecording(true, true);
  const r = e.ingest(Array.from({ length: CHUNK + 1 }, (_, i) => rd('RESISTANCE', '1.000', 'KOM', old + i)));
  eq([r.trimmed, store.count], [false, CHUNK + 1], 'old samples alone stay: the window ends at the newest sample');
  const before = e.view;
  eq(before.sessionStart, old, 'precondition: the session started at the oldest sample');
  const r2 = e.ingest([R('1.000')]);
  eq([r2.trimmed, r2.touched, store.count], [true, true, 2], 'a sample past the window drops the old chunk');
  eq([e.view.chartEpoch > before.chartEpoch, e.view.version > before.version], [true, true], 'a trim bumps epoch and version');
  eq(e.view.sessionStart, old, 'a trim does not move the session start');
  e.setRecording(false);
  eq(e.ingest([R('1.000')]).trimmed, false, 'readings while not recording add nothing, so trim nothing');
  eq(e.ingest([R('1.000')]).trimmed, false, 'recent samples are not');
  const kept = e.view;
  e.flush();
  eq([e.view.sessionStart, e.view.stats, e.view.chartEpoch > kept.chartEpoch, e.view.version > kept.version],
    [null, null, true, true], 'a flush clears the session start and stats, bumps epoch and version');
}

// --- restore: derived state is recomputed from the rows and must equal the live-built state -----
// The persisted copy holds samples only; stats, histogram counts, recorded resolution and the
// dominant value are replayed through the same accumulator `ingest` uses. "Close enough" is not
// the bar: the Statistics panel and the Data Log must agree after a restore.
const session = (v: EngineView) =>
  [v.chartFromSeq, v.unit, v.sessionStart, v.stats, v.recordedResolution, v.dominantValue, v.passFailRows];
const moveTo = (
  src: { store: SampleStore; e: CaptureEngine },
  settings: Partial<CaptureSettings> = {},
  into = fresh(settings),
) => {
  const { store, e } = into;
  store.load({
    firstSeq: src.store.firstSeq,
    modes: MODES,
    units: src.store.unitDictionary,
    segments: src.store.count > 0 ? [src.store.segment(0, src.store.count)] : [],
    notes: [],
  });
  e.restore({ ...src.e.context, mode: src.e.context.mode!, verdicts: src.e.passFailRows });
  return { store, e };
};
const C = (d: string, unit = 'nF') => rd('CAPACITANCE', d, unit);
const sessions: [string, Partial<CaptureSettings>, (t: CaptureEngine) => void][] = [
  ['mixed LSDs and units', {}, (t) => {
    t.ingest([R('10.000')]);
    t.ingest([R('10.000'), R('10.002'), R('9.998'), rd('RESISTANCE', '10001', 'OM'), rd('RESISTANCE', '0.0100', 'MOM'), R('10.000')]);
  }],
  ['stable-only', { stableOnly: true }, (t) => {
    t.ingest([R('10.000')]);
    t.ingest(times(5, () => R('10.000')));
    t.ingest([OL(), R('10.000'), R('10.000'), R('30.000'), R('30.000'), R('31.000')]);
  }],
  ['after a preserve-log mode change', { preserveOnModeChange: true }, (t) => {
    t.ingest([R('10.000')]);
    t.ingest([R('10.000'), R('10.001')]);
    t.ingest([rd('VOLTAGE', '1.500', 'V'), rd('VOLTAGE', '1.502', 'V'), rd('VOLTAGE', '1500', 'mV')]);
  }],
  ['capacitance (nF base) across units', {}, (t) => {
    t.ingest([C('100.0')]);
    t.ingest([C('100.0'), C('100.1'), C('1.200', 'uF'), C('3.30', 'mF'), C('820.0', 'pF'), C('100.0')]);
  }],
];
for (const [name, settings, play] of sessions) {
  const live = fresh(settings);
  live.e.setRecording(true, true);
  play(live.e);
  const back = moveTo(live, settings);
  const [a, b] = [back.e.view, live.e.view];
  eq(a.stats, b.stats, `${name}: statistics rebuilt exactly (mean, m2, min, max)`);
  eq(back.e.counts, live.e.counts, `${name}: histogram counts rebuilt exactly`);
  eq([a.recordedResolution, a.dominantValue], [b.recordedResolution, b.dominantValue], `${name}: resolution and dominant value`);
  eq(back.e.chartFromSeq, live.e.chartFromSeq, `${name}: watermark`);
  eq(back.e.recording, false, `${name}: recording stays off even though the live session was recording`);
  // Not compared: version/chartEpoch (this engine's counters), recording (asserted above),
  // currentStable (the target engine's, until the next batch).
  eq(session(a), session(b), `${name}: the restored view equals the live-built one`);
  eq([a.version > 0, a.chartEpoch > 0], [true, true], `${name}: restore bumps version and epoch`);
  eq(a.passFailRows === back.e.passFailRows, true, `${name}: the view holds the engine's verdict array itself`);
}

// a resistance session with `n` recorded rows
const recorded = (n: number) => {
  const live = fresh();
  live.e.ingest([R('10.000')]);
  live.e.setRecording(true, true);
  live.e.ingest(times(n, () => R('10.000')));
  return live;
};

// the next reading after a restore, in the same mode, is just a reading
{
  const { store, e } = moveTo(recorded(4));
  const r = e.ingest([R('10.000')]);
  eq([r.reset, r.modeReset, store.count], [false, false, 4], 'same-mode reading after a restore does not flush');
  e.setRecording(true, true);
  e.ingest([R('10.000')]);
  eq(store.count, 5, 'recording after a restore appends to the restored rows');
  e.ingest([rd('VOLTAGE', '1.500', 'V')]);
  eq(store.count, 0, 'a same-mode first reading spends the guard: a later mode change follows the setting');
}

// the first mode change after a restore keeps the log even with keep-log off; the second does not
{
  const live = fresh();
  live.e.ingest([R('10.000')]);
  passFail(live.e, 10_000, 5);
  live.e.setRecording(true, true);
  live.e.ingest([R('10.000'), R('10.000'), R('10.000')]);
  eq(live.e.passFailRows.length, 1, 'precondition: a verdict row exists');
  const { store, e } = moveTo(live);
  const r = e.ingest([rd('VOLTAGE', '1.500', 'V')]);
  eq([r.modeReset, r.reset, store.count, e.passFailRows.length], [true, true, 3, 1],
    'restored log and verdicts survive the first mode change');
  eq(e.chartFromSeq, store.firstSeq + 3, 'the chart restarts past the restored rows');
  e.ingest([rd('RESISTANCE', '10.000', 'KOM')]);
  eq([store.count, e.passFailRows.length], [0, 0], 'the second mode change follows the setting');
}

// guard spent by a Clear: a later change is an ordinary one
{
  const { store, e } = moveTo(recorded(2));
  e.flush();
  e.ingest([rd('VOLTAGE', '1.500', 'V')]);
  eq(store.count, 0, 'a Clear after a restore spends the guard');
}

// recording into a restored session past the window ends it first; a recent one continues
{
  const aged = (days: number) => {
    const live = fresh();
    const t0 = Date.now() - days * 86_400_000;
    live.e.setRecording(true, true);
    live.e.ingest(Array.from({ length: 5 }, (_, i) => rd('RESISTANCE', '10.000', 'KOM', t0 + i)));
    return moveTo(live);
  };
  const old = aged(10);
  const gen = old.store.generation;
  eq([old.e.setRecording(true, true), old.store.count, old.store.generation > gen], [true, 0, true],
    'a 10-day-old session: Record starts a new, empty session');
  old.e.ingest([R('10.000')]);
  eq(old.store.count, 1, 'and records into it');
  const recent = aged(2);
  eq([recent.e.setRecording(true, true), recent.store.count], [false, 5], 'a 2-day-old session continues');
  eq(recent.e.setRecording(false), false, 'stopping never flushes');
}

// a restore disarms this engine's trigger and Pass/Fail reference itself: readings held during
// the restore are replayed before the page's effects could clear them
{
  const target = fresh();
  target.e.ingest([R('10.000')]);
  target.e.setTriggerArmed(true); target.e.setTriggerThreshold(5_000);
  passFail(target.e, 10_000, 5);
  const { store, e } = moveTo(recorded(3), {}, target);
  const r = e.ingest([R('20.000'), R('20.000'), R('20.000')]);
  eq([r.reset, r.recordingChanged, store.count], [false, false, 3], 'an armed trigger does not fire on the restored session');
  eq(e.passFailRows.length, 0, 'no verdict is captured against the pre-restore reference');
}

// restored verdict ids never collide with the next captured row
{
  const live = fresh();
  live.e.ingest([R('10.000')]);
  passFail(live.e, 10_000, 5);
  live.e.ingest([R('10.000')]);
  live.e.ingest([OL(), R('12.000'), R('12.000')]);
  eq(live.e.passFailRows.map((v) => v.id), [0, 1], 'precondition: two verdict rows');
  const { e } = moveTo(live);
  passFail(e, 10_000, 5);
  e.ingest([OL(), R('10.000'), R('10.000')]);
  eq(e.passFailRows.map((v) => v.id), [0, 1, 2], 'the next captured verdict has a fresh id');
}

// a restore leaves the shown reading's stable flag alone until the next batch, as the page did
{
  const into = fresh();
  into.e.ingest([R('10.000'), R('10.000')]);
  moveTo(recorded(2), {}, into);
  eq(into.e.view.currentStable, true, 'restore keeps currentStable until the next batch');
}

// a note edit bumps the version and nothing else
{
  const { store, e } = recorded(2);
  const v = e.view;
  e.setNote(store.firstSeq, 'probe A');
  eq([e.view.version > v.version, e.view.chartEpoch, e.view.stats === v.stats, store.notes], [true, v.chartEpoch, true, [[store.firstSeq, 'probe A']]],
    'setNote stores the note and bumps only the version');
}

console.log(`check-capture: ${checks} assertions passed`);
