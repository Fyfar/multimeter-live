'use client';

import { displayDecimals, displayUnit, MODE_LABELS, type Reading } from '@/lib/parser';

// Keyed on the VALUE, not the rendered string: testing for 'OL'/'---' means a future
// third non-numeric display silently reports a bogus resolution.
function calcResolution(r: Reading | null): string {
  if (!r?.unit || r.value === null) return '—';
  const decimals = displayDecimals(r.display);
  // No fractional digits (e.g. "123" or a trailing-dot "00.") => whole-unit resolution.
  const u = displayUnit(r.unit);
  if (decimals < 1) return `1 ${u}`;
  return `0.${'0'.repeat(decimals - 1)}1 ${u}`;
}

export function DigitalDisplay({
  reading,
  recording,
  sampleCount,
}: {
  reading: Reading | null;
  recording: boolean;
  sampleCount: number;
}) {
  const display = reading?.display ?? '- - - -';
  const unit = displayUnit(reading?.unit ?? '');
  const mode = reading ? MODE_LABELS[reading.mode] : 'No signal';
  const resolution = calcResolution(reading);
  // Overload and "measuring" are both non-numeric: same muted styling, different text.
  const nonNumeric = reading !== null && reading.value === null;
  const hasReading = reading !== null;

  const valueColor = nonNumeric ? 'text-muted' : recording ? 'text-amber' : 'text-accent';

  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Current Measurement</h2>
        <div className="flex items-center gap-2">
          {recording && (
            <span className="flex items-center gap-1.5 rounded border border-amber/40 px-2 py-0.5 text-xs font-semibold text-amber">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
              REC
            </span>
          )}
          {hasReading && (
            <span className="rounded border border-success/40 px-2 py-0.5 text-xs font-semibold text-success">
              LIVE
            </span>
          )}
        </div>
      </div>

      {/* Value */}
      <div className="flex items-end justify-center gap-4 py-5">
        <span
          className={`font-mono text-8xl font-bold leading-none tabular-nums transition-colors ${valueColor}`}
          style={!nonNumeric && hasReading ? { textShadow: '0 0 28px rgba(59,130,246,0.35)' } : undefined}
        >
          {display}
        </span>
        {unit && (
          <span className="mb-2 font-mono text-3xl font-semibold text-muted">{unit}</span>
        )}
      </div>

      {/* Metadata row */}
      <div className="flex flex-wrap items-center justify-around gap-x-4 gap-y-2 border-t border-border pt-3">
        <MetaItem label="Mode" value={mode} />
        <div className="h-3 w-px bg-border" />
        <MetaItem label="Resolution" value={resolution} />
        <div className="h-3 w-px bg-border" />
        <MetaItem label="Samples" value={sampleCount > 0 ? sampleCount.toLocaleString('en') : '—'} />
      </div>
    </section>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted">{label}:</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}
