// The capture engine: what the read loop does with each batch of readings — stable-run
// detection, trigger edges, discontinuities, both capture latches, mode-change flushes, the
// staged append to the store. No React, no DOM: `scripts/check-capture.mts` drives it under
// Node, because a wrong capture rule records the wrong rows and nothing on screen says so.
//
// It never touches React state. `ingest` returns what changed and the page commits it, once
// per batch — which is what keeps setState out of the per-sample loop by construction.

import {
  displayDecimals, normalizeReading, readingResolution, withinStableBand,
  type Mode, type Reading,
} from './parser.ts';
import { RETENTION_MS, type SampleStore } from './samples.ts';
import {
  ENTRY_UNITS, entryToBase, isSupportedMode, judge,
  type ToleranceMode, type VerdictRow,
} from './passfail.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

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

export interface BatchResult {
  // Base unit of the last mode/unit change in this batch, else null.
  unit: string | null;
  // A real (not first-detection) mode change: the trigger and Pass/Fail entry fields clear.
  modeReset: boolean;
  // The derived projections were reset; `chartFromSeq` holds the new watermark.
  reset: boolean;
  touched: boolean;
  trimmed: boolean;
  sessionStart: number | null;
  // A copy when this batch appended since its last reset; null means "do not commit".
  stats: SessionStats | null;
  verdicts: VerdictRow[];
  rowsChanged: boolean;
  recordingChanged: boolean;
  currentStable: boolean;
  recordedResolution: number | null;
  dominantValue: number | null;
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
  // auto-stopped.
  setRecording(v: boolean, manual = false): void {
    if (manual) this.triggerStarted = false;
    this.recording = v;
    // A stop (manual or disconnect) ends any trigger-started session.
    if (!v) this.triggerStarted = false;
    // A fresh start must not inherit a stale predecessor/run from before it began.
    if (v) { this.runAnchor = null; this.stableRun = 0; this.lastLoggedValue = null; }
  }

  // Clears only the verdict batch — the Data Log's recorded rows are untouched, and
  // the reference/tolerance are kept (the operator is usually still on the same part).
  //
  // Deliberately does NOT touch `pfLastCaptured`: that guard is what stops a held
  // part from being captured twice, and it already re-arms itself on a genuine probe
  // lift (baseValue null/no-part, in ingest). Resetting it here too used to re-capture
  // (and re-beep) the SAME still-connected part the instant Clear Batch was pressed.
  // Clear Batch is a table boundary, not a probe-lift.
  clearVerdicts(): void {
    this.passFailRows = [];
    this.pfRowId = 0;
  }

  // Full session flush: clear the canonical store AND every derived projection.
  flush(): void {
    // `clear()` keeps seq monotonic, so the watermark below lands past every seq ever used
    // and a stale watermark can never sit ahead of new samples.
    this.store.clear();
    this.resetDerived();
  }

