// The capture engine: what the read loop does with each batch of readings — stable-run
// detection, trigger edges, discontinuities, both capture latches, mode-change flushes, the
// staged append to the store. No React, no DOM: `scripts/check-capture.mts` drives it under
// Node, because a wrong capture rule records the wrong rows and nothing on screen says so.
//
// It never touches React state. `ingest` returns the batch's events and the page commits
// `view` once per batch — which is what keeps setState out of the per-sample loop by construction.

import {
  displayDecimals, lsdOf, normalizeReading, readingResolution, withinStableBand,
  type Mode, type Reading,
} from './parser.ts';
import { RETENTION_MS, type SampleStore } from './samples.ts';
import {
  canJudge, isCapacitanceStray, partUnderProbes, verdictFor,
  type ToleranceMode, type VerdictRow,
} from './passfail.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';
import { localIso } from './search.ts';

// Stable-only logging: once a settled value is logged, the next is logged only if it
// differs by >= this fraction — ignores ±1 LSD drift. NOTE: relative, so very sensitive
// near zero (0.0001 -> 0.0002 is +100%); add an absolute floor if that proves noisy.
const MAJOR_CHANGE_RATIO = 0.5;

// Shared by both capture sites. The `v !== last` clause only matters when last === 0,
// which is reachable on the Data Log path (a genuine logged 0) but not on the Pass/Fail
// one (zero is intercepted as "no part") — keep it, it is load-bearing for one caller.
const isMajorChange = (v: number, last: number | null): boolean =>
  last === null || (v !== last && Math.abs(v - last) >= MAJOR_CHANGE_RATIO * Math.abs(last));

export type SessionStats = { count: number; mean: number; m2: number; min: number; max: number };

export type CaptureSettings = Pick<
  Settings,
  'stabilityCount' | 'hysteresisPct' | 'stableOnly' | 'preserveOnModeChange' | 'capNoPartFloor'
>;

// What one batch did, as events. The state it left is `view`.
export interface BatchResult {
  // Base unit of the last mode/unit change in this batch, else null.
  unit: string | null;
  // A real (not first-detection) mode change: the trigger and Pass/Fail entry fields clear.
  modeReset: boolean;
  // The derived projections were reset; `chartFromSeq` holds the new watermark.
  reset: boolean;
  touched: boolean;
  trimmed: boolean;
  verdicts: VerdictRow[];
  rowsChanged: boolean;
  recordingChanged: boolean;
}

// Everything render reads from the engine. A new object only when a field changed, so the
// page can hand it to setState after every engine call and an unchanged one bails out.
export interface EngineView {
  // The store mutates in place; this is what tells render it moved (a staged or trimmed
  // sample, a flush, a restore, a note edit).
  readonly version: number;
  // Invalidates the chart's incremental tier: a derived reset, a trim, a restore.
  readonly chartEpoch: number;
  readonly chartFromSeq: number;
  // Base token ('OM'/'V'/'A'/'nF'), '' before the first reading.
  readonly unit: string;
  readonly recording: boolean;
  // The run as of the last batch's last reading, which is the reading the page shows.
  readonly currentStable: boolean;
  readonly sessionStart: number | null;
  // Same object until a sample is accumulated, so a batch that records nothing (the
  // stable filter, most of the time) does not re-render the statistics.
  readonly stats: SessionStats | null;
  readonly recordedResolution: number | null;
  readonly dominantValue: number | null;
  // The engine's own array: the persister detects verdict changes by its identity.
  readonly passFailRows: VerdictRow[];
}

