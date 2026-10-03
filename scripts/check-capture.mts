// Self-check for lib/capture.ts. Run by `npm run check` (see docs/quality.md).
//
// Characterization: these assert what the engine does TODAY, including the accepted
// limitations in docs/limitations.md. A wrong capture rule records the wrong rows and the
// screen still looks fine, so this is the only place a regression in what gets recorded shows.

import assert from 'node:assert/strict';
import { CaptureEngine, type CaptureSettings } from '../lib/capture.ts';
import { SampleStore, CHUNK, RETENTION_MS } from '../lib/samples.ts';
import { resolveBand } from '../lib/passfail.ts';
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
const passFail = (e: CaptureEngine, ref: number, pct: number) =>
  e.setPassFailConfig(ref, pct, resolveBand(ref, pct, 'percent'), 'percent');

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
  eq(e.ingest([R('10.000')]).currentStable, false, 'one reading is not a run');
  eq(e.ingest([R('10.015')]).currentStable, true, '15 LSD from the anchor joins the run');
  eq(e.ingest([R('10.030')]).currentStable, false, '30 LSD from the ANCHOR restarts, though 15 from the previous');
}

// --- Data Log: recording gate, stats and counts behind the same gate -----------------
{
  const { store, e } = fresh();
  e.ingest([R('10.000')]);
  const idle = e.ingest(times(3, () => R('10.000')));
  eq([store.count, idle.touched, idle.stats], [0, false, null], 'nothing recorded while idle');
  e.setRecording(true, true);
  const r = e.ingest([R('10.000'), R('10.002'), OL()]);
  eq(store.count, 2, 'OL is never stored');
  eq([r.stats?.count, r.stats?.min, r.stats?.max, r.stats?.mean], [2, 10_000, 10_002, 10_001], 'Welford stats');
  eq([r.recordedResolution, r.dominantValue], [1, 10_000], 'resolution + dominant from logged readings');
  eq(e.ingest([OL()]).stats, null, 'a batch that appends nothing commits no stats');
}

// --- stable-only: first settled value, then only a >= 50% change ---------------------
{
  const { store, e } = fresh({ stableOnly: true });
  e.setRecording(true, true);
  e.ingest(times(5, () => R('10.000')));
  eq(store.count, 1, 'a held part logs once');
  e.ingest([R('10.010'), R('10.010')]);
  eq(store.count, 1, 'drift is not logged');
  e.ingest([OL(), R('10.000'), R('10.000')]);
  eq(store.count, 2, 'OL re-arms the latch: the same value logs again');
  e.ingest([R('14.000'), R('14.000')]);
  eq(store.count, 2, 'accepted: a second part within 50% and no probe lift is not logged');
  const r = e.ingest([R('16.000'), R('16.000')]);
  eq([store.count, r.stats?.count, [...e.counts.values()].reduce((a, b) => a + b)], [3, 3, 3],
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
  const { e } = fresh();
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
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

// --- Pass/Fail works only on its own view -------------------------------------------
{
  const { e } = fresh();
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
  e.ingest([R('10.000')]);
  eq(e.passFailRows.length, 1, 'captured on the view');
  e.setPassFailActive(false);
  const away = e.ingest([OL(), R('12.000'), R('12.000'), OL(), R('10.000'), R('10.000')]);
  eq([away.verdicts.length, away.rowsChanged, e.passFailRows.length], [0, false, 1],
    'off the view: no verdict, no tone, stored rows untouched');
  eq(away.currentStable, true, 'stability is still tracked off the view');
  e.setPassFailActive(true);
  e.ingest([R('10.000')]);
  eq(e.passFailRows.length, 2, 'back on the view: a part swapped in while away is captured');
  e.ingest([R('10.000'), R('10.000')]);
  eq(e.passFailRows.length, 2, 'and only once');
}
{
  const { e } = fresh();
  e.ingest([R('10.000')]);
  passFail(e, 10_000, 5);
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
  eq(r.stats, null, 'nothing appended after the reset');
  e.ingest([R('10.000'), R('10.000'), R('10.000')]);
  eq(e.passFailRows.length, 0, 'the old reference stays cleared on return to the same mode');
}
{
  const { store, e } = fresh({ preserveOnModeChange: true });
  e.ingest([R('10.000')]);
  e.setRecording(true, true);
  const s0 = e.ingest([R('10.000'), R('10.000')]).sessionStart;
  const r = e.ingest([R('10.000'), rd('VOLTAGE', '1.000', 'V')]);
  eq(store.count, 3, 'old-unit rows, including the one staged this batch, are kept');
  eq(r.stats, null, 'rows flushed before the reset do not commit the zeroed stats');
  eq([e.chartFromSeq, r.sessionStart], [store.firstSeq + 3, null], 'watermark past them; no anchor yet');
  eq(s0 !== null, true, 'the first session had an anchor');
  e.setRecording(true, true);
  const v = rd('VOLTAGE', '1.000', 'V');
  const r2 = e.ingest([v, rd('VOLTAGE', '1.000', 'V')]);
  eq([store.count, r2.sessionStart], [5, v.ts], 'the anchor is the first NEW-unit sample');
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
  const old = Date.now() - RETENTION_MS - 60_000;
  e.ingest([rd('RESISTANCE', '1.000', 'KOM', old)]);
  e.setRecording(true, true);
  const r = e.ingest(Array.from({ length: CHUNK + 1 }, (_, i) => rd('RESISTANCE', '1.000', 'KOM', old + i)));
  eq([r.trimmed, r.touched, store.count], [true, true, 0], 'samples past retention are trimmed');
  eq(e.ingest([R('1.000')]).trimmed, false, 'recent samples are not');
}

console.log(`check-capture: ${checks} assertions passed`);
