'use client';

import { memo, useMemo, useState } from 'react';
import { Search, Download, Square, Play, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { MODE_LABELS, SCALE, type Mode, type Reading, displayUnit } from '@/lib/parser';
import type { SampleStore } from '@/lib/samples';
import { StatisticsPanel, type SessionStats } from '@/components/StatisticsPanel';
import { ActionButton } from '@/components/Controls';

/**
 * Exactly what one rendered row needs, as SCALARS. Deliberately not the store's `Sample`
 * object: `Row` is memoized on prop identity, and `store.at(i)` returns a fresh object on
 * every call, so passing it would defeat the memo and re-render every visible row three
 * times a second — worse than before the store existed.
 */
type RowData = {
  seq: number;
  ts: number;
  value: number;
  mode: Mode;
  unit: string;
  decimals: number;
  note: string;
};

/** The row timestamp as the table and the CSV both render it. Formatted where it is used,
 *  never stored — at most 500 rows are visible, and the session may hold millions. */
const rowIso = (ts: number): string => new Date(ts).toISOString();

/** The value as the meter reported it: base value back through its unit's factor, at the
 *  meter's own digit count. `toFixed`, never `String` — a number has no memory of trailing
 *  zeros, and 0.1450 at 0.1 mV resolution is not the same measurement as 0.145 at 1 mV. */
const rowValue = (value: number, unit: string, decimals: number): string =>
  (value / (SCALE[unit]?.factor ?? 1)).toFixed(decimals);

// Shared grid for the table header and rows (matches the reference layout).
const GRID_COLS = 'grid grid-cols-[minmax(0,2fr)_120px_minmax(0,1fr)_80px_minmax(0,3fr)]';

// Cap how many rows are painted into the DOM. All readings stay in memory (and in
// the CSV export); only rendering is windowed to the most recent N for performance.
const MAX_RENDERED = 500;

export function DataLog({
  reading,
  recording,
  store,
  sampleVersion,
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
  /** THE canonical store, shared with the chart and the CSV. Read, never copied. */
  store: SampleStore;
  /** Bumped once per batch and on a note edit; the store is a ref, so this is the only
   *  thing that tells React anything changed. */
  sampleVersion: number;
  stats: SessionStats | null;
  unit: string;
  decimals?: number;
  canRecord: boolean;
  onExportCsv: () => void;
  onToggleRecord: () => void;
  onClear: () => void;
  onNoteChange: (seq: number, note: string) => void;
}) {
  const [query, setQuery] = useState('');
  const liveValue = reading?.display ?? '—';
  const liveUnit = displayUnit(reading?.unit ?? '');
  const liveMode = reading ? MODE_LABELS[reading.mode] : 'No signal';

  // Display-only filter: never mutates the dataset or the statistics.
  //
  // Scans BACKWARDS from the newest sample and stops once it has MAX_RENDERED matches, so a
  // keystroke costs what the table shows rather than what the session holds. A multi-day
  // session is millions of rows; filtering all of them per keystroke is not an option.
  //
  // The price is that with a query active the total match count is unknowable, so the header
  // reports the displayed count instead (see `truncated` below). With no query the count is
  // exact, because it is just the store's.
  const { visible, matched, truncated } = useMemo(() => {
    void sampleVersion; // the store is a ref; this is what makes the memo re-run
    const q = query.trim().toLowerCase();
    const out: RowData[] = [];
    const read = (i: number): RowData => {
      const sm = store.at(i);
      return {
        seq: sm.seq, ts: sm.ts, value: sm.value,
        mode: sm.mode, unit: sm.unit, decimals: sm.decimals, note: sm.note,
      };
    };

    if (q === '') {
      const start = Math.max(0, store.count - MAX_RENDERED);
      for (let i = store.count - 1; i >= start; i--) out.push(read(i));
      return { visible: out, matched: store.count, truncated: store.count > MAX_RENDERED };
    }

    let scanned = 0;
    for (let i = store.count - 1; i >= 0 && out.length < MAX_RENDERED; i--) {
      scanned++;
      const r = read(i);
      const value = rowValue(r.value, r.unit, r.decimals);
      if (
        r.mode.toLowerCase().includes(q) ||
        value.toLowerCase().includes(q) ||
        // Match either spelling: the operator may type "om" (what the meter sends and
        // what the CSV holds) or paste the symbol shown in the table.
        r.unit.toLowerCase().includes(q) ||
        displayUnit(r.unit).toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q) ||
        // LAST deliberately: this one allocates a Date per row, and every cheaper predicate
        // short-circuits past it.
        rowIso(r.ts).toLowerCase().includes(q)
      ) {
        out.push(r);
      }
    }
    // `truncated` here means "there may be older matches", which is true exactly when the
    // scan stopped early rather than reaching the start of the store.
    return { visible: out, matched: out.length, truncated: scanned < store.count };
  }, [store, sampleVersion, query]);

  const hasQuery = query.trim() !== '';

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
            <Meta label="Samples" value={store.count.toLocaleString('en')} />
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
                {store.count.toLocaleString('en')} entries
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
                disabled={store.count === 0}
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
            {store.count === 0 ? (
              <div className="flex h-full items-center justify-center px-5 py-10 text-center text-sm text-muted">
                No measurements recorded yet. Start logging to capture readings.
              </div>
            ) : visible.length === 0 ? (
              <div className="flex h-full items-center justify-center px-5 py-10 text-center text-sm text-muted">
                No rows match “{query}”.
              </div>
            ) : (
              <>
                {truncated && (
                  <div className="border-b border-border bg-canvas/40 px-5 py-2 text-center text-[11px] text-muted">
                    {hasQuery
                      ? `Showing latest ${visible.length.toLocaleString('en')} matches`
                      : `Showing latest ${MAX_RENDERED.toLocaleString('en')} of ${matched.toLocaleString('en')}`}
                    {' '}— export CSV for the full retained log
                  </div>
                )}
                {visible.map((row) => (
                  <Row
                    key={row.seq}
                    seq={row.seq}
                    ts={row.ts}
                    value={row.value}
                    mode={row.mode}
                    unit={row.unit}
                    decimals={row.decimals}
                    note={row.note}
                    onNoteChange={onNoteChange}
                  />
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
                disabled={store.count === 0}
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

// Memoized so a note edit re-renders only its own row, and a batch that did not change a
// given row skips it entirely.
//
// The fields are passed as SEPARATE SCALAR PROPS, not as one object. `React.memo` compares
// props with `Object.is` PER PROP and does not descend into objects, so handing it a record
// rebuilt on every render — whether `store.at(i)` or a fresh literal assembled from it —
// compares unequal every time and defeats the memo completely. Scalars compare by value, so
// this actually bites: three times a second the store grows by a few samples and every
// already-rendered row's props are identical, so none of them re-render.
const Row = memo(function Row({
  seq,
  ts,
  value,
  mode,
  unit,
  decimals,
  note,
  onNoteChange,
}: RowData & {
  onNoteChange: (seq: number, note: string) => void;
}) {
  return (
    <div className={clsx(GRID_COLS, 'items-center border-b border-border/60 px-5 transition-colors hover:bg-surface/40')}>
      <div className="py-3 font-mono text-xs text-muted">{rowIso(ts)}</div>
      <div className="py-3">
        <span className="inline-block rounded border border-accent/25 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
          {MODE_LABELS[mode]}
        </span>
      </div>
      <div className="py-3 text-right font-mono text-sm font-semibold tabular-nums text-fg">
        {rowValue(value, unit, decimals)}
      </div>
      <div className="py-3 pl-5 font-mono text-xs text-muted">{displayUnit(unit)}</div>
      <div className="py-2 pr-3">
        <input
          value={note}
          onChange={(e) => onNoteChange(seq, e.target.value)}
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