// Bin width (also the y-axis LSD floor and every resolution-derived decimal count) and the
// histogram window centre. With samples the chart can see: the frozen recorded values, so both
// hold when logging stops or the live reading auto-ranges or goes OL. With none: the live
// reading, as a preview. Gates on the post-watermark count, never `store.count`: after a
// preserve-log mode change the store keeps the old unit's rows while both recorded values are
// null, which would take the histogram off the LSD grid and drop the floor and the decimals.
export function displayScale(
  store: Pick<SampleStore, 'count' | 'firstSeq'>,
  view: Pick<EngineView, 'chartFromSeq' | 'recordedResolution' | 'dominantValue'>,
  live: Reading | null,
): { binWidth?: number; centerValue?: number } {
  if (store.count - (view.chartFromSeq - store.firstSeq) > 0) {
    return { binWidth: view.recordedResolution ?? undefined, centerValue: view.dominantValue ?? undefined };
  }
  const value = live ? normalizeReading(live).baseValue : null;
  if (live === null || value === null) return {};
  return { binWidth: readingResolution(live) ?? undefined, centerValue: value };
}

export interface RestoreInput {
  mode: string;
  unit: string;
  chartFromSeq: number;
  verdicts: VerdictRow[];
}

export class CaptureEngine {
  // Readings per LSD-snapped value -> the dominant (most-held) value, which centers the
  // histogram window so a brief outlier can't pull it off. CLEARED in place rather than
  // replaced, which is what keeps its identity stable across a session reset.
  readonly counts = new Map<number, number>();
  recording = false;
  // Captured verdicts for the current batch. Separate from the sample store: the two
  // have different lifecycles and clear independently.
  passFailRows: VerdictRow[] = [];
  chartFromSeq = 0;

  private stats: SessionStats = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
  private mode: string | null = null;
  private unit = '';
  private triggerArmed = false;
  private triggerThreshold: number | null = null;
  // Whether the current session was auto-started by the trigger (scopes auto-stop).
  private triggerStarted = false;
  private stabilityCount = DEFAULT_SETTINGS.stabilityCount;
  private hysteresisPct = DEFAULT_SETTINGS.hysteresisPct;
  private stableOnly = DEFAULT_SETTINGS.stableOnly;
  private preserveOnModeChange = DEFAULT_SETTINGS.preserveOnModeChange;
  private capNoPartFloor = DEFAULT_SETTINGS.capNoPartFloor;
  // Pass/Fail config, in ENTRY units (converted per-sample with the reading's own mode, so
  // a mid-batch mode change can't apply the wrong factor).
  private pfRefEntry: number | null = null;
  private pfBandEntry: number | null = null;
  private pfToleranceMode: ToleranceMode = 'percent';
  private pfToleranceValue: number | null = null;
  // "Already captured this part" latch for the Pass/Fail store. Separate from
  // `lastLoggedValue` because the two stores clear independently; both are cleared
  // by the same discontinuity (OL / capacitance no-part).
  private pfLastCaptured: number | null = null;
  private pfRowId = 0;
  // Capture (rows, tones) only while the Pass/Fail view is open. Starts off: the page's
  // first view is the Dashboard.
  private passFailActive = false;
  // Base-unit value anchoring the current run. A reading joins the run while it stays
  // within STABLE_LSD_TOLERANCE of this; anything further starts a new run anchored at
  // itself. Anchored rather than compared to the immediately previous reading, so a
  // slow ramp cannot creep along one LSD at a time and look settled forever.
  private runAnchor: number | null = null;
  private stableRun = 0;
  private lastLoggedValue: number | null = null;
  // Coarsest LSD among LOGGED readings — the basis for histogram bin width AND stat
  // decimals, so both reflect stored data, not the live (possibly auto-ranged) reading.
  // Frozen while logging is stopped; reset in flush.
  private recordedResolution: number | null = null;
  private dominantValue: number | null = null;
  private dominantCount = 0;
  // Set by `restore`, spent by the first mode change after it. See `restore`.
  private restoreGuard = false;
  private version = 0;
  private chartEpoch = 0;
  // A latch, not a derivation: stamped at the end of the first batch that leaves a sample the
  // chart can see, held until a reset. A retention trim drops the oldest samples and must not
  // move the x-axis anchor with them (gotchas.md, Chart).
  private sessionStartAt: number | null = null;
  // Written only at the end of `ingest`: flush, restore and a recording start leave the
  // shown reading's flag alone until the next batch, as the page always has.
  private currentStable = false;
  private statsSnap: SessionStats | null = null;
  private cachedView: EngineView | null = null;

