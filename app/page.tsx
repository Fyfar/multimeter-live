'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { DigitalDisplay } from '@/components/DigitalDisplay';
import { RealtimeChart, type ChartPoint, type TimeRange } from '@/components/RealtimeChart';
import { Controls } from '@/components/Controls';
import { Sidebar } from '@/components/Sidebar';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { normalizeReading, type Reading } from '@/lib/parser';
import { useSerial, type SerialStatus } from '@/lib/useSerial';

const MAX_CHART_POINTS = 3600;
// Trigger auto-stop releases at RELEASE_RATIO × threshold (hysteresis dead-band)
// so a signal hovering at the threshold doesn't flap logging on and off.
const RELEASE_RATIO = 0.9;

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

  const recordedRef = useRef<Reading[]>([]);

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

  const setRec = useCallback((v: boolean) => {
    recordingRef.current = v;
    // A stop (manual or disconnect) ends any trigger-started session.
    if (!v) triggerStartedRef.current = false;
    setRecording(v);
  }, []);

  useEffect(() => { autoScaleRef.current = autoScale; }, [autoScale]);
  useEffect(() => { timeRangeRef.current = timeRange; }, [timeRange]);
  useEffect(() => { triggerArmedRef.current = triggerArmed; }, [triggerArmed]);
  useEffect(() => { triggerThresholdRef.current = toFinite(triggerThreshold); }, [triggerThreshold]);

  const flushSession = useCallback(() => {
    recordedRef.current = [];
    statsRef.current = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
    setSessionStats(null);
    setChartPoints([]);
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
          recordedRef.current.push(r);
          if (baseValue !== null) {
            const s = statsRef.current;
            s.count += 1;
            const delta = baseValue - s.mean;
            s.mean += delta / s.count;
            s.m2 += delta * (baseValue - s.mean);
            if (baseValue < s.min) s.min = baseValue;
            if (baseValue > s.max) s.max = baseValue;
          }
          // Clamp to range and flag out-of-range in a single pass.
          let chartV = baseValue;
          let oor = false;
          if (baseValue !== null) {
            if (rMax !== null && baseValue > rMax) { chartV = rMax; oor = true; }
            else if (rMin !== null && baseValue < rMin) { chartV = rMin; oor = true; }
          }
          newPoints.push({ ts: r.ts, v: chartV, oor });
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

      // Commit a trigger-driven recording transition once (no per-sample setState).
      if (recordingChanged) setRecording(recordingRef.current);

      if (recordingRef.current) setSessionStats({ ...statsRef.current });
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

  const exportCsv = useCallback(() => {
    const rows: string[] = ['Timestamp,Mode,Value,Unit'];
    for (const r of recordedRef.current) {
      const value = r.value === null ? 'OL' : String(r.value);
      rows.push(`${new Date(r.ts).toISOString()},${r.mode},${value},${r.unit}`);
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `multimeter-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const recordedCount = sessionStats?.count ?? 0;
  const canExport = recordedCount > 0;
  const effectiveYMin = autoScale ? undefined : (toFinite(rangeMin) ?? undefined);
  const effectiveYMax = autoScale ? undefined : (toFinite(rangeMax) ?? undefined);

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
        />

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
            />
            <StatisticsPanel stats={sessionStats} unit={chartUnit} />
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
          onClear={flushSession}
          onExportCsv={exportCsv}
          canExport={canExport}
        />
      </div>

      {/* ── Footer ── */}
      <footer className="flex h-8 shrink-0 items-center justify-center border-t border-border">
        <p className="text-xs text-muted">
          Multimeter Visualizer v1.0.0 &nbsp;·&nbsp; Built for precision.
        </p>
      </footer>
    </div>
  );
}
