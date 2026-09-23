'use client';

import { memo, useMemo } from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { ActionButton } from '@/components/Controls';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { normalizeReading, readingResolution, type Reading, displayUnit } from '@/lib/parser';
import {
  ENTRY_UNITS, entryToBase, formatEntryValue, isBandTooWide, isPlausibleReference,
  judge, parseSiValue, resolveAbsoluteTolerance, resolveBand, siPrefixOf,
  type SupportedMode, type ToleranceMode, type VerdictRow,
} from '@/lib/passfail';

// Same windowing rationale as DataLog: keep every row in memory and in the CSV, but
// cap what is painted into the DOM.
const MAX_RENDERED = 500;
const GRID_COLS =
  'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_90px]';

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted', className)}>
      {children}
    </div>
  );
}

/** Advisory strip — never blocks a verdict, only explains one. */
function Advisory({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-[11px] leading-relaxed text-amber">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** SI-form free-text entry. The raw string is the state — `4.5k` must survive passing
 *  through `4.` — so parsing happens on read, not per keystroke. */
function EntryField({
  value,
  onChange,
  placeholder,
  suffix,
  disabled,
  invalid,
  label,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  suffix: string;
  disabled?: boolean;
  invalid?: boolean;
  label: string;
  id: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[11px] font-medium text-muted">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(
            'min-w-0 flex-1 rounded-md border bg-surface px-2.5 py-1.5 text-right font-mono text-xs text-fg focus:outline-none disabled:opacity-40',
            invalid ? 'border-danger focus:border-danger' : 'border-border focus:border-accent',
          )}
        />
        <span className="w-6 shrink-0 text-xs text-muted">{suffix}</span>
      </div>
    </div>
  );
}

