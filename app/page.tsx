'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { DigitalDisplay } from '@/components/DigitalDisplay';
import { RealtimeChart, type TimeRange } from '@/components/RealtimeChart';
import { Controls } from '@/components/Controls';
import { Sidebar, NAV_IDS, type NavId } from '@/components/Sidebar';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { DataLog } from '@/components/DataLog';
import { Settings } from '@/components/Settings';
import { NoDataWarning } from '@/components/NoDataWarning';
import { PassFail } from '@/components/PassFail';
import {
  SCALE, displayDecimals, displayUnit, normalizeReading, readingResolution,
  resolutionDecimals, withinStableBand, type Mode, type Reading,
} from '@/lib/parser';
import { RETENTION_MS, SampleStore } from '@/lib/samples';
import {
  ENTRY_UNITS, entryToBase, formatEntryValue, isSupportedMode, judge, parseSiValue,
  resolveAbsoluteTolerance, resolveBand,
  type ToleranceMode, type VerdictRow,
} from '@/lib/passfail';
import { useSerial, type SerialStatus } from '@/lib/useSerial';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/lib/settings';
import { createBeeper, type Beeper } from '@/lib/beep';
import { csvBlob, csvEsc } from '@/lib/csv';
// App version — single source of truth is package.json "version". Bump it on every
// change (see AGENTS.md "Versioning") so the footer reflects what's deployed.
import { version as APP_VERSION } from '@/package.json';

// Connected-but-silent threshold: if the port is connected but no reading has arrived
// for this long, the no-data warning condition is active (the ZT703s streams
// continuously, so 3 s of silence is clearly abnormal — meter off / lead broken).
const NO_DATA_MS = 3000;
// Stable-only logging: once a settled value is logged, the next is logged only if it
// differs by >= this fraction — ignores ±1 LSD drift. NOTE: relative, so very sensitive
// near zero (0.0001 -> 0.0002 is +100%); add an absolute floor if that proves noisy.
const MAJOR_CHANGE_RATIO = 0.5;
const downloadCsv = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

// Shared by both capture sites. The `v !== last` clause only matters when last === 0,
// which is reachable on the Data Log path (a genuine logged 0) but not on the Pass/Fail
// one (zero is intercepted as "no part") — keep it, it is load-bearing for one caller.
const isMajorChange = (v: number, last: number | null): boolean =>
  last === null || (v !== last && Math.abs(v - last) >= MAJOR_CHANGE_RATIO * Math.abs(last));
// Pass/Fail verdict tones. Far apart in pitch AND length so they're told apart by ear
// alone — the operator is looking at the parts, not the screen.
const PASS_TONE = { hz: 1180, ms: 90 };
const FAIL_TONE = { hz: 300, ms: 280 };
// Quiet period before a Pass/Fail entry is final. Typing "10" passes through "1", and
// judging that intermediate flashes FAIL at 1% on the way to 10%.
const PF_INPUT_DEBOUNCE_MS = 350;

const toFinite = (s: string): number | null => {
  if (s === '') return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const STATUS_LABEL: Record<SerialStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  unsupported: 'Unsupported',
};

const STATUS_DOT: Record<SerialStatus, string> = {
  connected: 'bg-success',
  connecting: 'animate-pulse bg-amber',
  disconnected: 'bg-muted',
  unsupported: 'bg-muted',
};