  private readonly store: SampleStore;

  constructor(store: SampleStore) {
    this.store = store;
  }

  configure(s: CaptureSettings): void {
    this.stabilityCount = s.stabilityCount;
    this.hysteresisPct = s.hysteresisPct;
    this.stableOnly = s.stableOnly;
    this.preserveOnModeChange = s.preserveOnModeChange;
    this.capNoPartFloor = s.capNoPartFloor;
  }

  // Two setters, fed by two effects, on purpose: a mode change clears both inside `ingest`,
  // and a stale effect landing after it must not be able to restore a whole, firing trigger.
  setTriggerArmed(armed: boolean): void {
    this.triggerArmed = armed;
  }

  setTriggerThreshold(threshold: number | null): void {
    this.triggerThreshold = threshold;
  }

  setPassFailConfig(
    refEntry: number | null,
    toleranceValue: number | null,
    bandEntry: number | null,
    toleranceMode: ToleranceMode,
  ): void {
    this.pfRefEntry = refEntry;
    this.pfToleranceValue = toleranceValue;
    this.pfBandEntry = bandEntry;
    this.pfToleranceMode = toleranceMode;
  }

  // Leaving the view keeps the reference, tolerance and rows; it only stops capturing. The
  // latch still re-arms on a probe lift while away, so a part already captured and still
  // held is not captured again on return, and a new part held on return is.
  setPassFailActive(active: boolean): void {
    this.passFailActive = active;
  }

  // `manual`: a toggle by the operator, so this session is not trigger-owned and is never
  // auto-stopped. Returns true when it flushed first: a session whose newest sample is past the
  // retention window (a restored old one, or one left idle for a week) would be trimmed away by
  // the first new sample, so recording ends it (the saved copy keeps it) and starts a new one.
  setRecording(v: boolean, manual = false): boolean {
    const n = this.store.count;
    const stale = v && n > 0 && Date.now() - this.store.tsAt(n - 1) > RETENTION_MS;
    if (stale) this.flush();
    if (manual) this.triggerStarted = false;
    this.recording = v;
    // A stop (manual or disconnect) ends any trigger-started session.
    if (!v) this.triggerStarted = false;
    // A fresh start must not inherit a stale predecessor/run from before it began.
    if (v) { this.runAnchor = null; this.stableRun = 0; this.lastLoggedValue = null; }
    return stale;
  }

  // Clears only the verdict batch — the Data Log's recorded rows are untouched, and
  // the reference/tolerance are kept (the operator is usually still on the same part).
  //
  // Deliberately does NOT touch `pfLastCaptured`: that guard is what stops a held
  // part from being captured twice, and it already re-arms itself on a genuine probe
  // lift (baseValue null/no-part, in ingest). Resetting it here would re-capture and
  // re-beep the part still on the probes. Clear Batch is a table boundary, not a probe-lift.
  clearVerdicts(): void {
    this.passFailRows = [];
    this.pfRowId = 0;
  }

  // Annotation only, keyed on `seq` (survives trimming). The bump is what re-renders the
  // controlled note input; nothing else about the store changed.
  setNote(seq: number, note: string): void {
    this.store.setNote(seq, note);
    this.version++;
  }

  // Full session flush: clear the canonical store AND every derived projection.
  flush(): void {
    this.restoreGuard = false;
    // `clear()` keeps seq monotonic, so the watermark below lands past every seq ever used
    // and a stale watermark can never sit ahead of new samples.
    this.store.clear();
    this.version++;
    this.resetDerived();
  }

