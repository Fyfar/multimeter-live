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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PassFail } from '@/components/PassFail';
import {
  SCALE, displayUnit, normalizeReading, readingResolution, type Reading,
} from '@/lib/parser';
import { SampleStore } from '@/lib/samples';
import { CaptureEngine, type SessionStats } from '@/lib/capture';
import {
  VERDICT_CSV_HEADER, isSupportedMode, parseSiValue, resolveAbsoluteTolerance, resolveBand,
  verdictCsvLine, type ToleranceMode, type VerdictRow,
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
const downloadCsv = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};
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
  // Whether `current` has been confirmed stable. The capture engine owns the run counter;
  // this is its render-visible mirror, committed once per batch. Pass/Fail needs
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
  // The raw SCALE token behind `chartUnit` ('OM'/'V'/'A'/'nF') — StatisticsPanel and the
  // chart's y-axis need this, not the display string, so each value/tick can pick its own
  // SI prefix and apply the capacitance nF->F correction themselves (lib/si.ts).
  const [chartBaseUnit, setChartBaseUnit] = useState('');
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
  // Render mirror of `engine.passFailRows`, committed once per batch.
  const [passFailRows, setPassFailRows] = useState<VerdictRow[]>([]);
  // No-data warning: `noData` = connected-but-silent; `noDataDismissed` = OK'd for the
  // current outage (re-armed when it clears). `lastDataAtRef` is the detector's clock.
  const [noData, setNoData] = useState(false);
  const [noDataDismissed, setNoDataDismissed] = useState(false);
  const lastDataAtRef = useRef(0);
  // Mirror of the engine's recorded resolution for render (histogram bin width + stat
  // decimals); the engine is the loop-side source, this state is its render-safe copy per batch.
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

  // Everything the read loop reads and writes synchronously lives here, out of React; see
  // lib/capture.ts. Same lazy-initializer reasoning as the store above.
  const [engine] = useState<CaptureEngine>(() => new CaptureEngine(store));
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);

  const autoScaleRef = useRef(autoScale);
  // Mirror of timeRange read synchronously in the async read loop (skip cap in 'all').
  const timeRangeRef = useRef(timeRange);
  const verdictAudioRef = useRef(verdictAudio);
  // One beeper for the component's life; created client-side, disposed on unmount.
  // Declared here rather than beside its effect because handleReadings (defined below)
  // sounds verdict tones through it.
  const beeperRef = useRef<Beeper | null>(null);

  const setRec = useCallback((v: boolean, manual = false) => {
    engine.setRecording(v, manual);
    setRecording(v);
  }, [engine]);

  useEffect(() => { autoScaleRef.current = autoScale; }, [autoScale]);
  useEffect(() => { timeRangeRef.current = timeRange; }, [timeRange]);
  useEffect(() => { engine.setTriggerArmed(triggerArmed); }, [engine, triggerArmed]);
  useEffect(() => { engine.setTriggerThreshold(toFinite(triggerThreshold)); }, [engine, triggerThreshold]);
  useEffect(() => {
    engine.configure({ stabilityCount, hysteresisPct, stableOnly, preserveOnModeChange, capNoPartFloor });
  }, [engine, stabilityCount, hysteresisPct, stableOnly, preserveOnModeChange, capNoPartFloor]);
  useEffect(() => { verdictAudioRef.current = verdictAudio; }, [verdictAudio]);
  // Pass/Fail captures, counts and sounds only on its own view; see setPassFailActive.
  useEffect(() => { engine.setPassFailActive(view === 'pass-fail'); }, [engine, view]);
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
    engine.setPassFailConfig(
      ref,
      tol,
      ref !== null && tol !== null ? resolveBand(ref, tol, pfToleranceMode) : null,
      pfToleranceMode,
    );
  }, [engine, pfReferenceSettled, pfToleranceSettled, pfToleranceMode]);

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

  // The React half of the engine's derived reset: the watermark it moved, the chart's
  // invalidation, and every render mirror of what it zeroed.
  const commitReset = useCallback(() => {
    setChartFromSeq(engine.chartFromSeq);
    setChartEpoch((e) => e + 1);
    setSessionStats(null);
    setSessionStart(null);
    setRecordedResolution(null);
    setDominantValue(null);
  }, [engine]);

  // Full session flush: clear the canonical store AND every derived projection.
  const flushSession = useCallback(() => {
    engine.flush();
    setSampleVersion((v) => v + 1);
    commitReset();
  }, [engine, commitReset]);

  // Clear Data / Clear Log only ask; the flush happens on confirm.
  const [confirmClear, setConfirmClear] = useState(false);
  const requestClear = useCallback(() => setConfirmClear(true), []);
  const cancelClear = useCallback(() => setConfirmClear(false), []);
  const confirmFlush = useCallback(() => {
    flushSession();
    setConfirmClear(false);
  }, [flushSession]);

  const handleReadings = useCallback(
    (readings: Reading[]) => {
      // Mark data as flowing — resets the no-data detector's silence clock.
      lastDataAtRef.current = Date.now();
      setCurrent(readings[readings.length - 1]);

      const r = engine.ingest(readings);

      // Order matters: a reset's nulls must land before this batch's stats and session-start
      // updater, or a cleared session keeps its old anchor and statistics.
      if (r.unit !== null) {
        // Display-only conversion: chartUnit feeds the trigger label; chartBaseUnit feeds
        // the chart axis and statistics, which each derive their own display/SI prefix
        // from the raw token. Neither touches the Reading's own raw unit.
        setChartUnit(displayUnit(r.unit));
        setChartBaseUnit(r.unit);
      }
      if (r.modeReset) {
        setTriggerThreshold('');
        setTriggerArmed(false);
        setPfReference('');
        setPfTolerance('');
        setPfReferenceSettled('');
        setPfToleranceSettled('');
      }
      if (r.reset) commitReset();
      if (r.trimmed) setChartEpoch((e) => e + 1);

      // Functional so it cannot race a reset earlier in this batch: that queues null first,
      // so `prev` is null here and this stamps. Cheap to evaluate every batch, and a no-op
      // once stamped.
      if (r.sessionStart !== null) {
        const at = r.sessionStart;
        setSessionStart((prev) => prev ?? at);
      }

      if (r.touched) setSampleVersion((v) => v + 1);

      if (r.rowsChanged) setPassFailRows(engine.passFailRows);
      // One tone per batch (its last verdict) — a batch spans ms, a part takes seconds.
      if (r.verdicts.length > 0 && verdictAudioRef.current) {
        const t = r.verdicts[r.verdicts.length - 1].verdict === 'PASS' ? PASS_TONE : FAIL_TONE;
        beeperRef.current?.beep(t.hz, t.ms);
      }

      setCurrentStable(r.currentStable);

      // Commit a trigger-driven recording transition once (no per-sample setState).
      if (r.recordingChanged) setRecording(engine.recording);

      if (r.stats !== null) setSessionStats(r.stats);

      // Mirror the recorded resolution + dominant value to state. (Unchanged when
      // nothing was logged this batch — e.g. logging stopped → React bails out.)
      setRecordedResolution(r.recordedResolution);
      setDominantValue(r.dominantValue);
    },
    [engine, commitReset],
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

  // Clears only the verdict batch; see `CaptureEngine.clearVerdicts` for why the capture
  // latch is deliberately left alone.
  const clearPassFail = useCallback(() => {
    engine.clearVerdicts();
    setPassFailRows(engine.passFailRows);
  }, [engine]);

  const handleConnect = useCallback(() => connect(baud), [connect, baud]);
  const handleToggleRecord = useCallback(() => {
    // Manual toggle → this session is not trigger-owned, so never auto-stop it.
    setRec(!engine.recording, true);
  }, [engine, setRec]);
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

  // Same unit convention as the Data Log export: the meter's own unit token per row.
  const exportVerdictCsv = useCallback(() => {
    function* lines() {
      for (const row of engine.passFailRows) yield verdictCsvLine(row);
    }
    downloadCsv(csvBlob(VERDICT_CSV_HEADER, lines()), `multimeter-passfail-${Date.now()}.csv`);
  }, [engine]);

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
  // off the LSD grid, switch off the ±20 LSD y-axis floor, and drop the Statistics panels'
  // resolution-derived decimals to their 3-decimal fallback.
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
                  counts={engine.counts}
                  stableOnly={stableOnly}
                  sessionStart={sessionStart}
                  unit={chartBaseUnit}
                  yMin={effectiveYMin}
                  yMax={effectiveYMax}
                  timeRange={timeRange}
                  onTimeRangeChange={setTimeRange}
                  binWidth={binWidth}
                  centerValue={centerValue}
                />
                <StatisticsPanel stats={sessionStats} baseUnit={chartBaseUnit} resolution={binWidth} />
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
              onClear={requestClear}
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
            baseUnit={chartBaseUnit}
            resolution={binWidth}
            canRecord={status === 'connected'}
            onExportCsv={exportCsv}
            onToggleRecord={handleToggleRecord}
            onClear={requestClear}
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
      {confirmClear && (
        <ConfirmDialog
          title="Clear all recorded data?"
          body={
            <p>
              This permanently removes{' '}
              <strong className="text-fg">{sampleCount.toLocaleString()} recorded samples</strong>{' '}
              from the chart, statistics and Data Log. It cannot be undone. Export a CSV first
              if you need them.
            </p>
          }
          confirmLabel="Clear data"
          onConfirm={confirmFlush}
          onCancel={cancelClear}
        />
      )}
    </div>
  );
}
