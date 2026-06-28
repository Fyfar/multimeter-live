'use client';

import { memo, useMemo, useState } from 'react';
import { Search, Download, Square, Play, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { MODE_LABELS, type Reading } from '@/lib/parser';
import { StatisticsPanel, type SessionStats } from '@/components/StatisticsPanel';
import { ActionButton } from '@/components/Controls';

// One entry of the canonical filtered dataset (the single source of truth shared
// with the chart, statistics, and CSV export). `id` is a stable React key + note
// target; `note` is a session-scoped annotation that never alters the measurement;
// `iso` is the reading's timestamp formatted once (reused by render, filter, CSV).
export type LoggedRow = { id: number; reading: Reading; note: string; iso: string };

// Shared grid for the table header and rows (matches the reference layout).
const GRID_COLS = 'grid grid-cols-[minmax(0,2fr)_120px_minmax(0,1fr)_80px_minmax(0,3fr)]';

// Cap how many rows are painted into the DOM. All readings stay in memory (and in
// the CSV export); only rendering is windowed to the most recent N for performance.
const MAX_RENDERED = 500;

export function DataLog({
  reading,
  recording,
  rows,
  stats,
  unit,
  decimals,
  canRecord,
  onExportCsv,
  onToggleRecord,
  onClear,
  onNoteChange,
}: {
  reading: Reading | null;
  recording: boolean;
  rows: LoggedRow[];
  stats: SessionStats | null;
  unit: string;
  decimals?: number;
  canRecord: boolean;
  onExportCsv: () => void;
  onToggleRecord: () => void;
  onClear: () => void;
  onNoteChange: (id: number, note: string) => void;
}) {
  const [query, setQuery] = useState('');
  const liveValue = reading?.display ?? '—';
  const liveUnit = reading?.unit ?? '';
  const liveMode = reading ? MODE_LABELS[reading.mode] : 'No signal';

  // Display-only filter: never mutates the dataset or the statistics.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ reading: r, note, iso }) => {
      const value = r.value === null ? 'OL' : String(r.value);
      return (
        iso.toLowerCase().includes(q) ||
        r.mode.toLowerCase().includes(q) ||
        value.toLowerCase().includes(q) ||
        r.unit.toLowerCase().includes(q) ||
        note.toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  // Render only the most recent MAX_RENDERED rows (newest are appended last), then
  // show them newest-first: the latest measurement on top, oldest at the bottom.
  // Take the window from the tail BEFORE reversing, and reverse a copy so `filtered`
  // (which may alias the `rows` prop) is never mutated — the underlying dataset, the
  // chart, stats, and CSV stay in chronological order.
  const truncated = filtered.length > MAX_RENDERED;
  const windowed = truncated ? filtered.slice(filtered.length - MAX_RENDERED) : filtered;
  const visible = windowed.slice().reverse();

  return (
    <>
      {/* ── Main content (same width as the Dashboard's main: flex-1 + p-5) ── */}
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden p-5">
        {/* Live reading bar */}
        <section className="flex items-center justify-between rounded-lg border border-border bg-panel px-5 py-4">
          <div className="flex items-baseline gap-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Live Reading
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-3xl font-semibold tabular-nums text-fg">
                {liveValue}
              </span>
              {liveUnit && <span className="font-mono text-base font-semibold text-muted">{liveUnit}</span>}
            </div>
          </div>
          <div className="flex items-center gap-7">
            <Meta label="Mode" value={liveMode} />
            <Meta label="Samples" value={rows.length.toLocaleString('en')} />
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold uppercase tracking-wider',
                recording
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-border bg-surface text-muted',
              )}
            >
              <span className={clsx('h-1.5 w-1.5 rounded-full', recording ? 'animate-pulse bg-success' : 'bg-muted')} />
              {recording ? 'Logging' : 'Idle'}
            </span>
          </div>
        </section>

        {/* Recorded measurements table */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-panel">
          {/* Table toolbar */}
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-fg">Recorded Measurements</h2>
              <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-muted">
                {rows.length.toLocaleString('en')} entries
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                <Search size={14} className="text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter readings…"
                  className="w-36 bg-transparent text-xs text-fg outline-none placeholder:text-muted"
                />
              </div>
              <button
                onClick={onExportCsv}
                disabled={rows.length === 0}
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-xs font-semibold text-fg transition-colors hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download size={14} />
                Export CSV
              </button>
            </div>
          </div>

          {/* Column header */}
          <div className={clsx(GRID_COLS, 'border-b border-border bg-canvas/40 px-5')}>
            <Th>Timestamp</Th>
            <Th>Mode</Th>
            <Th className="text-right">Value</Th>
            <Th className="pl-5">Unit</Th>
            <Th>Notes</Th>
          </div>

          {/* Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="flex h-full items-center justify-center px-5 py-10 text-center text-sm text-muted">
                No measurements recorded yet. Start logging to capture readings.
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center px-5 py-10 text-center text-sm text-muted">
                No rows match “{query}”.
              </div>
            ) : (
              <>
                {truncated && (
                  <div className="border-b border-border bg-canvas/40 px-5 py-2 text-center text-[11px] text-muted">
                    Showing latest {MAX_RENDERED.toLocaleString('en')} of{' '}
                    {filtered.length.toLocaleString('en')} — export CSV for the full log
                  </div>
                )}
                {visible.map((row) => (
                  <Row key={row.id} row={row} onNoteChange={onNoteChange} />
                ))}
              </>
            )}
          </div>
        </section>
      </main>

      {/* ── Right panel: same shell as the Dashboard's Controls (w-56, border-l,
          bg-canvas, p-4 space-y-5). Only the content differs. ── */}
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-l border-border bg-canvas">
        <div className="space-y-5 p-4">
          {/* Logging */}
          <div>
            <h3 className="mb-3 text-xs font-semibold text-fg">Logging</h3>
            <div className="space-y-1.5">
              <ActionButton
                onClick={onToggleRecord}
                icon={recording ? <Square size={12} /> : <Play size={12} />}
                label={recording ? 'Stop Logging' : 'Start Logging'}
                variant={recording ? 'danger' : 'success'}
                disabled={!recording && !canRecord}
              />
              <ActionButton
                onClick={onClear}
                icon={<Trash2 size={12} />}
                label="Clear Log"
                variant="danger"
                disabled={rows.length === 0}
              />
            </div>
          </div>

          <hr className="border-border" />

          {/* Session summary — reuses the Dashboard's StatisticsPanel (bare, stacked) */}
          <StatisticsPanel bare layout="stack" title="Session Summary" stats={stats} unit={unit} decimals={decimals} />
        </div>
      </aside>
    </>
  );
}

// Memoized so a note edit re-renders only its own row, and live-reading updates
// (which don't change `rows`) skip all rows. Props are stable: `row` is a fresh
// object only when that row changes; `onNoteChange` is a stable callback.
const Row = memo(function Row({
  row,
  onNoteChange,
}: {
  row: LoggedRow;
  onNoteChange: (id: number, note: string) => void;
}) {
  const { id, reading: r, note, iso } = row;
  return (
    <div className={clsx(GRID_COLS, 'items-center border-b border-border/60 px-5 transition-colors hover:bg-surface/40')}>
      <div className="py-3 font-mono text-xs text-muted">{iso}</div>
      <div className="py-3">
        <span className="inline-block rounded border border-accent/25 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
          {MODE_LABELS[r.mode]}
        </span>
      </div>
      <div className="py-3 text-right font-mono text-sm font-semibold tabular-nums text-fg">
        {r.display}
      </div>
      <div className="py-3 pl-5 font-mono text-xs text-muted">{r.unit}</div>
      <div className="py-2 pr-3">
        <input
          value={note}
          onChange={(e) => onNoteChange(id, e.target.value)}
          placeholder="Add a note…"
          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs text-fg outline-none transition-colors placeholder:text-muted hover:border-border focus:border-accent focus:bg-canvas"
        />
      </div>
    </div>
  );
});

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-sm font-semibold text-fg">{value}</div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('py-3 text-[11px] font-bold uppercase tracking-wider text-muted', className)}>
      {children}
    </div>
  );
}