export function PassFail({
  reading,
  stable,
  mode,
  reference,
  onReferenceChange,
  referenceSettled,
  tolerance,
  onToleranceChange,
  toleranceSettled,
  toleranceMode,
  onToleranceModeChange,
  rows,
  onClear,
  onExportCsv,
}: {
  reading: Reading | null;
  stable: boolean;
  mode: SupportedMode | null;
  /** Live input value — drives the field only. */
  reference: string;
  onReferenceChange: (v: string) => void;
  /** Debounced value — drives everything derived from the entry. */
  referenceSettled: string;
  tolerance: string;
  onToleranceChange: (v: string) => void;
  toleranceSettled: string;
  toleranceMode: ToleranceMode;
  onToleranceModeChange: (v: ToleranceMode) => void;
  rows: VerdictRow[];
  onClear: () => void;
  onExportCsv: () => void;
}) {
  const entryUnit = mode ? ENTRY_UNITS[mode].label : '';

  // Parsed on read, not on keystroke (see EntryField).
  // Everything below reads the SETTLED (debounced) values, never the live inputs: typing
  // "10" passes through "1", so a 10% tolerance would flash FAIL at 1% on the way.
  const refEntry = parseSiValue(referenceSettled);
  // An absolute tolerance is read in the REFERENCE's SI range (a bare `30` against a
  // `300p` reference = 30 pF); the field's unit label shows that range.
  const tolPrefix = toleranceMode === 'absolute' ? siPrefixOf(refEntry) : null;
  const toleranceUnitLabel =
    toleranceMode === 'percent' ? '%' : `${tolPrefix?.symbol ?? ''}${entryUnit}`;
  const tolEntry =
    toleranceMode === 'absolute'
      ? resolveAbsoluteTolerance(toleranceSettled, refEntry)
      : parseSiValue(toleranceSettled);
  const bandEntry = refEntry !== null && tolEntry !== null
    ? resolveBand(refEntry, tolEntry, toleranceMode)
    : null;

  // Validity uses the settled value too, so a field doesn't flash red mid-typing.
  const refInvalid = referenceSettled.trim() !== '' && refEntry === null;
  const tolInvalid = toleranceSettled.trim() !== '' && tolEntry === null;
  // A too-wide tolerance parses fine, so it is NOT `tolInvalid` — without its own
  // message the view would just refuse to judge and look broken.
  const tolTooWide =
    refEntry !== null && tolEntry !== null && isBandTooWide(refEntry, tolEntry, toleranceMode);
  const implausible = mode !== null && refEntry !== null && !isPlausibleReference(mode, refEntry);

  // measured: shown whenever there is one — no reference, no stability needed. The
  //           operator reads the meter through this view, not just verdicts out of it.
  // verdict:  only with something to compare against AND a settled reading — lifting a
  //           probe in resistance mode sweeps intermediates, which flash a spurious FAIL.
  // Unmemoized: a few multiplies. (NOT because a compiler memoizes them — React Compiler
  // is not in this build; only the eslint rule that mirrors it runs, and it rejects a
  // useMemo here. Anything O(n) in this component DOES need an explicit memo.)
  const norm = reading ? normalizeReading(reading) : null;
  // OL, mid-measurement dashes, and an exact zero (floating probes) all mean nothing is
  // under the probes. NOTE: capacitance additionally has capNoPartFloor, which lives in
  // the capture path only — a sub-floor stray still renders here as a measured value.
  const measuredBase =
    mode && norm && norm.baseValue !== null && norm.baseValue !== 0 ? norm.baseValue : null;

  const toBase = mode ? ENTRY_UNITS[mode].toBase : 1;
  const refBase = mode && refEntry !== null ? entryToBase(mode, refEntry) : null;
  const verdict =
    measuredBase !== null && refBase !== null && stable && bandEntry !== null
      ? judge(measuredBase, refBase, bandEntry * toBase)
      : null;

  // Tolerance narrower than the meter's least-significant digit -> every verdict is
  // quantization-limited. Advisory only.
  const lsd = reading ? readingResolution(reading) : null;
  const belowResolution =
    mode !== null && bandEntry !== null && lsd !== null &&
    bandEntry * toBase < lsd;

  // One memoized pass for yield AND the value spread. This component re-renders on
  // every serial batch while `rows` is unbounded, so an unmemoized scan here is O(n)
  // work many times a second. `rows` is append-only, so the memo is exact.
  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    let mean = 0, m2 = 0, min = Infinity, max = -Infinity, count = 0, passed = 0;
    for (const r of rows) {
      count += 1;
      if (r.verdict === 'PASS') passed += 1;
      const delta = r.baseValue - mean;
      mean += delta / count;
      m2 += delta * (r.baseValue - mean);
      if (r.baseValue < min) min = r.baseValue;
      if (r.baseValue > max) max = r.baseValue;
    }
    return { stats: { count, mean, m2, min, max }, passed, failed: count - passed,
             yieldPct: (passed / count) * 100 };
  }, [rows]);

  // Memoized for the same reason: a fresh 500-element array per batch makes React
  // reconcile 500 children each time (memo on VRow saves the render, not the diff).
  const visible = useMemo(
    () => (rows.length > MAX_RENDERED ? rows.slice(rows.length - MAX_RENDERED) : rows),
    [rows],
  );
  const truncated = rows.length > MAX_RENDERED;
  const baseUnit = norm?.baseUnit ?? '';

  const deviation = measuredBase !== null && refBase !== null ? measuredBase - refBase : null;
  const statusLine = reading?.isMeasuring
    ? 'Measuring\u2026'
    : measuredBase === null
      ? 'No part connected'
      : refEntry === null || bandEntry === null
        ? 'Enter a reference and tolerance to compare'
        : verdict === null || deviation === null
          ? 'Settling\u2026'
          : `${deviation >= 0 ? '+' : '\u2212'}${formatEntryValue(Math.abs(deviation) / toBase, entryUnit)} from reference`;

  // Unsupported mode: no controls, no capture, just an explanation.
  if (mode === null) {
    return (
      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-lg pt-16 text-center">
          <h2 className="mb-2 text-lg font-semibold text-fg">Pass/Fail</h2>
          <p className="text-sm leading-relaxed text-muted">
            Pass/Fail testing is available in <strong className="text-fg">Resistance</strong>,{' '}
            <strong className="text-fg">Diode</strong> and{' '}
            <strong className="text-fg">Capacitance</strong> modes.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Voltage and Current are excluded because lifting the probes reads a small
            number rather than <span className="font-mono">OL</span>, so there is no
            reliable way to tell one part from the next. Continuity is excluded because
            the meter&rsquo;s own buzzer already is the pass/fail indicator.
          </p>
          <p className="mt-3 text-xs text-muted">
            Turn the meter&rsquo;s dial to a supported mode to begin.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 gap-4 overflow-hidden p-5">
      {/* ── Left: verdict + table ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {/* Live verdict */}
        <section className="flex flex-col items-center justify-center rounded-lg border border-border bg-panel py-6">
          {/* Three fixed slots, nothing conditionally added or removed, so a verdict
              appearing never reflows the layout. */}
          <div className="flex h-14 items-center justify-center">
            {verdict !== null ? (
              <span
                className={clsx(
                  'text-5xl font-bold tracking-wider',
                  verdict === 'PASS' ? 'text-success' : 'text-danger',
                )}
              >
                {verdict}
              </span>
            ) : (
              <span className="text-4xl font-semibold tracking-wider text-muted/40">—</span>
            )}
          </div>

          <div
            className={clsx(
              'font-mono text-2xl tabular-nums',
              measuredBase === null ? 'text-muted/50' : 'text-fg',
            )}
          >
            {measuredBase === null
              ? '\u2014'
              : formatEntryValue(measuredBase / toBase, entryUnit)}
          </div>

          <div className="mt-1.5 flex h-4 items-center text-xs text-muted">
            {statusLine}
          </div>
        </section>

        {/* Table */}
        <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-panel">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h3 className="text-xs font-semibold text-fg">
              Tested Parts{rows.length > 0 && <span className="ml-2 text-muted">({rows.length})</span>}
            </h3>
            <button
              onClick={onExportCsv}
              disabled={rows.length === 0}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-xs font-semibold text-fg transition-colors hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download size={14} />
              Export CSV
            </button>
          </div>

          <div className={clsx(GRID_COLS, 'border-b border-border bg-canvas/40 px-5')}>
            <Th>Timestamp</Th>
            <Th className="text-right">Measured</Th>
            <Th className="text-right">Reference</Th>
            <Th className="text-right">Deviation</Th>
            <Th className="text-right">Verdict</Th>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="flex h-full items-center justify-center px-5 py-10 text-center text-sm text-muted">
                No parts tested yet. Set a reference, then probe a part.
              </div>
            ) : (
              <>
                {truncated && (
                  <div className="border-b border-border bg-canvas/40 px-5 py-2 text-center text-[11px] text-muted">
                    Showing latest {MAX_RENDERED.toLocaleString('en')} of{' '}
                    {rows.length.toLocaleString('en')} — export CSV for the full batch
                  </div>
                )}
                {visible.map((row) => (
                  <VRow key={row.id} row={row} />
                ))}
              </>
            )}
          </div>
        </section>
      </div>

      {/* ── Right: controls + summary ── */}
      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto">
        <section className="space-y-3 rounded-lg border border-border bg-panel p-4">
          <h3 className="text-xs font-semibold text-fg">Reference</h3>

          <EntryField
            id="pf-reference"
            label="Nominal value"
            value={reference}
            onChange={onReferenceChange}
            placeholder={mode === 'CAPACITANCE' ? '100n' : '4k7'}
            suffix={entryUnit}
            invalid={refInvalid}
          />

          {/* Echo so `300p` is visibly 300 pF, not 300 F. */}
          {refEntry !== null && (
            <p className="text-[11px] text-muted">
              = <span className="font-mono text-fg">{formatEntryValue(refEntry, entryUnit)}</span>
            </p>
          )}
          {refInvalid && (
            <p className="text-[11px] text-danger">
              Not a valid number. Use a plain value or an SI suffix (4k7, 4.7k, 100n, 22m).
            </p>
          )}
          {implausible && (
            <Advisory>
              Read as <span className="font-mono">{formatEntryValue(refEntry!, entryUnit)}</span>,
              which is outside the usual range for this measurement. The value is still
              used as entered — add an SI suffix if you meant something smaller.
            </Advisory>
          )}

          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-1">
              {(['percent', 'absolute'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => onToleranceModeChange(m)}
                  className={clsx(
                    'flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                    toleranceMode === m
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-muted hover:bg-surface hover:text-fg',
                  )}
                >
                  {m === 'percent' ? '± %' : '± abs'}
                </button>
              ))}
            </div>
            <EntryField
              id="pf-tolerance"
              label="Tolerance"
              value={tolerance}
              onChange={onToleranceChange}
              placeholder={toleranceMode === 'percent' ? '1' : '30'}
              suffix={toleranceUnitLabel}
              invalid={tolInvalid}
            />
          </div>

          {/* Same echo the reference field gets — otherwise there is no way to tell
              that `300p` was understood as 300 pF rather than 300 F. */}
          {toleranceMode === 'absolute' && tolEntry !== null && (
            <p className="text-[11px] text-muted">
              = <span className="font-mono text-fg">± {formatEntryValue(tolEntry, entryUnit)}</span>
              {refEntry === null && ' \u2014 no reference to take a range from; add an SI suffix'}
            </p>
          )}
          {tolInvalid && (
            <p className="text-[11px] text-danger">
              Not a valid number. A plain number uses the reference&rsquo;s range; an SI
              suffix overrides it.
            </p>
          )}
          {tolTooWide && (
            <p className="text-[11px] text-danger">
              Too wide — the band reaches zero, so every part would pass. Use a tolerance
              below {toleranceMode === 'percent' ? '100%' : formatEntryValue(Math.abs(refEntry!), entryUnit)}.
            </p>
          )}
          {bandEntry !== null && refEntry !== null && (
            <p className="text-[11px] text-muted">
              Accepts{' '}
              <span className="font-mono text-fg">
                {formatEntryValue(refEntry - bandEntry, entryUnit)}
              </span>{' '}
              to{' '}
              <span className="font-mono text-fg">
                {formatEntryValue(refEntry + bandEntry, entryUnit)}
              </span>
            </p>
          )}
          {belowResolution && (
            <Advisory>
              The tolerance band is narrower than the meter&rsquo;s least-significant
              digit, so the verdict is limited by the meter&rsquo;s resolution, not by
              the part.
            </Advisory>
          )}
        </section>

        {/* Yield */}
        <section className="space-y-3 rounded-lg border border-border bg-panel p-4">
          <h3 className="text-xs font-semibold text-fg">Batch</h3>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md border border-border py-2">
              <div className="font-mono text-base text-fg">{rows.length}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Tested</div>
            </div>
            <div className="rounded-md border border-border py-2">
              <div className="font-mono text-base text-success">{summary?.passed ?? 0}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Pass</div>
            </div>
            <div className="rounded-md border border-border py-2">
              <div className="font-mono text-base text-danger">{summary?.failed ?? 0}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Fail</div>
            </div>
          </div>
          {summary && (
            <div className="rounded-md border border-border py-2 text-center">
              <div className="font-mono text-lg text-fg">{summary.yieldPct.toFixed(1)}%</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Yield</div>
            </div>
          )}
          <ActionButton
            onClick={onClear}
            icon={<Trash2 size={13} />}
            label="Clear Batch"
            variant="danger"
            disabled={rows.length === 0}
          />
        </section>

        {summary && (
          <section className="rounded-lg border border-border bg-panel p-4">
            <StatisticsPanel stats={summary.stats} unit={displayUnit(baseUnit)} bare layout="stack" title="Measured Spread" />
          </section>
        )}
      </aside>
    </main>
  );
}