export default function Home() {
  const [baud, setBaud] = useState(DEFAULT_SETTINGS.baud);
  // The active view. Stays 'dashboard' for the first render so it matches the statically
  // exported HTML; the URL hash takes over in the mount effect below.
  const [view, setView] = useState<NavId>('dashboard');
  const [current, setCurrent] = useState<Reading | null>(null);
  // Whether `current` has been confirmed stable. The read loop owns the run counter in
  // a ref; this is its render-visible mirror, committed once per batch. Pass/Fail needs
  // it because a resistance reading sweeps through intermediate values as the probe is
  // lifted, and comparing those produces a spurious FAIL.
  const [currentStable, setCurrentStable] = useState(false);
  const [recording, setRecording] = useState(false);
  // Bumped once per batch when the batch changed anything the UI reads. The store is a ref,
  // so nothing else tells React the numbers moved — this is the array identity that the two
  // spread-copy buffers used to provide, stated as a value instead of implied by a copy.
  const [sampleVersion, setSampleVersion] = useState(0);
  // Where the chart, statistics and histogram start reading. Advanced instead of clearing the
  // store when a mode change preserves the log, so the table and CSV keep rows the chart must
  // not draw (the `settings` preserve-log-on-mode-change toggle). State, not just a ref: the
  // chart's update effect keys off its dependency array and a ref never changes identity.
  const [chartFromSeq, setChartFromSeq] = useState(0);
  const chartFromSeqRef = useRef(0);
  // Bumped whenever the chart's incremental tier is invalidated — a watermark advance, or a
  // retention trim dropping a chunk out from under its oldest buckets.
  const [chartEpoch, setChartEpoch] = useState(0);
  // When the current session's first point arrived. The chart anchors its x-axis here
  // while the session is younger than the selected window. Deliberately NOT derived from
  // the store's oldest sample: it is trimmed, so that is a fact about retention,
  // not about the session. Today retention covers the longest window and the two would
  // agree — which is exactly why deriving it would be a trap, since shortening retention
  // later would silently break the anchor instead of failing loudly.
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [chartUnit, setChartUnit] = useState('');
  const [rangeMin, setRangeMin] = useState(DEFAULT_SETTINGS.rangeMin);
  const [rangeMax, setRangeMax] = useState(DEFAULT_SETTINGS.rangeMax);
  const [autoScale, setAutoScale] = useState(DEFAULT_SETTINGS.autoScale);
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_SETTINGS.timeRange);
  const [triggerArmed, setTriggerArmed] = useState(false);
  const [triggerThreshold, setTriggerThreshold] = useState('');
  const [stableOnly, setStableOnly] = useState(DEFAULT_SETTINGS.stableOnly);
  // Persisted settings. Start at defaults so the static-export HTML matches the first
  // client render; a mount effect then hydrates from storage.
  const [stabilityCount, setStabilityCount] = useState(DEFAULT_SETTINGS.stabilityCount);
  const [hysteresisPct, setHysteresisPct] = useState(DEFAULT_SETTINGS.hysteresisPct);
  const [preserveOnModeChange, setPreserveOnModeChange] = useState(DEFAULT_SETTINGS.preserveOnModeChange);
  const [noDataWarning, setNoDataWarning] = useState(DEFAULT_SETTINGS.noDataWarning);
  const [noDataAudio, setNoDataAudio] = useState(DEFAULT_SETTINGS.noDataAudio);
  const [capNoPartFloor, setCapNoPartFloor] = useState(DEFAULT_SETTINGS.capNoPartFloor);
  const [verdictAudio, setVerdictAudio] = useState(DEFAULT_SETTINGS.verdictAudio);
  // Pass/Fail entry, held as the operator's raw strings so SI forms survive typing
  // (`4.5k` must not be mangled on its way through `4.`). Parsed on demand.
  const [pfReference, setPfReference] = useState('');
  const [pfTolerance, setPfTolerance] = useState('');
  const [pfToleranceMode, setPfToleranceMode] = useState<ToleranceMode>('percent');
  // Debounced mirrors of the two entry fields. The inputs stay live; everything
  // downstream (echo, band, live verdict, capture) reads these, so a half-typed value is
  // never judged. Cleared synchronously on a mode change.
  const [pfReferenceSettled, setPfReferenceSettled] = useState('');
  const [pfToleranceSettled, setPfToleranceSettled] = useState('');
  // Captured verdicts for the current batch. Separate from the sample store: the two
  // have different lifecycles and clear independently.
  const [passFailRows, setPassFailRows] = useState<VerdictRow[]>([]);
  const passFailRowsRef = useRef<VerdictRow[]>([]);
  const pfRowIdRef = useRef(0);
  // No-data warning: `noData` = connected-but-silent; `noDataDismissed` = OK'd for the
  // current outage (re-armed when it clears). `lastDataAtRef` is the detector's clock.
  const [noData, setNoData] = useState(false);
  const [noDataDismissed, setNoDataDismissed] = useState(false);
  const lastDataAtRef = useRef(0);
  // Mirror of recordedResolutionRef for render (histogram bin width + stat decimals);
  // the ref is the loop-side source, this state is its render-safe copy per batch.
  const [recordedResolution, setRecordedResolution] = useState<number | null>(null);
  // Value the meter spent the most readings at — the histogram window center, so a
  // brief outlier (short/disconnect) doesn't pull the window off the main reading.
  const [dominantValue, setDominantValue] = useState<number | null>(null);

  // THE canonical dataset — single source of truth for the chart, the histogram, the
  // statistics, the Data Log table and the CSV. Every one of those is a projection of this
  // store; none keeps a per-sample copy of its own (`filtered-data-source`). A ref, because
  // it is mutated in the read loop; `sampleVersion` is what render depends on.
  // Held in state with a lazy initializer rather than a ref: the instance never changes, so
  // this is one stable identity for the component's life and render never touches `.current`.
  // It is mutated in place by the read loop; `sampleVersion` is what tells React so.
  const [store] = useState<SampleStore>(() => new SampleStore());

  type SessionStats = { count: number; mean: number; m2: number; min: number; max: number };
  const statsRef = useRef<SessionStats>({ count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity });
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);

  const recordingRef = useRef(recording);
  const autoScaleRef = useRef(autoScale);
  const modeRef = useRef<string | null>(null);
  const unitRef = useRef<string>('');
  const triggerArmedRef = useRef(triggerArmed);
  const triggerThresholdRef = useRef<number | null>(null);
  // Mirror of timeRange read synchronously in the async read loop (skip cap in 'all').
  const timeRangeRef = useRef(timeRange);
  // Whether the current session was auto-started by the trigger (scopes auto-stop).
  const triggerStartedRef = useRef(false);
  const stableOnlyRef = useRef(stableOnly);
  // Settings mirrors read synchronously inside the async read loop (hot path).
  const stabilityCountRef = useRef(stabilityCount);
  const hysteresisPctRef = useRef(hysteresisPct);
  const preserveOnModeChangeRef = useRef(preserveOnModeChange);
  // Capacitance-only mirrors, read synchronously in the read loop.
  const capNoPartFloorRef = useRef(capNoPartFloor);
  // Pass/Fail config mirrors, in ENTRY units (converted per-sample with the reading's
  // own mode, so a mid-batch mode change can't apply the wrong factor).
  const pfRefEntryRef = useRef<number | null>(null);
  const pfBandEntryRef = useRef<number | null>(null);
  const pfToleranceModeRef = useRef<ToleranceMode>(pfToleranceMode);
  const pfToleranceValueRef = useRef<number | null>(null);
  // "Already captured this part" latch for the Pass/Fail store. Separate from
  // `lastLoggedValueRef` because the two stores clear independently; both are cleared
  // by the same discontinuity (OL / capacitance no-part).
  const pfLastCapturedRef = useRef<number | null>(null);
  const verdictAudioRef = useRef(verdictAudio);
  // One beeper for the component's life; created client-side, disposed on unmount.
  // Declared here rather than beside its effect because handleReadings (defined below)
  // sounds verdict tones through it.
  const beeperRef = useRef<Beeper | null>(null);
  // Base-unit value anchoring the current run. A reading joins the run while it stays
  // within STABLE_LSD_TOLERANCE of this; anything further starts a new run anchored at
  // itself. Anchored rather than compared to the immediately previous reading, so a
  // slow ramp cannot creep along one LSD at a time and look settled forever.
  const runAnchorRef = useRef<number | null>(null);
  const stableRunRef = useRef(0);
  const lastLoggedValueRef = useRef<number | null>(null);
  // Coarsest LSD among LOGGED readings — the basis for histogram bin width AND stat
  // decimals, so both reflect stored data, not the live (possibly auto-ranged) reading.
  // Frozen while logging is stopped; reset in flushSession.
  const recordedResolutionRef = useRef<number | null>(null);
  // Reading count per LSD-snapped value -> the dominant (most-held) value, which centers
  // the histogram window so a brief outlier can't pull it off.
  // Readings per LSD-snapped value. Held in state with a lazy initializer, not a ref, so it
  // is one stable identity that render can pass as a prop — and CLEARED in place rather than
  // replaced, which is what keeps that identity stable across a session reset.
  const [rawCounts] = useState<Map<number, number>>(() => new Map());
  const dominantValueRef = useRef<number | null>(null);
  const dominantCountRef = useRef(0);

  const setRec = useCallback((v: boolean) => {
    recordingRef.current = v;
    // A stop (manual or disconnect) ends any trigger-started session.
    if (!v) triggerStartedRef.current = false;
    // A fresh start must not inherit a stale predecessor/run from before it began.
    if (v) { runAnchorRef.current = null; stableRunRef.current = 0; lastLoggedValueRef.current = null; }
    setRecording(v);
  }, []);

  useEffect(() => { autoScaleRef.current = autoScale; }, [autoScale]);
  useEffect(() => { timeRangeRef.current = timeRange; }, [timeRange]);
  useEffect(() => { triggerArmedRef.current = triggerArmed; }, [triggerArmed]);
  useEffect(() => { triggerThresholdRef.current = toFinite(triggerThreshold); }, [triggerThreshold]);
  useEffect(() => { stableOnlyRef.current = stableOnly; }, [stableOnly]);
  useEffect(() => { stabilityCountRef.current = stabilityCount; }, [stabilityCount]);
  useEffect(() => { hysteresisPctRef.current = hysteresisPct; }, [hysteresisPct]);
  useEffect(() => { preserveOnModeChangeRef.current = preserveOnModeChange; }, [preserveOnModeChange]);
  useEffect(() => { capNoPartFloorRef.current = capNoPartFloor; }, [capNoPartFloor]);
  useEffect(() => { verdictAudioRef.current = verdictAudio; }, [verdictAudio]);
  useEffect(() => { pfToleranceModeRef.current = pfToleranceMode; }, [pfToleranceMode]);
  // Debounce each field independently. The cleanup cancels the pending commit on every
  // keystroke, so the value lands only once typing pauses.
  useEffect(() => {
    const id = setTimeout(() => setPfReferenceSettled(pfReference), PF_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [pfReference]);
  useEffect(() => {
    const id = setTimeout(() => setPfToleranceSettled(pfTolerance), PF_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [pfTolerance]);

  useEffect(() => {
    // Reads the SETTLED values, never the raw inputs. An absolute tolerance is read in
    // the reference's own SI range (see resolveAbsoluteTolerance); percent is unitless.
    const ref = parseSiValue(pfReferenceSettled);
    const tol =
      pfToleranceMode === 'absolute'
        ? resolveAbsoluteTolerance(pfToleranceSettled, ref)
        : parseSiValue(pfToleranceSettled);
    pfRefEntryRef.current = ref;
    pfToleranceValueRef.current = tol;
    pfBandEntryRef.current =
      ref !== null && tol !== null ? resolveBand(ref, tol, pfToleranceMode) : null;
  }, [pfReferenceSettled, pfToleranceSettled, pfToleranceMode]);

  // One-shot hydration from localStorage. setState-in-effect is intentional: the first
  // render must use defaults to match the static-export HTML.
  useEffect(() => {
    const s = loadSettings();
    /* eslint-disable react-hooks/set-state-in-effect -- intentional one-shot hydration */
    setStabilityCount(s.stabilityCount);
    setHysteresisPct(s.hysteresisPct);
    setPreserveOnModeChange(s.preserveOnModeChange);
    setNoDataWarning(s.noDataWarning);
    setNoDataAudio(s.noDataAudio);
    setCapNoPartFloor(s.capNoPartFloor);
    setVerdictAudio(s.verdictAudio);
    // Presentation + connection preferences. Restoring these is deliberately inert: none
    // of them starts logging, arms the trigger, or opens a port.
    setBaud(s.baud);
    setTimeRange(s.timeRange);
    setAutoScale(s.autoScale);
    setRangeMin(s.rangeMin);
    setRangeMax(s.rangeMax);
    setStableOnly(s.stableOnly);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Persist on change. Skip the first invocation (mount, still defaults) so we don't
  // clobber stored values before the hydration effect above has applied them.
  const persistReadyRef = useRef(false);
  useEffect(() => {
    if (!persistReadyRef.current) { persistReadyRef.current = true; return; }
    saveSettings({
      stabilityCount, hysteresisPct, preserveOnModeChange, noDataWarning, noDataAudio,
      capNoPartFloor, verdictAudio,
      baud, timeRange, autoScale, rangeMin, rangeMax, stableOnly,
    });
  }, [
    stabilityCount, hysteresisPct, preserveOnModeChange, noDataWarning, noDataAudio,
    capNoPartFloor, verdictAudio,
    baud, timeRange, autoScale, rangeMin, rangeMax, stableOnly,
  ]);

  // The URL hash is the source of truth for the active view: it survives a reload, gives
  // browser Back/Forward between views for free, and makes a view deep-linkable. Read only
  // after mount — this page is statically exported and prerendered, so `location` does not
  // exist at render time and reading it there would desync hydration.
  useEffect(() => {
    const fromHash = (): NavId => {
      const id = window.location.hash.slice(1);
      return (NAV_IDS as readonly string[]).includes(id) ? (id as NavId) : 'dashboard';
    };
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from the URL */
    setView(fromHash());
    // Back/Forward across pushState entries fires popstate; an edited address bar fires
    // hashchange. Both resolve through the same validated read, so handling them twice is
    // harmless and missing either is not.
    const sync = () => setView(fromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // Guard an unload that would discard the session. Registered ONLY while there is
  // something to lose: a permanently-registered beforeunload handler is a signal to the
  // browser in its own right (bfcache eligibility, PWA install heuristics), so an idle app
  // must not carry one. This also covers the service worker's Reload button, which goes
  // through window.location.reload() and is this app's most likely cause of session loss.
  // The store is mutated in place, so `sampleVersion` is what re-renders this component;
  // the reads themselves are plain and re-evaluate on every render.
  void sampleVersion;
  const sampleCount = store.count;
  const hasRows = sampleCount > 0 || passFailRows.length > 0;
  useEffect(() => {
    if (!hasRows) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers still gate the dialog on this
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasRows]);

  // Navigation is presentational only: it never touches logging, the trigger, or the port.
  // pushState (not location.hash =) so each view becomes its own history entry AND no
  // hashchange event fires — the listener above is left for Back/Forward and manual edits.
  const navigate = useCallback((id: NavId) => {
    setView(id);
    if (window.location.hash.slice(1) !== id) {
      window.history.pushState(null, '', `#${id}`);
    }
  }, []);

  // Reset the single-unit projections (chart, stats, histogram derivation, stable run)
  // while KEEPING the canonical samples — the "keep log on mode change" path. Those views
  // can't mix units; the per-row table/CSV can (each row carries its own mode/unit).
  //
  // This is the ONE thing two parallel buffers were genuinely buying, and it costs one
  // integer: the store is untouched and the chart simply starts reading later. Clearing the
  // store here would take the operator's log with it.
  const resetSessionDerived = useCallback(() => {
    statsRef.current = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
    runAnchorRef.current = null;
    stableRunRef.current = 0;
    lastLoggedValueRef.current = null;
    recordedResolutionRef.current = null;
    rawCounts.clear();
    dominantValueRef.current = null;
    dominantCountRef.current = 0;
    // Next unused seq: everything already stored belongs to the previous unit.
    const next = store.firstSeq + store.count;
    chartFromSeqRef.current = next;
    setChartFromSeq(next);
    setChartEpoch((e) => e + 1);
    setSessionStats(null);
    setSessionStart(null);
    setRecordedResolution(null);
    setDominantValue(null);
  }, [store, rawCounts]);

  // Full session flush: clear the canonical store AND every derived projection.
  const flushSession = useCallback(() => {
    // `clear()` keeps seq monotonic, so the watermark below lands past every seq ever used
    // and a stale watermark can never sit ahead of new samples.
    store.clear();
    setSampleVersion((v) => v + 1);
    resetSessionDerived();
  }, [resetSessionDerived, store]);

  const handleReadings = useCallback(
    (readings: Reading[]) => {
      // Mark data as flowing — resets the no-data detector's silence clock.
      lastDataAtRef.current = Date.now();
      setCurrent(readings[readings.length - 1]);

      let armed = triggerArmedRef.current;
      let threshold = triggerThresholdRef.current;
      let release = threshold !== null ? threshold * (1 - hysteresisPctRef.current / 100) : null;

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
      // because statsRef is zeroed there too: counting across a reset would commit a
      // freshly-zeroed stats object over the `null` the reset queued.
      let appended = 0;
      const flushStaged = () => {
        for (const st of staged) store.append(st.ts, st.value, st.mode, st.unit, st.decimals);
        appended += staged.length;
        staged.length = 0;
      };
      for (const r of readings) {
        const { baseValue, baseUnit } = normalizeReading(r);

        if (baseUnit !== '' && (modeRef.current !== r.mode || unitRef.current !== baseUnit)) {
          const wasInitialized = modeRef.current !== null;
          modeRef.current = r.mode;
          unitRef.current = baseUnit;
          // Display-only conversion: chartUnit feeds the chart axis, statistics, trigger
          // label and log summary, and nothing else. The raw token stays on the Reading.
          setChartUnit(displayUnit(baseUnit));
          // Keep the recorded log across a real mode change if opted in (chart/stats are
          // single-unit and always reset). The first detection has no prior data, so a
          // full flush is equivalent. Old-unit rows stay valid in their original unit.
          if (wasInitialized && preserveOnModeChangeRef.current) {
            // Samples staged before the change are old-unit rows the operator asked to keep.
            // They must reach the store BEFORE the watermark advances, or the watermark
            // lands behind them and the chart draws the previous unit.
            flushStaged();
            resetSessionDerived();
            appended = 0;
          } else {
            staged.length = 0;
            flushSession();
            appended = 0;
          }
          // A real mode/unit change makes the in-progress data and threshold
          // meaningless in the new unit — stop logging, then reset the trigger
          // (clear threshold + disarm). (Skip on the first reading, which is
          // initial detection, not a change, so a pre-typed threshold survives.)
          if (wasInitialized) {
            if (recordingRef.current) {
              recordingRef.current = false;
              recordingChanged = true;
            }
            triggerThresholdRef.current = null;
            triggerArmedRef.current = false;
            triggerStartedRef.current = false;
            armed = false;
            threshold = null;
            release = null;
            setTriggerThreshold('');
            setTriggerArmed(false);
            // The reference and every captured verdict belong to the old mode's unit —
            // neither is meaningful in the new one. Cleared for the same reason the
            // trigger threshold is.
            pfRefEntryRef.current = null;
            pfBandEntryRef.current = null;
            pfToleranceValueRef.current = null;
            pfLastCapturedRef.current = null;
            passFailRowsRef.current = [];
            pfRowIdRef.current = 0;
            newVerdicts.length = 0;
            setPfReference('');
            setPfTolerance('');
            setPfReferenceSettled('');
            setPfToleranceSettled('');
            setPassFailRows([]);
          }
        }

        // Trigger edges (evaluated before recording so the crossing sample is captured).
        const mag = baseValue !== null ? Math.abs(baseValue) : null;
        if (armed && threshold !== null && !recordingRef.current && mag !== null && mag > threshold) {
          // Clears EVERYTHING staged, chart and log alike. Previously only the chart half was
          // dropped here; see the `staged` comment above.
          staged.length = 0;
          flushSession();
          appended = 0;
          recordingRef.current = true;
          triggerStartedRef.current = true;
          recordingChanged = true;
        } else if (triggerStartedRef.current && recordingRef.current && release !== null && mag !== null && mag < release) {
          recordingRef.current = false;
          triggerStartedRef.current = false;
          recordingChanged = true;
        }

        // Capacitance has no OL on lifted probes — it reads lead stray capacitance (pF),
        // which is numeric, so without this it appends a junk near-zero row on every probe
        // lift and never clears the last-logged reference. A floor of 0 disables it.
        const noPart =
          baseValue !== null &&
          r.mode === 'CAPACITANCE' &&
          Math.abs(baseValue) < capNoPartFloorRef.current;

        // Stable-run tracking runs regardless of the recording session, because Pass/Fail
        // capture has no session of its own (its batch boundary is Clear). Behavior-
        // preserving for the Data Log: every path that STARTS recording resets these refs
        // first, so anything accumulated while idle is wiped when recording begins.
        if (baseValue === null || noPart) {
          // OL (and a capacitance no-part reading) are excluded from the filtered
          // dataset entirely — table, CSV, chart, and stats. Both are still a
          // discontinuity — reset the run and BOTH stores' last-captured references.
          runAnchorRef.current = null;
          stableRunRef.current = 0;
          lastLoggedValueRef.current = null;
          pfLastCapturedRef.current = null;
        } else {
          // Maintain the run of consecutive readings belonging to the same measurement.
          // Membership is a band around the run's anchor, not equality
          // (see STABLE_LSD_TOLERANCE in lib/parser.ts).
          const lsd = readingResolution(r);
          const anchor = runAnchorRef.current;
          if (anchor !== null && withinStableBand(baseValue, anchor, lsd)) {
            stableRunRef.current += 1;
          } else {
            stableRunRef.current = 1;
            runAnchorRef.current = baseValue;
          }
          // Capacitance needs no extra count: the meter sends "-.--" (isMeasuring) until
          // it has a number — confirmed on a 3.3 mF electrolytic — so its first digit
          // value is already settled.
          const stable = stableRunRef.current >= stabilityCountRef.current;

          // ---- Pass/Fail capture (independent of the recording session) ----------
          // An exact zero means nothing is connected, not a part measuring zero: with the
          // probes floating the meter settles on 0 in every supported mode, and a real
          // component never reads a clean 0 (a 0R link still shows lead resistance).
          // Scoped to Pass/Fail — the Data Log records a genuine 0 as a real measurement.
          const pfRefEntry = pfRefEntryRef.current;
          const pfBandEntry = pfBandEntryRef.current;
          if (baseValue === 0) {
            pfLastCapturedRef.current = null;
          } else if (
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
            const last = pfLastCapturedRef.current;
            // Gated on the stable run, same flag the live verdict uses (via currentStable),
            // so display and table never disagree. Resistance and diode need it: with no
            // "measuring" state, lifting a probe sweeps UP through intermediates and a
            // >50% step would read as a fresh part. The major-change gate suppresses drift
            // within one held part; a probe lift clears the reference for the next.
            if (isMajorChange(baseValue, last)) {
              pfLastCapturedRef.current = baseValue;
              const toBase = ENTRY_UNITS[r.mode].toBase;
              const baseReference = entryToBase(r.mode, pfRefEntry);
              const baseBand = pfBandEntry * toBase;
              newVerdicts.push({
                id: pfRowIdRef.current++,
                ts: r.ts,
                iso: new Date(r.ts).toISOString(),
                mode: r.mode,
                baseValue,
                baseReference,
                baseBand,
                toleranceMode: pfToleranceModeRef.current,
                toleranceValue: pfToleranceValueRef.current!,
                verdict: judge(baseValue, baseReference, baseBand),
                deviation: baseValue - baseReference,
              });
            }
          }

          // ---- Data Log / chart / statistics (gated on the recording session) -----
          if (recordingRef.current) {
            // Stable filter on: log only a confirmed-stable value that differs from the
            // last logged one by a major amount, suppressing drift and plateaus.
            let logSample = true;
            if (stableOnlyRef.current) {
              logSample = stable && isMajorChange(baseValue, lastLoggedValueRef.current);
              if (logSample) lastLoggedValueRef.current = baseValue;
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
                const c = (rawCounts.get(k) ?? 0) + 1;
                rawCounts.set(k, c);
                if (c > dominantCountRef.current) {
                  dominantCountRef.current = c;
                  dominantValueRef.current = k;
                }
              }
              // Everything in this block is behind the same gate, deliberately: the store,
              // the histogram counts, the recorded resolution and the statistics. Hoisting
              // any of it to the `recordingRef` level one scope out would silently disable
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
                recordedResolutionRef.current = Math.max(recordedResolutionRef.current ?? 0, lsd);
              }
              const s = statsRef.current;
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
      if (store.trim(Date.now() - RETENTION_MS)) {
        setChartEpoch((e) => e + 1);
        touched = true;
      }

      // The chart's x-axis anchor: the oldest sample the chart can actually see, read from
      // the store against the FINAL watermark rather than tracked during the batch. Stating
      // it as a derivation instead of a running candidate is what makes it immune to a
      // mid-batch watermark advance — the preserve-log mode change flushes old-unit samples
      // and THEN advances, so anything captured before that advance is the previous unit.
      //
      // Functional so it cannot race a reset earlier in this batch: that queues null first,
      // so `prev` is null here and this stamps. Cheap to evaluate every batch, and a no-op
      // once stamped.
      const anchorIdx = Math.max(0, chartFromSeqRef.current - store.firstSeq);
      if (store.count > anchorIdx) {
        const at = store.tsAt(anchorIdx);
        setSessionStart((prev) => prev ?? at);
      }

      if (touched) setSampleVersion((v) => v + 1);

      // Same batched append for the Pass/Fail store.
      if (newVerdicts.length > 0) {
        passFailRowsRef.current = [...passFailRowsRef.current, ...newVerdicts];
        setPassFailRows(passFailRowsRef.current);
        // One tone per batch (its last verdict) — a batch spans ms, a part takes seconds.
        if (verdictAudioRef.current) {
          const t = newVerdicts[newVerdicts.length - 1].verdict === 'PASS' ? PASS_TONE : FAIL_TONE;
          beeperRef.current?.beep(t.hz, t.ms);
        }
      }

      // Mirror the run state for render. After the loop the ref describes the LAST
      // reading of the batch, which is the one `current` holds.
      setCurrentStable(stableRunRef.current >= stabilityCountRef.current);

      // Commit a trigger-driven recording transition once (no per-sample setState).
      if (recordingChanged) setRecording(recordingRef.current);

      // Only when something was actually logged: statsRef mutates inside `if (logSample)`,
      // so with the stable filter on most batches change nothing and a fresh object identity
      // would re-render StatisticsPanel three times a second for nothing.
      if (appended > 0) setSessionStats({ ...statsRef.current });

      // Mirror the recorded resolution + dominant value to state. (Unchanged when
      // nothing was logged this batch — e.g. logging stopped → React bails out.)
      setRecordedResolution(recordedResolutionRef.current);
      setDominantValue(dominantValueRef.current);
    },
    [flushSession, resetSessionDerived, store, rawCounts],
  );

  const { status, error, connect, disconnect } = useSerial(handleReadings);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset recording on disconnect
    if (status !== 'connected') setRec(false);
  }, [status, setRec]);

  // No-data detector: while connected, poll for silence past NO_DATA_MS. Clock seeded on
  // connect (catches a meter that never sends anything) and reset per batch.
  useEffect(() => {
    if (status !== 'connected') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear condition when not connected
      setNoData(false);
      return;
    }
    lastDataAtRef.current = Date.now();
    const id = setInterval(() => {
      setNoData(Date.now() - lastDataAtRef.current > NO_DATA_MS);
    }, 750);
    return () => clearInterval(id);
  }, [status]);

  // Re-arm per outage: once the condition clears (data resumed or disconnected), drop
  // any prior dismissal so the next silence shows the warning again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-arm dismissal on clear
    if (!noData) setNoDataDismissed(false);
  }, [noData]);

  // Single source of truth for both the overlay and the audio: the warning is visible
  // only while enabled, the condition holds, and it hasn't been dismissed this outage.
  const overlayVisible = noDataWarning && noData && !noDataDismissed;

  useEffect(() => {
    beeperRef.current = createBeeper();
    return () => {
      beeperRef.current?.dispose();
      beeperRef.current = null;
    };
  }, []);
  // Drive the audio from the same visibility flag, gated by the audio setting — so it
  // can never sound without the overlay and stops on dismiss / data-resume / disconnect.
  useEffect(() => {
    const beeper = beeperRef.current;
    if (!beeper) return;
    if (overlayVisible && noDataAudio) beeper.start();
    else beeper.stop();
  }, [overlayVisible, noDataAudio]);

  // Clears only the verdict batch — the Data Log's recorded rows are untouched, and
  // the reference/tolerance are kept (the operator is usually still on the same part).
  const clearPassFail = useCallback(() => {
    passFailRowsRef.current = [];
    pfRowIdRef.current = 0;
    pfLastCapturedRef.current = null;
    setPassFailRows([]);
  }, []);

  const handleConnect = useCallback(() => connect(baud), [connect, baud]);
  const handleToggleRecord = useCallback(() => {
    // Manual toggle → this session is not trigger-owned, so never auto-stop it.
    triggerStartedRef.current = false;
    setRec(!recordingRef.current);
  }, [setRec]);
  const handleStableOnlyChange = useCallback((v: boolean) => {
    setStableOnly(v);
    // Enabling the filter auto-starts logging (mirrors the Record button);
    // disabling only stops filtering and leaves logging as-is.
    if (v) setRec(true);
  }, [setRec]);

  // Per-row note edit: annotation only — never touches the reading or statistics. Keyed on
  // `seq`, which survives retention trimming, so a note cannot migrate to another row. The
  // version bump is load-bearing: the note input is controlled, and with the store in a ref
  // nothing else would tell React to re-render it, so the operator would type into a field
  // that never updates.
  const handleNoteChange = useCallback((seq: number, note: string) => {
    store.setNote(seq, note);
    setSampleVersion((v) => v + 1);
  }, [store]);

  // Serializes the same canonical store the Data Log renders and the chart draws. Numeric
  // only (OL is excluded upstream), so every stored value is a real measurement.
  //
  // The value column is reconstructed in the unit the meter reported, from the stored base
  // value and digit count, so the file is unchanged from before the store existed —
  // including the mixed-unit case where auto-ranging put mV and V rows in one export.
  // `toFixed`, never `String`: a number has no memory of trailing zeros, and `0.1450` at
  // 0.1 mV resolution is a different measurement from `0.145` at 1 mV.
  const exportCsv = useCallback(() => {
    function* lines() {
      for (let i = 0; i < store.count; i++) {
        const sm = store.at(i);
        const factor = SCALE[sm.unit]?.factor ?? 1;
        yield [
          new Date(sm.ts).toISOString(),
          sm.mode,
          (sm.value / factor).toFixed(sm.decimals),
          sm.unit,
          csvEsc(sm.note),
        ].join(',');
      }
    }
    downloadCsv(csvBlob('Timestamp,Mode,Value,Unit,Notes', lines()), `multimeter-${Date.now()}.csv`);
  }, [store]);

  // Numbers in the mode's ENTRY unit (ohms/volts/farads) with the unit in its own
  // column, so the file holds plain numbers rather than SI-prefixed strings.
  const exportVerdictCsv = useCallback(() => {
    function* lines() {
      for (const row of passFailRowsRef.current) {
        const { label, toBase } = ENTRY_UNITS[row.mode];
        const tol =
          row.toleranceMode === 'percent'
            ? `${row.toleranceValue}%`
            : `\u00B1${formatEntryValue(row.toleranceValue, label)}`;
        yield [
          row.iso, row.mode, String(row.baseValue / toBase), label,
          String(row.baseReference / toBase), csvEsc(tol),
          String(row.deviation / toBase), row.verdict,
        ].join(',');
      }
    }
    downloadCsv(
      csvBlob('Timestamp,Mode,Measured,Unit,Reference,Tolerance,Deviation,Verdict', lines()),
      `multimeter-passfail-${Date.now()}.csv`,
    );
  }, []);

  // The Pass/Fail view's active mode: the live reading's mode when supported, else null
  // (which renders the unsupported-mode explanation).
  const passFailMode = current && isSupportedMode(current.mode) ? current.mode : null;

  // Stays on the statistics, NOT on store.count: statistics are session-scoped and
  // legitimately exceed the retained window past seven days, and this is deliberately 0
  // after a preserve-log reset. Reading the store here would put two differently-valued
  // tiles labelled "Samples" on one screen.
  const recordedCount = sessionStats?.count ?? 0;
  const canExport = sampleCount > 0;
  // An inverted manual range (minimum at or above maximum) describes no window at all.
  // Applying it would hand Chart.js `min > max`, which silently renders an empty or
  // upside-down axis — so it is ignored and auto-scaling continues, and Controls says so
  // instead of leaving the operator to wonder why their numbers did nothing.
  const rangeMinNum = toFinite(rangeMin);
  const rangeMaxNum = toFinite(rangeMax);
  const rangeInvalid =
    !autoScale && rangeMinNum !== null && rangeMaxNum !== null && rangeMinNum >= rangeMaxNum;
  const effectiveYMin = autoScale || rangeInvalid ? undefined : (rangeMinNum ?? undefined);
  const effectiveYMax = autoScale || rangeInvalid ? undefined : (rangeMaxNum ?? undefined);
  // Histogram bin width + stat decimals. With data present, use the frozen coarsest
  // recorded resolution so both stay stable when logging stops and the live value
  // auto-ranges or goes OL; when empty, derive from the live reading as a preview.
  const liveNumeric = current && normalizeReading(current).baseValue !== null ? current : null;
  // Samples the CHART can see — everything at or after the watermark. Deliberately not
  // `sampleCount`: after a preserve-log mode change the store still holds the previous
  // unit's rows while `recordedResolution` and `dominantValue` have just been nulled, so
  // gating on the store would resolve both to `undefined` and silently switch the histogram
  // off the LSD grid, switch off the ±20 LSD y-axis floor, and drop statDecimals to a
  // 3-decimal fallback in both panels.
  const chartCount = Math.max(0, store.count - (chartFromSeq - store.firstSeq));
  const binWidth =
    chartCount > 0
      ? (recordedResolution ?? undefined)
      : (liveNumeric ? (readingResolution(liveNumeric) ?? undefined) : undefined);
  // Histogram window center: the time-dominant recorded value when data is present
  // (outliers fall into under/over-range bins), else the live reading for preview.
  const centerValue =
    chartCount > 0
      ? (dominantValue ?? undefined)
      : (liveNumeric ? (normalizeReading(liveNumeric).baseValue ?? undefined) : undefined);
  // Measurement resolution as decimal places (1 Ω → 0, 0.0001 V → 4) for stat formatting.
  const statDecimals = binWidth !== undefined ? resolutionDecimals(binWidth) : undefined;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* ── Header ── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-canvas px-5">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
          </svg>
          <span className="text-sm font-semibold text-fg">Multimeter Visualizer</span>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2 text-sm">
          <span className={clsx('h-2 w-2 rounded-full', STATUS_DOT[status])} />
          <span className={status === 'connected' ? 'text-success' : 'text-muted'}>
            {STATUS_LABEL[status]}
          </span>
          {status === 'connected' && (
            <span className="text-muted">
              UART &nbsp;·&nbsp; {baud} bps
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface hover:text-fg">
            <MoreVertical size={14} />
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {/* Left sidebar */}
        <Sidebar
          status={status}
          baud={baud}
          onBaudChange={setBaud}
          onConnect={handleConnect}
          onDisconnect={disconnect}
          error={error}
          active={view}
          onNavChange={navigate}
        />

        {view === 'dashboard' ? (
          <>
            {/* Main content */}
            <main className="min-w-0 flex-1 overflow-y-auto p-5">
              <div className="flex flex-col gap-4">
                <DigitalDisplay
                  reading={current}
                  recording={recording}
                  sampleCount={recordedCount}
                />
                <RealtimeChart
                  store={store}
                  sampleVersion={sampleVersion}
                  chartFromSeq={chartFromSeq}
                  chartEpoch={chartEpoch}
                  counts={rawCounts}
                  stableOnly={stableOnly}
                  sessionStart={sessionStart}
                  unit={chartUnit}
                  yMin={effectiveYMin}
                  yMax={effectiveYMax}
                  timeRange={timeRange}
                  onTimeRangeChange={setTimeRange}
                  binWidth={binWidth}
                  centerValue={centerValue}
                />
                <StatisticsPanel stats={sessionStats} unit={chartUnit} decimals={statDecimals} />
              </div>
            </main>

            {/* Right panel */}
            <Controls
              rangeMin={rangeMin}
            rangeInvalid={rangeInvalid}
              rangeMax={rangeMax}
              onRangeMinChange={setRangeMin}
              onRangeMaxChange={setRangeMax}
              autoScale={autoScale}
              onAutoScaleChange={setAutoScale}
              triggerThreshold={triggerThreshold}
              onTriggerThresholdChange={setTriggerThreshold}
              triggerArmed={triggerArmed}
              onTriggerArmedChange={setTriggerArmed}
              canArm={(toFinite(triggerThreshold) ?? 0) > 0 && status === 'connected'}
              triggerUnit={chartUnit}
              recording={recording}
              onToggleRecord={handleToggleRecord}
              canRecord={status === 'connected'}
              stableOnly={stableOnly}
              onStableOnlyChange={handleStableOnlyChange}
              onClear={flushSession}
            canClear={sampleCount > 0}
              onExportCsv={exportCsv}
              canExport={canExport}
            />
          </>
        ) : view === 'data-log' ? (
          <DataLog
            reading={current}
            recording={recording}
            store={store}
            sampleVersion={sampleVersion}
            stats={sessionStats}
            unit={chartUnit}
            decimals={statDecimals}
            canRecord={status === 'connected'}
            onExportCsv={exportCsv}
            onToggleRecord={handleToggleRecord}
            onClear={flushSession}
            onNoteChange={handleNoteChange}
          />
        ) : view === 'pass-fail' ? (
          <PassFail
            reading={current}
            stable={currentStable}
            mode={passFailMode}
            reference={pfReference}
            onReferenceChange={setPfReference}
            referenceSettled={pfReferenceSettled}
            tolerance={pfTolerance}
            onToleranceChange={setPfTolerance}
            toleranceSettled={pfToleranceSettled}
            toleranceMode={pfToleranceMode}
            onToleranceModeChange={setPfToleranceMode}
            rows={passFailRows}
            onClear={clearPassFail}
            onExportCsv={exportVerdictCsv}
          />
        ) : (
          <Settings
            stabilityCount={stabilityCount}
            onStabilityCountChange={setStabilityCount}
            hysteresisPct={hysteresisPct}
            onHysteresisPctChange={setHysteresisPct}
            preserveOnModeChange={preserveOnModeChange}
            onPreserveOnModeChangeChange={setPreserveOnModeChange}
            noDataWarning={noDataWarning}
            onNoDataWarningChange={setNoDataWarning}
            noDataAudio={noDataAudio}
            onNoDataAudioChange={setNoDataAudio}
            capNoPartFloor={capNoPartFloor}
            onCapNoPartFloorChange={setCapNoPartFloor}
            verdictAudio={verdictAudio}
            onVerdictAudioChange={setVerdictAudio}
          />
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="flex h-8 shrink-0 items-center justify-center border-t border-border">
        <p className="text-xs text-muted">
          Multimeter Visualizer v{APP_VERSION} &nbsp;·&nbsp; Built for precision.
        </p>
      </footer>

      {/* Connected-but-no-data warning — overlays every view; informational only. */}
      {overlayVisible && <NoDataWarning onDismiss={() => setNoDataDismissed(true)} />}
    </div>
  );
}
