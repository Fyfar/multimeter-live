'use client';

function fmt(v: number, decimals = 3): string {
  return v.toFixed(decimals);
}

export type SessionStats = { count: number; mean: number; m2: number; min: number; max: number };

export function StatisticsPanel({ stats, unit }: { stats: SessionStats | null; unit: string }) {
  const isEmpty = !stats || stats.count === 0;

  const avg = isEmpty ? 0 : stats.mean;
  const min = isEmpty ? 0 : stats.min;
  const max = isEmpty ? 0 : stats.max;
  const peakToPeak = max - min;
  const stdDev = isEmpty || stats.count < 2 ? 0 : Math.sqrt(stats.m2 / stats.count);

  const entries: { label: string; value: string; sub?: string; color: string }[] = [
    { label: 'Average', value: isEmpty ? '—' : fmt(avg), sub: unit, color: 'text-fg' },
    { label: 'Minimum', value: isEmpty ? '—' : fmt(min), sub: unit, color: 'text-success' },
    { label: 'Maximum', value: isEmpty ? '—' : fmt(max), sub: unit, color: 'text-danger' },
    { label: 'Peak to Peak', value: isEmpty ? '—' : fmt(peakToPeak), sub: unit, color: 'text-fg' },
    { label: 'Samples', value: isEmpty ? '—' : stats.count.toLocaleString('en'), color: 'text-fg' },
    { label: 'Std Deviation', value: isEmpty ? '—' : fmt(stdDev), sub: unit, color: 'text-fg' },
  ];

  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      <h2 className="mb-4 text-sm font-semibold text-fg">Statistics</h2>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {entries.map((s) => (
          <div key={s.label} className="rounded border border-border px-3 py-3 text-center">
            <p className="text-xs text-muted">{s.label}</p>
            <p className={`mt-1.5 font-mono text-lg font-semibold tabular-nums ${s.color}`}>
              {s.value}
              {s.sub && s.value !== '—' && (
                <span className="ml-0.5 text-xs font-normal text-muted">{s.sub}</span>
              )}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