  // Reset the single-unit projections (chart, stats, histogram derivation, stable run)
  // while KEEPING the canonical samples — the "keep log on mode change" path. Those views
  // can't mix units; the per-row table/CSV can (each row carries its own mode/unit).
  //
  // One integer, not a second buffer: the store is untouched and the chart simply starts
  // reading later. Clearing the store here would take the operator's log with it.
  private resetDerived(): void {
    this.resetAccumulators();
    // Next unused seq: everything already stored belongs to the previous unit.
    this.chartFromSeq = this.store.firstSeq + this.store.count;
    this.chartEpoch++;
  }

  // The trigger and the Pass/Fail reference typed for the current mode. The page clears its
  // own copies too, but only on its next render — readings replayed before that must already
  // see these cleared, or a stale armed trigger flushes a just-restored session.
  private clearEntryState(): void {
    this.triggerThreshold = null;
    this.triggerArmed = false;
    this.triggerStarted = false;
    this.pfRefEntry = null;
    this.pfBandEntry = null;
    this.pfToleranceValue = null;
    this.pfLastCaptured = null;
  }

  private resetAccumulators(): void {
    this.stats = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
    this.runAnchor = null;
    this.stableRun = 0;
    this.lastLoggedValue = null;
    this.recordedResolution = null;
    this.counts.clear();
    this.dominantValue = null;
    this.dominantCount = 0;
    this.statsSnap = null;
    this.sessionStartAt = null;
  }

  get view(): EngineView {
    const s = this.stats;
    if (s.count > 0 && this.statsSnap?.count !== s.count) this.statsSnap = { ...s };
    const next: EngineView = {
      version: this.version,
      chartEpoch: this.chartEpoch,
      chartFromSeq: this.chartFromSeq,
      unit: this.unit,
      recording: this.recording,
      currentStable: this.currentStable,
      sessionStart: this.sessionStartAt,
      stats: this.statsSnap,
      recordedResolution: this.recordedResolution,
      dominantValue: this.dominantValue,
      passFailRows: this.passFailRows,
    };
    const prev = this.cachedView;
    if (prev !== null && (Object.keys(next) as (keyof EngineView)[]).every((k) => next[k] === prev[k])) return prev;
    this.cachedView = next;
    return next;
  }

  // What a saved session needs to carry besides the samples so `restore` can put the engine
  // back where the read loop left off.
  get context(): { mode: string | null; unit: string; chartFromSeq: number } {
    return { mode: this.mode, unit: this.unit, chartFromSeq: this.chartFromSeq };
  }

  // Put the engine in the state the read loop would be in had it recorded the loaded store
  // itself. The store has already been loaded by the caller. Recording stays off.
  //
  // The mode/unit assignment is what stops the first packet from taking the mode-change branch
  // and flushing the restored rows (a fresh page has `mode === null`; see gotchas.md). The
  // guard covers the other way in: restoring a resistance session while the meter shows voltage
  // makes the first reading a REAL mode change.
  restore(s: RestoreInput): void {
    const store = this.store;
    this.mode = s.mode;
    this.unit = s.unit;
    this.setRecording(false);
    this.clearEntryState();
    this.resetAccumulators();
    this.chartFromSeq = s.chartFromSeq;
    this.restoreGuard = true;
    this.passFailRows = s.verdicts;
    // `VerdictRow.id` is a React key: the next captured row must not collide with a restored one.
    this.pfRowId = s.verdicts.reduce((next, v) => Math.max(next, v.id + 1), 0);

    // Same order as `ingest`, with the LSD it would have computed: the stored decimals and wire
    // unit are exactly `readingResolution`'s inputs. Only rows at or after the watermark
    // count — earlier ones belong to a unit the statistics and histogram do not mix.
    for (let i = Math.max(0, s.chartFromSeq - store.firstSeq); i < store.count; i++) {
      const unit = store.unitAt(i);
      const lsd = unit === '' ? null : lsdOf(store.decimalsAt(i), unit);
      this.accumulate(store.valueAt(i), lsd);
    }
    this.sessionStartAt = this.sessionStart();
    this.version++;
    this.chartEpoch++;
  }