  // Reset the single-unit projections (chart, stats, histogram derivation, stable run)
  // while KEEPING the canonical samples — the "keep log on mode change" path. Those views
  // can't mix units; the per-row table/CSV can (each row carries its own mode/unit).
  //
  // This is the ONE thing two parallel buffers were genuinely buying, and it costs one
  // integer: the store is untouched and the chart simply starts reading later. Clearing the
  // store here would take the operator's log with it.
  private resetDerived(): void {
    this.stats = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
    this.runAnchor = null;
    this.stableRun = 0;
    this.lastLoggedValue = null;
    this.recordedResolution = null;
    this.counts.clear();
    this.dominantValue = null;
    this.dominantCount = 0;
    // Next unused seq: everything already stored belongs to the previous unit.
    this.chartFromSeq = this.store.firstSeq + this.store.count;
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
    // Collapsing the old `newPoints`/`newRows` pair into one also repairs a live bug: the
    // trigger branch below used to clear only `newPoints`, so a re-trigger mid-batch kept
    // rows in the log whose chart points had been dropped — two consumers disagreeing, in
    // the function whose comment claims their membership is identical by construction.
    const staged: { ts: number; value: number; mode: Mode; unit: string; decimals: number }[] = [];
    // Whether this batch changed anything the UI reads: a staged sample, or a retention
    // trim that dropped one. Everything the UI reads now lives behind the same gate.
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
    //
    // Samples appended SINCE THE LAST RESET in this batch. Zeroed at every reset site,
    // because stats is zeroed there too: counting across a reset would commit a
    // freshly-zeroed stats object over the `null` the reset queued.
    let appended = 0;
    const flushStaged = () => {
      for (const st of staged) store.append(st.ts, st.value, st.mode, st.unit, st.decimals);
      appended += staged.length;
      staged.length = 0;
    };
    for (const r of readings) {
      const { baseValue, baseUnit } = normalizeReading(r);

      if (baseUnit !== '' && (this.mode !== r.mode || this.unit !== baseUnit)) {
        const wasInitialized = this.mode !== null;
        this.mode = r.mode;
        this.unit = baseUnit;
        unitChanged = baseUnit;
        // Keep the recorded log across a real mode change if opted in (chart/stats are
        // single-unit and always reset). The first detection has no prior data, so a
        // full flush is equivalent. Old-unit rows stay valid in their original unit.
        if (wasInitialized && this.preserveOnModeChange) {
          // Samples staged before the change are old-unit rows the operator asked to keep.
          // They must reach the store BEFORE the watermark advances, or the watermark
          // lands behind them and the chart draws the previous unit.
          flushStaged();
          this.resetDerived();
          reset = true;
          appended = 0;
        } else {
          staged.length = 0;
          this.flush();
          reset = true;
          touched = true;
          appended = 0;
        }
        // A real mode/unit change makes the in-progress data and threshold
        // meaningless in the new unit — stop logging, then reset the trigger
        // (clear threshold + disarm). (Skip on the first reading, which is
        // initial detection, not a change, so a pre-typed threshold survives.)
        if (wasInitialized) {
          if (this.recording) {
            this.recording = false;
            recordingChanged = true;
          }
          this.triggerThreshold = null;
          this.triggerArmed = false;
          this.triggerStarted = false;
          armed = false;
          threshold = null;
          release = null;
          // The reference belongs to the old mode's unit and is meaningless in the new one —
          // cleared for the same reason the trigger threshold is. The captured verdicts
          // follow "Keep log on mode change" like the Data Log does: each row carries its own
          // mode, so a kept batch stays valid in its original unit.
          this.pfRefEntry = null;
          this.pfBandEntry = null;
          this.pfToleranceValue = null;
          this.pfLastCaptured = null;
          if (!this.preserveOnModeChange) {
            this.passFailRows = [];
            this.pfRowId = 0;
            newVerdicts.length = 0;
            rowsChanged = true;
          }
          modeReset = true;
        }
      }

      // Trigger edges (evaluated before recording so the crossing sample is captured).
      const mag = baseValue !== null ? Math.abs(baseValue) : null;
      if (armed && threshold !== null && !this.recording && mag !== null && mag > threshold) {
        // Clears EVERYTHING staged, chart and log alike. Previously only the chart half was
        // dropped here; see the `staged` comment above.
        staged.length = 0;
        this.flush();
        reset = true;
        touched = true;
        appended = 0;
        this.recording = true;
        this.triggerStarted = true;
        recordingChanged = true;
      } else if (this.triggerStarted && this.recording && release !== null && mag !== null && mag < release) {
        this.recording = false;
        this.triggerStarted = false;
        recordingChanged = true;
      }

      // Capacitance has no OL on lifted probes — it reads lead stray capacitance (pF),
      // which is numeric, so without this it appends a junk near-zero row on every probe
      // lift and never clears the last-logged reference. A floor of 0 disables it.
      const noPart =
        baseValue !== null &&
        r.mode === 'CAPACITANCE' &&
        Math.abs(baseValue) < this.capNoPartFloor;

      // Stable-run tracking runs regardless of the recording session, because Pass/Fail
      // capture has no session of its own (its batch boundary is Clear). Behavior-
      // preserving for the Data Log: every path that STARTS recording resets these
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
        // An exact zero means nothing is connected, not a part measuring zero: with the
        // probes floating the meter settles on 0 in every supported mode, and a real
        // component never reads a clean 0 (a 0R link still shows lead resistance).
        // Scoped to Pass/Fail — the Data Log records a genuine 0 as a real measurement.
        const pfRefEntry = this.pfRefEntry;
        const pfBandEntry = this.pfBandEntry;
        if (baseValue === 0) {
          this.pfLastCaptured = null;
        } else if (
          this.passFailActive &&
          stable &&
          pfRefEntry !== null &&
          pfBandEntry !== null &&
          isSupportedMode(r.mode) &&
          // Guards a stale reference being judged in the wrong unit: the mode-change
          // reset is gated on `baseUnit !== ''`, so an unrecognized unit string
          // (documented as possible above nF) skips it and leaves the old reference
          // live while r.mode has already changed.
          baseUnit === ENTRY_UNITS[r.mode].baseUnit
        ) {
          const last = this.pfLastCaptured;
          // Gated on the stable run, same flag the live verdict uses (via currentStable),
          // so display and table never disagree. Resistance and diode need it: with no
          // "measuring" state, lifting a probe sweeps UP through intermediates and a
          // >50% step would read as a fresh part. The major-change gate suppresses drift
          // within one held part; a probe lift clears the reference for the next.
          if (isMajorChange(baseValue, last)) {
            this.pfLastCaptured = baseValue;
            const toBase = ENTRY_UNITS[r.mode].toBase;
            const baseReference = entryToBase(r.mode, pfRefEntry);
            const baseBand = pfBandEntry * toBase;
            newVerdicts.push({
              id: this.pfRowId++,
              ts: r.ts,
              iso: new Date(r.ts).toISOString(),
              mode: r.mode,
              baseValue,
              baseReference,
              baseBand,
              toleranceMode: this.pfToleranceMode,
              toleranceValue: this.pfToleranceValue!,
              verdict: judge(baseValue, baseReference, baseBand),
              deviation: baseValue - baseReference,
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
            // Readings per LSD-snapped value: the histogram's bars and the dominant value
            // that centres its window. INSIDE the `logSample` gate, with everything else.
            //
            // It sat outside once, counting every reading regardless of the filter. That
            // made the histogram grow three times a second while the Samples tile stayed
            // at the number of recorded entries — two readouts of the same session
            // disagreeing by orders of magnitude. The filter is a gate: a reading it
            // rejects is not recorded anywhere, and that has to include here.
            if (lsd !== null) {
              const k = Math.round(baseValue / lsd) * lsd;
              const c = (this.counts.get(k) ?? 0) + 1;
              this.counts.set(k, c);
              if (c > this.dominantCount) {
                this.dominantCount = c;
                this.dominantValue = k;
              }
            }
            // Everything in this block is behind the same gate, deliberately: the store,
            // the histogram counts, the recorded resolution and the statistics. Hoisting
            // any of it to the `recording` level one scope out would silently disable
            // "Stable values only" for that consumer — no compile error, and no visible
            // symptom until two readouts of the same session disagree.
            staged.push({
              ts: r.ts,
              value: baseValue,
              mode: r.mode,
              unit: r.unit,
              decimals: displayDecimals(r.display),
            });
            touched = true;
            // Track the coarsest LSD among logged readings → bin width + stat
            // decimals reflect the recorded data, range-robust to auto-ranging.
            if (lsd !== null) {
              this.recordedResolution = Math.max(this.recordedResolution ?? 0, lsd);
            }
            const s = this.stats;
            s.count += 1;
            const delta = baseValue - s.mean;
            s.mean += delta / s.count;
            s.m2 += delta * (baseValue - s.mean);
            if (baseValue < s.min) s.min = baseValue;
            if (baseValue > s.max) s.max = baseValue;
            // No clamping here. The operator's y-range is applied when the chart draws, so
            // changing it re-clamps the whole session instead of only what arrives next.
          }
        }
      }
    }

    // ---- Once per batch, never in the per-sample loop ------------------------
    flushStaged();

    // Retention, applied to the ONE store: past seven days the oldest samples leave the
    // table and the CSV too, not just the chart. A dropped chunk invalidates the chart's
    // incremental tier, which is what `chartEpoch` tells it.
    const trimmed = store.trim(Date.now() - RETENTION_MS);
    if (trimmed) touched = true;

    // The chart's x-axis anchor: the oldest sample the chart can actually see, read from
    // the store against the FINAL watermark rather than tracked during the batch. Stating
    // it as a derivation instead of a running candidate is what makes it immune to a
    // mid-batch watermark advance — the preserve-log mode change flushes old-unit samples
    // and THEN advances, so anything captured before that advance is the previous unit.
    const anchorIdx = Math.max(0, this.chartFromSeq - store.firstSeq);
    const sessionStart = store.count > anchorIdx ? store.tsAt(anchorIdx) : null;

    // Same batched append for the Pass/Fail store.
    if (newVerdicts.length > 0) {
      this.passFailRows = [...this.passFailRows, ...newVerdicts];
      rowsChanged = true;
    }

    return {
      unit: unitChanged,
      modeReset,
      reset,
      touched,
      trimmed,
      sessionStart,
      // Only when something was actually logged: stats mutates inside `if (logSample)`,
      // so with the stable filter on most batches change nothing and a fresh object identity
      // would re-render StatisticsPanel three times a second for nothing.
      stats: appended > 0 ? { ...this.stats } : null,
      verdicts: newVerdicts,
      rowsChanged,
      recordingChanged,
      // After the loop the run describes the LAST reading of the batch, which is the one
      // the page's `current` holds.
      currentStable: this.stableRun >= this.stabilityCount,
      recordedResolution: this.recordedResolution,
      dominantValue: this.dominantValue,
    };
  }
}
