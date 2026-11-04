'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Moon, Sun } from 'lucide-react';
import { DigitalDisplay } from '@/components/DigitalDisplay';
import { RealtimeChart, nextChartType, type ChartType, type Theme } from '@/components/RealtimeChart';
import { Controls, PanelStrip, RecordButton } from '@/components/Controls';
import { Sidebar, NAV_IDS, type NavId } from '@/components/Sidebar';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { DataLog } from '@/components/DataLog';
import { Settings } from '@/components/Settings';
import { NoDataWarning } from '@/components/NoDataWarning';
import { PassFail } from '@/components/PassFail';
import { History } from '@/components/History';
import { ShortcutHelp } from '@/components/ShortcutHelp';
import { ClearConfirm, SaveIndicator, SessionConfirm, SessionNotices } from '@/components/SessionNotices';
import {
  displayUnit, normalizeReading, readingResolution, type Reading,
} from '@/lib/parser';
import { SampleStore } from '@/lib/samples';
import { CaptureEngine, type RestoreResult, type SessionStats } from '@/lib/capture';
import {
  VERDICT_CSV_HEADER, isSupportedMode, parseEntry, verdictCsvLine,
  type ToleranceMode, type VerdictRow,
} from '@/lib/passfail';
import { useSerial } from '@/lib/useSerial';
import { useBle } from '@/lib/useBle';
import { useShortcuts } from '@/lib/useShortcuts';
import { useLiveTitle } from '@/lib/useLiveTitle';
import { useSessionPersistence } from '@/lib/useSessionPersistence';
import { SessionPersister, type SaveStatus } from '@/lib/sessionPersister';
import { isBusy, type ConnectionStatus, type Transport } from '@/lib/connection';
import {
  DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings as SettingValues,
} from '@/lib/settings';
import { createBeeper, type Beeper } from '@/lib/beep';
import { SAMPLE_CSV_HEADER, csvBlob, downloadCsv, sampleCsvLines } from '@/lib/csv';
// App version — single source of truth is package.json "version". Bump it on every
// change (see AGENTS.md "Versioning") so the footer reflects what's deployed.
import { version as APP_VERSION } from '@/package.json';

// Connected-but-silent threshold: if the port is connected but no reading has arrived
// for this long, the no-data warning condition is active (the ZT703s streams
// continuously, so 3 s of silence is clearly abnormal — meter off / lead broken).
const NO_DATA_MS = 3000;
// How long Clear waits for the session to be saved complete before clearing anyway.
const CLEAR_SAVE_MS = 2000;
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

// An inverted manual range (minimum at or above maximum) describes no window at all. Applying it
// would hand Chart.js `min > max`, which silently renders an empty or upside-down axis — so it is
// ignored and auto-scaling continues, and Controls says so instead of leaving the operator to
// wonder why their numbers did nothing.
function resolveRange(autoScale: boolean, min: string, max: string) {
  const lo = toFinite(min);
  const hi = toFinite(max);
  const rangeInvalid = !autoScale && lo !== null && hi !== null && lo >= hi;
  const manual = !autoScale && !rangeInvalid;
  return { rangeInvalid, yMin: manual ? (lo ?? undefined) : undefined, yMax: manual ? (hi ?? undefined) : undefined };
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  unsupported: 'Unsupported',
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connected: 'bg-success',
  connecting: 'animate-pulse bg-amber',
  disconnected: 'bg-muted',
  unsupported: 'bg-muted',
};

// At most one transport holds the slot. The combined status is the active one's; with
// none active it is `unsupported` only when neither transport is supported.
function resolveConnection(
  uart: ConnectionStatus, ble: ConnectionStatus, baud: number, deviceName: string | null,
) {
  const active: Transport | null = isBusy(ble) ? 'ble' : isBusy(uart) ? 'uart' : null;
  if (active === 'ble') return { active, status: ble, detail: `BLE · ${deviceName}` };
  const status: ConnectionStatus = uart === 'unsupported' && ble !== 'unsupported' ? 'disconnected' : uart;
  return { active, status, detail: `UART · ${baud} bps` };
}