  // The candidate for the `sessionStartAt` latch: the oldest sample the chart can actually see,
  // read from the store against the FINAL watermark rather than tracked during a batch. Stating
  // it as a derivation instead of a running candidate is what makes it immune to a mid-batch
  // watermark advance — the preserve-log mode change flushes old-unit samples and THEN advances,
  // so anything captured before that advance is the previous unit.
  private sessionStart(): number | null {
    const anchorIdx = Math.max(0, this.chartFromSeq - this.store.firstSeq);
    return this.store.count > anchorIdx ? this.store.tsAt(anchorIdx) : null;
  }

  // Retention, applied to the ONE store: past seven days the oldest samples leave the table and
  // the CSV too, not just the chart. Measured back from the newest sample, not the clock: a
  // restored session older than the window stays whole (for its CSV) until recording adds a
  // sample, instead of vanishing at the first reading.
  private trimToWindow(): boolean {
    const n = this.store.count;
    const trimmed = n > 0 && this.store.trim(this.store.tsAt(n - 1) - RETENTION_MS);
    if (trimmed) this.chartEpoch++;
    return trimmed;
  }

  // What the view reads at the end of a batch. Stamped after the trim, from the final watermark.
  private settleBatch(touched: boolean): void {
    if (touched) this.version++;
    this.sessionStartAt ??= this.sessionStart();
    this.currentStable = this.stableRun >= this.stabilityCount;
  }

  // The per-sample accumulation for one recorded value: histogram counts and the dominant
  // value that centres its window, the coarsest LSD (bin width + stat decimals reflect the
  // recorded data, range-robust to auto-ranging) and the Welford statistics. One method, not
  // two copies, because `restore` replays it over stored rows and must agree with the live
  // path exactly. No clamping: the operator's y-range is applied when the chart draws, so
  // changing it re-clamps the whole session instead of only what arrives next.
  private accumulate(baseValue: number, lsd: number | null): void {
    if (lsd !== null) {
      const k = Math.round(baseValue / lsd) * lsd;
      const c = (this.counts.get(k) ?? 0) + 1;
      this.counts.set(k, c);
      if (c > this.dominantCount) {
        this.dominantCount = c;
        this.dominantValue = k;
      }
      this.recordedResolution = Math.max(this.recordedResolution ?? 0, lsd);
    }
    const s = this.stats;
    s.count += 1;
    const delta = baseValue - s.mean;
    s.mean += delta / s.count;
    s.m2 += delta * (baseValue - s.mean);
    if (baseValue < s.min) s.min = baseValue;
    if (baseValue > s.max) s.max = baseValue;
  }

