'use client';

import type { Reading } from '@/lib/parser';

const MODE_LABEL: Record<Reading['mode'], string> = {
  VOLTAGE: 'DC Voltage',
  CURRENT: 'DC Current',
  RESISTANCE: 'Resistance',
  CONTINUITY: 'Continuity',
  DIODE: 'Diode',
  CAPACITANCE: 'Capacitance',
};

function calcResolution(display: string, unit: string): string {
  if (!unit || display === 'OL') return '—';
  const dotIdx = display.indexOf('.');
  const decimals = dotIdx === -1 ? 0 : display.length - dotIdx - 1;
  // No fractional digits (e.g. "123" or a trailing-dot "00.") => whole-unit resolution.
  if (decimals < 1) return `1 ${unit}`;
  const res = `0.${'0'.repeat(decimals - 1)}1`;
  return `${res} ${unit}`;
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
  const unit = reading?.unit ?? '';
  const mode = reading ? MODE_LABEL[reading.mode] : 'No signal';
  const resolution = reading ? calcResolution(reading.display, reading.unit) : '—';
  const isOL = display === 'OL';
  const hasReading = reading !== null;

  const valueColor = isOL ? 'text-muted' : recording ? 'text-amber' : 'text-accent';

  return (
    <section className="rounded-xl border border-border bg-panel p-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Current Measurement</h2>
        <div className="flex items-center gap-2">
          {recording && (
            <span className="flex items-center gap-1.5 rounded-md border border-amber/40 px-2 py-0.5 text-xs font-semibold text-amber">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
              REC
            </span>
          )}
          {hasReading && (
            <span className="rounded-md border border-success/40 px-2 py-0.5 text-xs font-semibold text-success">
              LIVE
            </span>
          )}
        </div>
      </div>

      {/* Value */}
      <div className="flex items-end justify-center gap-4 py-5">
        <span
          className={`font-mono text-8xl font-bold leading-none tabular-nums transition-colors ${valueColor}`}
          style={!isOL && hasReading ? { textShadow: '0 0 28px rgba(59,130,246,0.35)' } : undefined}
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