// Guards each Connect against the other transport, closing a click that lands before the
// other's busy state has rendered (the disabled button alone would not). Starting one also
// clears the other's last error, which is stale once the operator has moved on.
function unlessBusy(other: ConnectionStatus, clearOther: () => void, connect: () => unknown) {
  if (isBusy(other)) return;
  clearOther();
  void connect();
}

function AppHeader({ status, detail, saveStatus, theme, onToggleTheme, connectionOpen, onOpenConnection }: {
  status: ConnectionStatus; detail: string; saveStatus: SaveStatus; theme: Theme; onToggleTheme: () => void;
  connectionOpen: boolean; onOpenConnection: () => void;
}) {
  const connected = status === 'connected';
  // Built once, placed twice: inline at lg (as before), and below lg inside the button
  // that opens the Connection drawer, where a long device name truncates visually but
  // stays whole in the accessible name.
  const statusContent = (
    <>
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} />
      <span className={connected ? 'text-success' : 'text-muted'}>{STATUS_LABEL[status]}</span>
      {connected && <span className="truncate text-muted">{detail}</span>}
    </>
  );
  // Names the theme a click switches TO.
  const themeWord = theme === 'dark' ? 'Light' : 'Dark';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-canvas px-5 max-lg:gap-3 max-sm:px-3">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
        </svg>
        <span className="hidden text-sm font-semibold text-fg sm:inline">Multimeter Visualizer</span>
      </div>

      {/* Connection status */}
      <div className="hidden items-center gap-2 text-sm lg:flex">{statusContent}</div>
      <button
        onClick={onOpenConnection}
        aria-expanded={connectionOpen}
        aria-label={`Connection: ${STATUS_LABEL[status]}${connected ? `, ${detail}` : ''}`}
        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-surface lg:hidden"
      >
        {statusContent}
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <SaveIndicator status={saveStatus} />
        <button
          onClick={onToggleTheme}
          aria-label={themeWord}
          className="flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-muted transition-colors hover:bg-surface hover:text-fg max-lg:px-2"
        >
          <span className="lg:hidden">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</span>
          <span className="hidden lg:inline">{themeWord}</span>
        </button>
      </div>
    </header>
  );
}

