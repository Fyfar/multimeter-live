'use client';

import { clsx } from 'clsx';
import { formatSiValue } from '@/lib/si';
import type { SessionStats } from '@/lib/capture';

export function StatisticsPanel({
  stats,
  baseUnit,
  resolution,
  layout = 'grid',
  title = 'Statistics',
  bare = false,
}: {
  stats: SessionStats | null;
  // Raw SCALE base unit token ('OM'/'V'/'A'/'nF' — see lib/parser.ts), NOT the
  // display-converted string. Each entry picks its own SI prefix and composes its own
  // suffix from this (lib/si.ts), so a 11.13 MΩ average can sit next to a 21.00 kΩ
  // peak-to-peak without forcing one shared scale.
  baseUnit: string;
  // Measurement resolution, in the SAME base unit as `stats` (e.g. 1 for 1 Ω, 0.0001 for
  // 0.0001 V). Undefined when the device resolution isn't known → 3 dp fallback.
  resolution?: number;
  // 'grid' (default) = the Dashboard's 3/6-col layout; 'stack' = single column for
  // the narrow Data Log sidebar. Both render the same entries/formatting.
  layout?: 'grid' | 'stack';
  title?: string;
  // When true, render without the card chrome (no bordered `bg-panel` section) so it
  // sits as a flat section inside an existing panel (the Data Log right sidebar).
  bare?: boolean;
}) {
  const isEmpty = !stats || stats.count === 0;

  const avg = isEmpty ? 0 : stats.mean;
  const min = isEmpty ? 0 : stats.min;
  const max = isEmpty ? 0 : stats.max;
  const peakToPeak = max - min;
  const stdDev = isEmpty || stats.count < 2 ? 0 : Math.sqrt(stats.m2 / stats.count);

  // Min/Max/P2P are real device-grid values → the resolution's own decimal count.
  // Average/Std-Dev resolve below 1 LSD by averaging noise → 2 extra decimals.
  const row = (v: number, extraDecimals: number) => {
    if (isEmpty) return { value: '—', sub: undefined };
    const { text, unit } = formatSiValue(baseUnit, v, resolution, extraDecimals);
    return { value: text, sub: unit };
  };

  const entries: { label: string; value: string; sub?: string; color: string }[] = [
    { label: 'Average', ...row(avg, 2), color: 'text-fg' },
    { label: 'Minimum', ...row(min, 0), color: 'text-success' },
    { label: 'Maximum', ...row(max, 0), color: 'text-danger' },
    { label: 'Peak to Peak', ...row(peakToPeak, 0), color: 'text-fg' },
    { label: 'Samples', value: isEmpty ? '—' : stats.count.toLocaleString('en'), color: 'text-fg' },
    { label: 'Std Deviation', ...row(stdDev, 2), color: 'text-fg' },
  ];

  const isStack = layout === 'stack';

  const body = (
    <div className={clsx(isStack ? 'flex flex-col gap-2.5' : 'grid grid-cols-3 gap-3 sm:grid-cols-6')}>
      {entries.map((s) => (
        <div
          key={s.label}
          className={clsx('rounded border border-border py-3', isStack ? 'px-4' : 'px-3 text-center')}
        >
          <p className="text-xs text-muted">{s.label}</p>
          <p className={clsx('mt-1.5 font-mono text-lg font-semibold tabular-nums', s.color)}>
            {s.value}
            {s.sub && s.value !== '—' && (
              <span className="ml-0.5 text-xs font-normal text-muted">{s.sub}</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );

  // Bare: flat section (matches the Controls sidebar's section style) — no card chrome.
  if (bare) {
    return (
      <div>
        <h3 className="mb-3 text-xs font-semibold text-fg">{title}</h3>
        {body}
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      <h2 className="mb-4 text-sm font-semibold text-fg">{title}</h2>
      {body}
    </section>
  );
}
