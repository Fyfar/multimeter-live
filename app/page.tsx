'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { DigitalDisplay } from '@/components/DigitalDisplay';
import { RealtimeChart, type ChartPoint, type TimeRange } from '@/components/RealtimeChart';
import { Controls } from '@/components/Controls';
import { Sidebar, type NavId } from '@/components/Sidebar';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { DataLog, type LoggedRow } from '@/components/DataLog';
import { normalizeReading, readingResolution, resolutionDecimals, type Reading } from '@/lib/parser';
import { useSerial, type SerialStatus } from '@/lib/useSerial';
// App version — single source of truth is package.json "version". Bump it on every
// change (see AGENTS.md "Versioning") so the footer reflects what's deployed.
import { version as APP_VERSION } from '@/package.json';

const MAX_CHART_POINTS = 3600;
// Trigger auto-stop releases at RELEASE_RATIO × threshold (hysteresis dead-band)
// so a signal hovering at the threshold doesn't flap logging on and off.
const RELEASE_RATIO = 0.9;
// Stable-only logging: after a settled value is logged, the next stable value is
// logged only once it differs from the last logged value by at least this
// fraction (50%). This ignores small drift (e.g. ±1 LSD) and captures only major
// changes. NOTE: a relative gate is very sensitive near zero (0.0001→0.0002 is
// +100%); add an absolute floor here if that proves noisy in practice.
const MAJOR_CHANGE_RATIO = 0.5;

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
  const [baud, setBaud] = useState(115200);
  const [view, setView] = useState<NavId>('dashboard');
  const [current, setCurrent] = useState<Reading | null>(null);
  const [recording, setRecording] = useState(false);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [chartUnit, setChartUnit] = useState('');
  const [rangeMin, setRangeMin] = useState('');
  const [rangeMax, setRangeMax] = useState('');
  const [autoScale, setAutoScale] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('10s');
  const [triggerArmed, setTriggerArmed] = useState(false);
  const [triggerThreshold, setTriggerThreshold] = useState('');
  const [stableOnly, setStableOnly] = useState(false);
  // Mirror of recordedResolutionRef for render (histogram bin width + stat decimals);
  // the ref is the loop-side source, this state is its render-safe copy per batch.
  const [recordedResolution, setRecordedResolution] = useState<number | null>(null);
  // Value the meter spent the most readings at — the histogram window center, so a
  // brief outlier (short/disconnect) doesn't pull the window off the main reading.
  const [dominantValue, setDominantValue] = useState<number | null>(null);

  // Canonical filtered dataset: the single source of truth for the Data Log table
  // and CSV export. The chart buffer and stats accumulator are projections fed from
  // the same log site (see handleReadings). OL is never added here. `recordedRowsRef`
  // mirrors the state for the stable `exportCsv` callback; `rowIdRef` is the monotonic
  // id source (stable React key + per-row note target).
  const [recordedRows, setRecordedRows] = useState<LoggedRow[]>([]);
  const recordedRowsRef = useRef<LoggedRow[]>([]);
  const rowIdRef = useRef(0);

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
  // Stable-only tracking (read synchronously in the read loop): the previous
  // numeric reading's raw value (for exact stability detection), and the last
  // logged base value (the reference for the major-change gate + dedup guard).
  const prevValueRef = useRef<number | null>(null);
  const lastLoggedValueRef = useRef<number | null>(null);
  // Coarsest LSD (resolution) among readings actually logged to the chart — the
  // basis for histogram bin width AND statistics decimals, so both reflect the
  // stored data (not the live reading, which can auto-range to a finer step).
  // Frozen while logging is stopped. Reset with the session in flushSession.
  const recordedResolutionRef = useRef<number | null>(null);
  // Raw reading time spent at each LSD-snapped value while recording → the
  // dominant (most-held) value, used to center the histogram window. Bounded by
  // distinct values seen; reset with the session. dominantCountRef = running max.
  const rawCountsRef = useRef<Map<number, number>>(new Map());
  const dominantValueRef = useRef<number | null>(null);
  const dominantCountRef = useRef(0);

  const setRec = useCallback((v: boolean) => {
    recordingRef.current = v;
    // A stop (manual or disconnect) ends any trigger-started session.
    if (!v) triggerStartedRef.current = false;
    // A fresh start must not inherit a stale predecessor from before it began.
    if (v) { prevValueRef.current = null; lastLoggedValueRef.current = null; }
    setRecording(v);
  }, []);

  useEffect(() => { autoScaleRef.current = autoScale; }, [autoScale]);
  useEffect(() => { timeRangeRef.current = timeRange; }, [timeRange]);
  useEffect(() => { triggerArmedRef.current = triggerArmed; }, [triggerArmed]);
  useEffect(() => { triggerThresholdRef.current = toFinite(triggerThreshold); }, [triggerThreshold]);
  useEffect(() => { stableOnlyRef.current = stableOnly; }, [stableOnly]);

  const flushSession = useCallback(() => {
    recordedRowsRef.current = [];
    rowIdRef.current = 0;
    setRecordedRows([]);
    statsRef.current = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
    prevValueRef.current = null;
    lastLoggedValueRef.current = null;
    recordedResolutionRef.current = null;
    rawCountsRef.current = new Map();
    dominantValueRef.current = null;
    dominantCountRef.current = 0;
    setSessionStats(null);
    setChartPoints([]);
    setRecordedResolution(null);
    setDominantValue(null);
  }, []);

  const handleReadings = useCallback(
    (readings: Reading[]) => {
      setCurrent(readings[readings.length - 1]);

      // Range and trigger bounds are constant for the whole batch — resolve once.
      const rMin = autoScaleRef.current ? null : toFinite(rangeMin);
      const rMax = autoScaleRef.current ? null : toFinite(rangeMax);
      let armed = triggerArmedRef.current;
      let threshold = triggerThresholdRef.current;
      let release = threshold !== null ? threshold * RELEASE_RATIO : null;

      let recordingChanged = false;
      const newPoints: ChartPoint[] = [];
      const newRows: LoggedRow[] = [];
      for (const r of readings) {
        const { baseValue, baseUnit } = normalizeReading(r);

        if (baseUnit !== '' && (modeRef.current !== r.mode || unitRef.current !== baseUnit)) {
          const wasInitialised = modeRef.current !== null;
          modeRef.current = r.mode;
          unitRef.current = baseUnit;
          setChartUnit(baseUnit);
          flushSession();
          newPoints.length = 0;
          // A real mode/unit change makes the in-progress data and threshold
          // meaningless in the new unit — stop logging, then reset the trigger
          // (clear threshold + disarm). (Skip on the first reading, which is
          // initial detection, not a change, so a pre-typed threshold survives.)
          if (wasInitialised) {
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
          }
        }

        // Trigger edges (evaluated before recording so the crossing sample is captured).
        const mag = baseValue !== null ? Math.abs(baseValue) : null;
        if (armed && threshold !== null && !recordingRef.current && mag !== null && mag > threshold) {
          flushSession();
          newPoints.length = 0;
          recordingRef.current = true;
          triggerStartedRef.current = true;
          recordingChanged = true;
        } else if (triggerStartedRef.current && recordingRef.current && release !== null && mag !== null && mag < release) {
          recordingRef.current = false;
          triggerStartedRef.current = false;
          recordingChanged = true;
        }

        if (recordingRef.current) {
          const stableFilter = stableOnlyRef.current;
          if (baseValue === null) {
            // OL is excluded from the filtered dataset entirely (table, CSV, chart,
            // and stats). It is still a discontinuity — reset the run and reference.
            prevValueRef.current = null;
            lastLoggedValueRef.current = null;
          } else {
            // With the stable filter on, log a value once it is confirmed stable
            // (equals its predecessor) AND it differs from the last logged value
            // by a major amount — so small drift around a settled reading and the
            // rest of a plateau are suppressed. (Ratio is scale-invariant, so the
            // narrowed baseValue is used; raw r.value drives exact stability.)
            let logSample = true;
            if (stableFilter) {
              const stable = prevValueRef.current !== null && r.value === prevValueRef.current;
              const last = lastLoggedValueRef.current;
              const major =
                last === null ||
                (baseValue !== last && Math.abs(baseValue - last) >= MAJOR_CHANGE_RATIO * Math.abs(last));
              logSample = stable && major;
              if (logSample) lastLoggedValueRef.current = baseValue;
            }
            prevValueRef.current = r.value;

            // Count time at this value (LSD-snapped) to find the dominant value
            // for the histogram window center. Counts every reading, not just
            // logged ones, so a held value wins over a brief outlier.
            const res = readingResolution(r);
            if (res !== null) {
              const k = Math.round(baseValue / res) * res;
              const c = (rawCountsRef.current.get(k) ?? 0) + 1;
              rawCountsRef.current.set(k, c);
              if (c > dominantCountRef.current) {
                dominantCountRef.current = c;
                dominantValueRef.current = k;
              }
            }

            if (logSample) {
              // Append to the canonical filtered dataset (one entry per logged
              // sample). The chart point + Welford update below are projections of
              // this same entry, fed in the same iteration → identical membership.
              // `iso` is precomputed once here (reused by render, filter, and CSV).
              newRows.push({ id: rowIdRef.current++, reading: r, note: '', iso: new Date(r.ts).toISOString() });
              // Track the coarsest LSD among logged readings → bin width + stat
              // decimals reflect the recorded data, range-robust to auto-ranging.
              if (res !== null) {
                recordedResolutionRef.current = Math.max(recordedResolutionRef.current ?? 0, res);
              }
              const s = statsRef.current;
              s.count += 1;
              const delta = baseValue - s.mean;
              s.mean += delta / s.count;
              s.m2 += delta * (baseValue - s.mean);
              if (baseValue < s.min) s.min = baseValue;
              if (baseValue > s.max) s.max = baseValue;
              // Clamp to range and flag out-of-range in a single pass.
              let chartV = baseValue;
              let oor = false;
              if (rMax !== null && baseValue > rMax) { chartV = rMax; oor = true; }
              else if (rMin !== null && baseValue < rMin) { chartV = rMin; oor = true; }
              newPoints.push({ ts: r.ts, v: chartV, oor });
            }
          }
        }
      }

      if (newPoints.length > 0) {
        setChartPoints((prev) => {
          const combined = [...prev, ...newPoints];
          // 'all' mode accumulates the full session — skip the rolling cap.
          if (timeRangeRef.current === 'all') return combined;
          return combined.length > MAX_CHART_POINTS
            ? combined.slice(combined.length - MAX_CHART_POINTS)
            : combined;
        });
      }

      // Append this batch's logged entries to the canonical store once (batched, not
      // per-sample). The ref is updated synchronously so exportCsv reads the latest;
      // setState uses the same new reference to trigger a render.
      if (newRows.length > 0) {
        recordedRowsRef.current = [...recordedRowsRef.current, ...newRows];
        setRecordedRows(recordedRowsRef.current);
      }

      // Commit a trigger-driven recording transition once (no per-sample setState).
      if (recordingChanged) setRecording(recordingRef.current);

      if (recordingRef.current) setSessionStats({ ...statsRef.current });

      // Mirror the recorded resolution + dominant value to state. (Unchanged when
      // nothing was logged this batch — e.g. logging stopped → React bails out.)
      setRecordedResolution(recordedResolutionRef.current);
      setDominantValue(dominantValueRef.current);
    },
    [flushSession, rangeMin, rangeMax],
  );

  const { status, error, connect, disconnect } = useSerial(handleReadings);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset recording on disconnect
    if (status !== 'connected') setRec(false);
  }, [status, setRec]);

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

  // Per-row note edit: annotation only — never touches the reading or statistics.
  const handleNoteChange = useCallback((id: number, note: string) => {
    const next = recordedRowsRef.current.map((row) => (row.id === id ? { ...row, note } : row));
    recordedRowsRef.current = next;
    setRecordedRows(next);
  }, []);

  const exportCsv = useCallback(() => {
    // Serializes the same canonical store the table renders. recordedRows is numeric
    // only (OL is excluded upstream), so r.value is always present.
    // Quote/escape note fields (free text may contain commas, quotes, newlines).
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines: string[] = ['Timestamp,Mode,Value,Unit,Notes'];
    for (const { iso, reading: r, note } of recordedRowsRef.current) {
      lines.push([iso, r.mode, String(r.value), r.unit, esc(note)].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `multimeter-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const recordedCount = sessionStats?.count ?? 0;
  const canExport = recordedRows.length > 0;
  const effectiveYMin = autoScale ? undefined : (toFinite(rangeMin) ?? undefined);
  const effectiveYMax = autoScale ? undefined : (toFinite(rangeMax) ?? undefined);
  // Histogram bin width + statistics decimals. When data is present they are a
  // property of the recorded data, so use the frozen coarsest recorded resolution —
  // this keeps both stable when logging is stopped and the live value changes scale
  // or goes OL. When empty, derive from the live reading to preview the window.
  const liveNumeric = current && normalizeReading(current).baseValue !== null ? current : null;
  const binWidth =
    chartPoints.length > 0
      ? (recordedResolution ?? undefined)
      : (liveNumeric ? (readingResolution(liveNumeric) ?? undefined) : undefined);
  // Histogram window center: the time-dominant recorded value when data is present
  // (outliers fall into under/over-range bins), else the live reading for preview.
  const centerValue =
    chartPoints.length > 0
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
          onNavChange={setView}
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
                  data={chartPoints}
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
              rangeMax={rangeMax}
              onRangeMinChange={setRangeMin}
              onRangeMaxChange={setRangeMax}
              autoScale={autoScale}
              onAutoScaleChange={setAutoScale}
              triggerThreshold={triggerThreshold}
              onTriggerThresholdChange={setTriggerThreshold}
              triggerArmed={triggerArmed}
              onTriggerArmedChange={setTriggerArmed}
              canArm={toFinite(triggerThreshold) !== null && status === 'connected'}
              triggerUnit={chartUnit}
              recording={recording}
              onToggleRecord={handleToggleRecord}
              canRecord={status === 'connected'}
              stableOnly={stableOnly}
              onStableOnlyChange={handleStableOnlyChange}
              onClear={flushSession}
              onExportCsv={exportCsv}
              canExport={canExport}
            />
          </>
        ) : (
          <DataLog
            reading={current}
            recording={recording}
            rows={recordedRows}
            stats={sessionStats}
            unit={chartUnit}
            decimals={statDecimals}
            canRecord={status === 'connected'}
            onExportCsv={exportCsv}
            onToggleRecord={handleToggleRecord}
            onClear={flushSession}
            onNoteChange={handleNoteChange}
          />
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="flex h-8 shrink-0 items-center justify-center border-t border-border">
        <p className="text-xs text-muted">
          Multimeter Visualizer v{APP_VERSION} &nbsp;·&nbsp; Built for precision.
        </p>
      </footer>
    </div>
  );
}