export default function Home() {
  // Persisted settings. Start at defaults so the static-export HTML matches the first
  // client render; a mount effect then hydrates from storage.
  const [settings, setSettings] = useState<SettingValues>(DEFAULT_SETTINGS);
  const updateSettings = useCallback(
    (patch: Partial<SettingValues>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  const {
    baud, rangeMin, rangeMax, autoScale, timeRange, stableOnly, stabilityCount, hysteresisPct,
    preserveOnModeChange, noDataWarning, noDataAudio, capNoPartFloor, verdictAudio,
  } = settings;
  // Starts 'dark' to match the static HTML; the mount effect reads what the pre-paint
  // script in layout.tsx already applied, so storage is read only there.
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot hydration
    if (document.documentElement.dataset.theme === 'light') setTheme('light');
  }, []);
  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem('multimeter-live:theme', next); } catch { /* still applies this page */ }
    setTheme(next);
  }, [theme]);
  // The active view. Stays 'dashboard' for the first render so it matches the statically
  // exported HTML; the URL hash takes over in the mount effect below.
  const [view, setView] = useState<NavId>('dashboard');
  // The open drawer below lg: a view's own panel (open while it equals `view`, so any view
  // change closes it) or the header's Connection card. One value, so only one is open.
  const [sheet, setSheet] = useState<NavId | 'connection' | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const [current, setCurrent] = useState<Reading | null>(null);
  // Whether `current` has been confirmed stable. The capture engine owns the run counter;
  // this is its render-visible mirror, committed once per batch. Pass/Fail needs
  // it because a resistance reading sweeps through intermediate values as the probe is
  // lifted, and comparing those produces a spurious FAIL.
  const [currentStable, setCurrentStable] = useState(false);
  const [recording, setRecording] = useState(false);
  // Page state, not the chart's: the H shortcut changes it, and it survives a view switch.
  const [chartType, setChartType] = useState<ChartType>('line');
  const [showHelp, setShowHelp] = useState(false);
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
  const [triggerArmed, setTriggerArmed] = useState(false);
  const [triggerThreshold, setTriggerThreshold] = useState('');
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

  // The durable copy of the session; see lib/sessionPersister.ts. Reads from the engine and store
  // behind the scenes — the page only feeds it `tick`/dirty marks and drives Restore/Discard.
  const [persister] = useState<SessionPersister>(() => new SessionPersister(store, engine));

  const verdictAudioRef = useRef(verdictAudio);
  // One beeper for the component's life; created client-side, disposed on unmount.
  // Declared here rather than beside its effect because handleReadings (defined below)
  // sounds verdict tones through it.
  const beeperRef = useRef<Beeper | null>(null);

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
    // Reads the SETTLED values, never the raw inputs.
    const { ref, tol, band } = parseEntry(pfReferenceSettled, pfToleranceSettled, pfToleranceMode);
    engine.setPassFailConfig(ref, tol, band, pfToleranceMode);
  }, [engine, pfReferenceSettled, pfToleranceSettled, pfToleranceMode]);

  // One-shot hydration from localStorage. setState-in-effect is intentional: the first
  // render must use defaults to match the static-export HTML. Restoring is deliberately
  // inert: no setting starts logging, arms the trigger, or opens a port.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot hydration
    setSettings(loadSettings());
  }, []);

  // Persist on change. Skip the first invocation (mount, still defaults) so we don't
  // clobber stored values before the hydration effect above has applied them.
  const persistReadyRef = useRef(false);
  useEffect(() => {
    if (!persistReadyRef.current) { persistReadyRef.current = true; return; }
    saveSettings(settings);
  }, [settings]);

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
    const sync = () => {
      setView(fromHash());
      setSheet(null);
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // The store is mutated in place, so `sampleVersion` is what re-renders this component; the
  // reads themselves are plain and re-evaluate on every render.
  void sampleVersion;
  const sampleCount = store.count;
  const hasRows = sampleCount > 0 || passFailRows.length > 0;

  // Navigation is presentational only: it never touches logging, the trigger, or the port.
  // pushState (not location.hash =) so each view becomes its own history entry AND no
  // hashchange event fires — the listener above is left for Back/Forward and manual edits.
  const navigate = useCallback((id: NavId) => {
    setView(id);
    setSheet(null);
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

  // After `engine.flush()` outside `ingest`. The saved copy ends the session now, not at the next
  // 5 s tick.
  const commitFlush = useCallback(() => {
    setSampleVersion((v) => v + 1);
    commitReset();
    persister.requestFlush();
  }, [commitReset, persister]);

  const setRec = useCallback((v: boolean, manual = false) => {
    if (engine.setRecording(v, manual)) commitFlush();
    setRecording(v);
  }, [engine, commitFlush]);

  // Clear Data / Clear Log only ask; the confirm is the full session flush: the canonical store
  // AND every derived projection.
  const [confirmClear, setConfirmClear] = useState(false);
  const requestClear = useCallback(() => setConfirmClear(true), []);
  const cancelClear = useCallback(() => setConfirmClear(false), []);
  // Saved complete first, so History holds every sample up to the confirmation; bounded, so a
  // hung storage cannot hang Clear.
  const confirmFlush = useCallback(async () => {
    setConfirmClear(false);
    await Promise.race([persister.saveNow(), new Promise((r) => setTimeout(r, CLEAR_SAVE_MS))]);
    engine.flush();
    commitFlush();
  }, [engine, persister, commitFlush]);

  // The operator-typed trigger and Pass/Fail entry belong to the live session's mode: cleared on
  // a mode change and on a restore.
  const resetEntryFields = useCallback(() => {
    setTriggerThreshold('');
    setTriggerArmed(false);
    setPfReference('');
    setPfTolerance('');
    setPfReferenceSettled('');
    setPfToleranceSettled('');
  }, []);

  // Everything one batch changes in React state, committed once. Separate from `handleReadings` so
  // a restore can hold batches and replay them here afterwards.
  const ingestBatch = useCallback(
    (readings: Reading[]) => {
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
      if (r.modeReset) resetEntryFields();
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

      persister.tick(); // cheap; the write itself happens outside this call
    },
    [engine, commitReset, resetEntryFields, persister],
  );

  // Everything a restore changed, committed once like a `BatchResult`.
  const commitRestore = useCallback((res: RestoreResult) => {
    setSampleVersion((v) => v + 1);
    setChartFromSeq(res.chartFromSeq);
    setChartEpoch((e) => e + 1);
    setSessionStats(res.stats);
    setSessionStart(res.sessionStart);
    setRecordedResolution(res.recordedResolution);
    setDominantValue(res.dominantValue);
    setChartUnit(displayUnit(res.unit));
    setChartBaseUnit(res.unit);
    setPassFailRows(res.verdicts);
    setRecording(false);
    resetEntryFields();
  }, [resetEntryFields]);

  const { status: saveStatus, previous, historyRev, restore } =
    useSessionPersistence(persister, hasRows, commitRestore, ingestBatch);
  const feedReadings = restore.feed;

  const handleReadings = useCallback(
    (readings: Reading[]) => {
      // Mark data as flowing — resets the no-data detector's silence clock.
      lastDataAtRef.current = Date.now();
      setCurrent(readings[readings.length - 1]);
      feedReadings(readings);
    },
    [feedReadings],
  );

  const serial = useSerial(handleReadings);
  const ble = useBle(handleReadings);
  const { active, status, detail } = resolveConnection(serial.status, ble.status, baud, ble.deviceName);

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

  useLiveTitle(current, status === 'connected', noData);

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
    persister.requestFlush();
  }, [engine, persister]);

  const { connect: serialConnect, clearError: clearSerialError } = serial;
  const { connect: bleConnect, clearError: clearBleError } = ble;
  const handleConnect = useCallback(
    () => unlessBusy(ble.status, clearBleError, () => serialConnect(baud)),
    [ble.status, clearBleError, serialConnect, baud],
  );
  const handleBleConnect = useCallback(
    () => unlessBusy(serial.status, clearSerialError, bleConnect),
    [serial.status, clearSerialError, bleConnect],
  );
  const handleToggleRecord = useCallback(() => {
    // Manual toggle → this session is not trigger-owned, so never auto-stop it.
    setRec(!engine.recording, true);
  }, [engine, setRec]);
  useShortcuts({
    view,
    recording,
    connected: status === 'connected',
    toggleRecord: handleToggleRecord,
    goTo: (i) => navigate(NAV_IDS[i]),
    toggleChart: () => setChartType((t) => nextChartType(t, stableOnly)),
    openHelp: () => setShowHelp(true),
  });
  const handleStableOnlyChange = useCallback((v: boolean) => {
    updateSettings({ stableOnly: v });
    // Enabling the filter auto-starts logging (mirrors the Record button);
    // disabling only stops filtering and leaves logging as-is.
    if (v) setRec(true);
  }, [setRec, updateSettings]);

  // Per-row note edit: annotation only — never touches the reading or statistics. Keyed on
  // `seq`, which survives retention trimming, so a note cannot migrate to another row. The
  // version bump is load-bearing: the note input is controlled, and with the store in a ref
  // nothing else would tell React to re-render it, so the operator would type into a field
  // that never updates.
  const handleNoteChange = useCallback((seq: number, note: string) => {
    store.setNote(seq, note);
    persister.markNotesDirty();
    setSampleVersion((v) => v + 1);
  }, [store, persister]);

  const exportCsv = useCallback(() => {
    downloadCsv(csvBlob(SAMPLE_CSV_HEADER, sampleCsvLines(store)), `multimeter-${Date.now()}.csv`);
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
  // What the Clear and Restore dialogs promise about the live session.
  const keepLive = persister.willKeep({ count: sampleCount, verdicts: passFailRows.length, notes: store.noteCount });
  const canExport = sampleCount > 0;
  const { rangeInvalid, yMin: effectiveYMin, yMax: effectiveYMax } = resolveRange(autoScale, rangeMin, rangeMax);
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
    <div className="flex h-dvh flex-col bg-canvas">
      <AppHeader
        status={status}
        detail={detail}
        saveStatus={saveStatus}
        theme={theme}
        onToggleTheme={toggleTheme}
        connectionOpen={sheet === 'connection'}
        onOpenConnection={() => setSheet('connection')}
      />

      <SessionNotices
        previous={previous}
        deferred={restore.deferred}
        status={saveStatus}
        restoring={restore.restoring}
        restoreError={restore.error}
        onRestore={restore.request}
        onLater={restore.defer}
        onDiscard={restore.discard}
        onDismissError={restore.dismissError}
      />

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 max-sm:flex-col-reverse">
        {/* Left sidebar */}
        <Sidebar
          uart={{ status: serial.status, error: serial.error, connect: handleConnect, disconnect: serial.disconnect }}
          ble={{ status: ble.status, error: ble.error, connect: handleBleConnect, disconnect: ble.disconnect }}
          baud={baud}
          onBaudChange={(v) => updateSettings({ baud: v })}
          deviceName={ble.deviceName}
          activeTransport={active}
          active={view}
          onNavChange={navigate}
          connectionOpen={sheet === 'connection'}
          onConnectionClose={closeSheet}
        />

        {view === 'dashboard' ? (
          <>
            {/* Main content */}
            <main tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-5 focus:outline-none">
              <div className="flex flex-col gap-4">
                <DigitalDisplay
                  reading={current}
                  recording={recording}
                  sampleCount={recordedCount}
                />
                <PanelStrip label="Controls" expanded={sheet === 'dashboard'} onOpen={() => setSheet('dashboard')}>
                  <RecordButton recording={recording} canRecord={status === 'connected'} onToggle={handleToggleRecord} />
                </PanelStrip>
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
                  onTimeRangeChange={(v) => updateSettings({ timeRange: v })}
                  chartType={chartType}
                  onChartTypeChange={setChartType}
                  binWidth={binWidth}
                  centerValue={centerValue}
                  theme={theme}
                />
                <StatisticsPanel stats={sessionStats} baseUnit={chartBaseUnit} resolution={binWidth} />
              </div>
            </main>

            {/* Right panel */}
            <Controls
              rangeMin={rangeMin}
              rangeMax={rangeMax}
              rangeInvalid={rangeInvalid}
              onRangeMinChange={(v) => updateSettings({ rangeMin: v })}
              onRangeMaxChange={(v) => updateSettings({ rangeMax: v })}
              autoScale={autoScale}
              onAutoScaleChange={(v) => updateSettings({ autoScale: v })}
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
              open={sheet === 'dashboard'}
              onClose={closeSheet}
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
            panelOpen={sheet === 'data-log'}
            onOpenPanel={() => setSheet('data-log')}
            onClosePanel={closeSheet}
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
            panelOpen={sheet === 'pass-fail'}
            onOpenPanel={() => setSheet('pass-fail')}
            onClosePanel={closeSheet}
          />
        ) : view === 'history' ? (
          <History persister={persister} status={saveStatus} historyRev={historyRev}
            restoring={restore.restoring} onRestore={restore.request} onNavigate={navigate} />
        ) : (
          <Settings settings={settings} onChange={updateSettings} />
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="hidden h-8 shrink-0 lg:flex items-center justify-center border-t border-border">
        <p className="text-xs text-muted">
          Multimeter Visualizer v{APP_VERSION} &nbsp;·&nbsp; Built for precision.
        </p>
      </footer>

      {/* Connected-but-no-data warning — overlays every view; informational only. */}
      {overlayVisible && <NoDataWarning transport={active} onDismiss={() => setNoDataDismissed(true)} />}
      <ShortcutHelp open={showHelp} onClose={() => setShowHelp(false)} />
      {confirmClear && (
        <ClearConfirm samples={sampleCount} keep={keepLive} onConfirm={confirmFlush} onCancel={cancelClear} />
      )}
      <SessionConfirm
        pending={restore.pending}
        samples={sampleCount}
        verdictRows={passFailRows.length}
        keep={keepLive}
        onConfirm={restore.confirm}
        onCancel={restore.cancel}
      />
    </div>
  );
}