  ingest(readings: Reading[]): BatchResult {
    const store = this.store;
    let armed = this.triggerArmed;
    let threshold = this.triggerThreshold;
    let release = threshold !== null ? threshold * (1 - this.hysteresisPct / 100) : null;

    let unitChanged: string | null = null;
    let modeReset = false;
    let reset = false;
    let rowsChanged = false;
    let recordingChanged = false;
    // ONE staging array, appended to the store once at the end of the batch. Not a
    // performance choice — a batch is three to ten samples — but a control-flow one: the
    // loop discards already-collected samples on a mode change and on a trigger edge, and
    // a store appended per sample has no un-append.
    //
    // One array, so a trigger edge discards chart and log samples together. With two, a
    // re-trigger mid-batch kept log rows whose chart points had been dropped.
    const staged: { ts: number; value: number; mode: Mode; unit: string; decimals: number }[] = [];
    // Whether this batch changed anything the UI reads: a staged sample, or a retention
    // trim that dropped one. Everything the UI reads lives behind this gate.
    let touched = false;
    const newVerdicts: VerdictRow[] = [];

    // Append what is staged so far. Called at a mode change that preserves the log —
    // those samples belong to the OLD unit, so they must reach the store before the
    // watermark moves past them — and once at the end of the batch.
    //
    // It deliberately computes nothing about `sessionStart`. A candidate captured here
    // would be captured against whatever the watermark was AT THE TIME, and the preserve
    // path advances the watermark immediately afterwards — so the candidate would be an
    // old-unit sample that the advance then excludes from the chart. The anchor is derived
    // once, at the end of the batch, from the FINAL watermark.
    const flushStaged = () => {
      for (const st of staged) store.append(st.ts, st.value, st.mode, st.unit, st.decimals);
      staged.length = 0;
    };
    for (const r of readings) {
      const { baseValue, baseUnit } = normalizeReading(r);

      if (baseUnit !== '' && (this.mode !== r.mode || this.unit !== baseUnit)) {
        const wasInitialized = this.mode !== null;
        // A restore keeps the log through a change at its first reading, whatever the setting says.
        const keepLog = this.preserveOnModeChange || this.restoreGuard;
        this.mode = r.mode;
        this.unit = baseUnit;
        unitChanged = baseUnit;
        // Keep the recorded log across a real mode change if opted in (chart/stats are
        // single-unit and always reset). The first detection has no prior data, so a
        // full flush is equivalent. Old-unit rows stay valid in their original unit.
        if (wasInitialized && keepLog) {
          // Samples staged before the change are old-unit rows the operator asked to keep.
          // They must reach the store BEFORE the watermark advances, or the watermark
          // lands behind them and the chart draws the previous unit.
          flushStaged();
          this.resetDerived();
        } else {
          staged.length = 0;
          this.flush();
          touched = true;
        }
        reset = true;
        // A real mode/unit change makes the in-progress data, threshold and reference
        // meaningless in the new unit — stop logging and clear them. (Skip on the first
        // reading, which is initial detection, not a change, so a pre-typed threshold
        // survives.) The captured verdicts follow "Keep log on mode change" like the Data
        // Log does: each row carries its own mode, so a kept batch stays valid.
        if (wasInitialized) {
          recordingChanged ||= this.recording;
          this.recording = false;
          this.clearEntryState();
          armed = false;
          threshold = null;
          release = null;
          if (!keepLog) {
            this.passFailRows = [];
            this.pfRowId = 0;
            newVerdicts.length = 0;
            rowsChanged = true;
          }
          modeReset = true;
        }
      }
      // Spent by the first reading with a unit, changed or not, so a mode change hours after the
      // restore follows the setting like any other.
      this.restoreGuard &&= baseUnit === '';

      // Trigger edges (evaluated before recording so the crossing sample is captured).
      const mag = baseValue !== null ? Math.abs(baseValue) : null;
      if (armed && threshold !== null && !this.recording && mag !== null && mag > threshold) {
        // Clears EVERYTHING staged, chart and log alike.
        staged.length = 0;
        this.flush();
        reset = true;
        touched = true;
        this.recording = true;
        this.triggerStarted = true;
        recordingChanged = true;
      } else if (this.triggerStarted && this.recording && release !== null && mag !== null && mag < release) {
        this.recording = false;
        this.triggerStarted = false;
        recordingChanged = true;
      }

      // A capacitance stray would otherwise append a junk row on every probe lift and never
      // clear the last-logged reference.
      const noPart = isCapacitanceStray(r.mode, baseValue, this.capNoPartFloor);

      // Stable-run tracking runs regardless of the recording session, because Pass/Fail
      // capture has no session of its own (its batch boundary is Clear). Harmless for
      // the Data Log: every path that STARTS recording resets these
      // first, so anything accumulated while idle is wiped when recording begins.
      if (baseValue === null || noPart) {
        // OL (and a capacitance no-part reading) are excluded from the filtered
        // dataset entirely — table, CSV, chart, and stats. Both are still a
        // discontinuity — reset the run and BOTH stores' last-captured references.
        this.runAnchor = null;
        this.stableRun = 0;
        this.lastLoggedValue = null;
        this.pfLastCaptured = null;
      } else {
        // Maintain the run of consecutive readings belonging to the same measurement.
        // Membership is a band around the run's anchor, not equality
        // (see STABLE_LSD_TOLERANCE in lib/parser.ts).
        const lsd = readingResolution(r);
        const anchor = this.runAnchor;
        if (anchor !== null && withinStableBand(baseValue, anchor, lsd)) {
          this.stableRun += 1;
        } else {
          this.stableRun = 1;
          this.runAnchor = baseValue;
        }
        // Capacitance needs no extra count: the meter sends "-.--" (isMeasuring) until
        // it has a number — confirmed on a 3.3 mF electrolytic — so its first digit
        // value is already settled.
        const stable = this.stableRun >= this.stabilityCount;

        // ---- Pass/Fail capture (independent of the recording session; Pass/Fail view only)
        // Here only an exact zero can fail `partUnderProbes` (OL and strays took the branch
        // above); it re-arms the latch without resetting the run.
        if (!partUnderProbes(r.mode, baseValue, this.capNoPartFloor)) {
          this.pfLastCaptured = null;
        } else if (
          this.passFailActive &&
          canJudge(r.mode, baseUnit, stable, this.pfRefEntry, this.pfBandEntry)
        ) {
          const last = this.pfLastCaptured;
          // Gated on the stable run, same flag the live verdict uses (via currentStable),
          // so display and table never disagree. Resistance and diode need it: with no
          // "measuring" state, lifting a probe sweeps UP through intermediates and a
          // >50% step would read as a fresh part. The major-change gate suppresses drift
          // within one held part; a probe lift clears the reference for the next.
          if (isMajorChange(baseValue, last)) {
            this.pfLastCaptured = baseValue;
            newVerdicts.push({
              id: this.pfRowId++,
              ts: r.ts,
              iso: localIso(r.ts),
              mode: r.mode,
              baseValue,
              ...verdictFor(r.mode, baseValue, this.pfRefEntry!, this.pfBandEntry!),
              toleranceMode: this.pfToleranceMode,
              toleranceValue: this.pfToleranceValue!,
              resolution: lsd,
              unit: r.unit,
              decimals: displayDecimals(r.display),
            });
          }
        }

        // ---- Data Log / chart / statistics (gated on the recording session) -----
        if (this.recording) {
          // Stable filter on: log only a confirmed-stable value that differs from the
          // last logged one by a major amount, suppressing drift and plateaus.
          let logSample = true;
          if (this.stableOnly) {
            logSample = stable && isMajorChange(baseValue, this.lastLoggedValue);
            if (logSample) this.lastLoggedValue = baseValue;
          }

          if (logSample) {
            // Everything recorded is behind this one gate, deliberately: the store, the
            // histogram counts, the recorded resolution and the statistics. Hoisting any of
            // it one scope out bypasses "Stable values only" for that consumer: hoisted
            // counts would grow the histogram three times a second while the Samples tile
            // counts recorded entries.
            staged.push({
              ts: r.ts,
              value: baseValue,
              mode: r.mode,
              unit: r.unit,
              decimals: displayDecimals(r.display),
            });
            touched = true;
            this.accumulate(baseValue, lsd);
          }
        }
      }
    }

    // ---- Once per batch, never in the per-sample loop ------------------------
    flushStaged();

    // A dropped chunk invalidates the chart's incremental tier, which is what `chartEpoch` tells it.
    const trimmed = this.trimToWindow();
    if (trimmed) touched = true;
    this.settleBatch(touched);

    // Same batched append for the Pass/Fail store.
    if (newVerdicts.length > 0) {
      this.passFailRows = [...this.passFailRows, ...newVerdicts];
      rowsChanged = true;
    }

    return { unit: unitChanged, modeReset, reset, touched, trimmed, verdicts: newVerdicts, rowsChanged, recordingChanged };
  }
}