// memo'd so a new capture re-renders only the appended row, and live-reading updates
// (which fire many times a second) skip every existing row.
const VRow = memo(function VRow({ row }: { row: VerdictRow }) {
  const unit = ENTRY_UNITS[row.mode].label;
  const toBase = ENTRY_UNITS[row.mode].toBase;
  const pass = row.verdict === 'PASS';
  return (
    <div className={clsx(GRID_COLS, 'items-center border-b border-border/60 px-5 transition-colors hover:bg-surface/40')}>
      <div className="py-2 font-mono text-[11px] text-muted">
        {new Date(row.ts).toLocaleTimeString('en')}
      </div>
      <div className="py-2 text-right font-mono text-xs text-fg">
        {formatEntryValue(row.baseValue / toBase, unit)}
      </div>
      <div className="py-2 text-right font-mono text-[11px] text-muted">
        {formatEntryValue(row.baseReference / toBase, unit)}
      </div>
      <div className={clsx('py-2 text-right font-mono text-[11px]', pass ? 'text-muted' : 'text-danger')}>
        {row.deviation >= 0 ? '+' : '−'}
        {formatEntryValue(Math.abs(row.deviation) / toBase, unit)}
      </div>
      <div className="py-2 text-right">
        <span
          className={clsx(
            'inline-block rounded px-2 py-0.5 text-[10px] font-bold tracking-wide',
            pass ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger',
          )}
        >
          {row.verdict}
        </span>
      </div>
    </div>
  );
});
