'use client';

import { useEffect, useRef } from 'react';
import {
  Chart,
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip, Legend);

export interface ChartPoint {
  ts: number;       // Date.now() when the reading was parsed
  v: number | null; // normalized value (null = OL -> line gap)
  oor?: boolean;    // out-of-range: outside user-defined min/max
}

export type TimeRange = '10s' | '1m' | '5m' | '1h';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '10s': 10_000,
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

const TIME_RANGE_LABELS: TimeRange[] = ['10s', '1m', '5m', '1h'];

export function RealtimeChart({
  data,
  unit,
  yMin,
  yMax,
  timeRange,
  onTimeRangeChange,
}: {
  data: ChartPoint[];
  unit: string;
  yMin?: number;
  yMax?: number;
  timeRange: TimeRange;
  onTimeRangeChange: (r: TimeRange) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'value',
            data: [],
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.07)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0,
            spanGaps: false,
            normalized: true,
            fill: true,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: {
            ticks: {
              color: '#8b949e',
              maxTicksLimit: 9,
              maxRotation: 0,
              minRotation: 0,
              font: { size: 11, family: 'var(--font-geist-mono)' },
            },
            grid: { color: 'rgba(48,54,61,0.5)' },
            border: { color: 'rgba(48,54,61,0.5)' },
          },
          y: {
            title: { display: true, text: unit, color: '#8b949e', font: { size: 11 } },
            ticks: {
              color: '#8b949e',
              font: { size: 11, family: 'var(--font-geist-mono)' },
            },
            grid: { color: 'rgba(48,54,61,0.5)' },
            border: { color: 'rgba(48,54,61,0.5)' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1c2128',
            borderColor: '#30363d',
            borderWidth: 1,
            titleColor: '#f0f6fc',
            bodyColor: '#8b949e',
            titleFont: { family: 'var(--font-geist-mono)', size: 11 },
            bodyFont: { family: 'var(--font-geist-mono)', size: 12 },
            padding: 8,
          },
        },
      },
    });
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const now = Date.now();
    const windowMs = TIME_RANGE_MS[timeRange];
    const filtered = data.filter((p) => now - p.ts <= windowMs);
    const latestTs = filtered.length > 0 ? filtered[filtered.length - 1].ts : now;

    const labels: string[] = [];
    const values: (number | null)[] = [];
    const radii: number[] = [];
    const colors: string[] = [];

    for (const d of filtered) {
      const offsetSec = Math.round((d.ts - latestTs) / 1000);
      labels.push(offsetSec === 0 ? 'Now' : `${offsetSec}s`);
      values.push(d.v);
      radii.push(d.oor ? 4 : 0);
      colors.push(d.oor ? '#ef4444' : '#3b82f6');
    }

    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = chart.data.datasets[0] as any;
    ds.pointRadius = radii;
    ds.pointBackgroundColor = colors;
    ds.pointBorderColor = colors;

    const yScale = chart.options.scales?.y as
      | { title?: { text?: string }; min?: number; max?: number }
      | undefined;
    if (yScale) {
      if (yScale.title) yScale.title.text = unit;
      yScale.min = yMin; // undefined => Chart.js auto-scales
      yScale.max = yMax;
    }
    chart.update('none');
  }, [data, unit, yMin, yMax, timeRange]);
  /* eslint-enable react-hooks/immutability */

  return (
    <section className="rounded-xl border border-border bg-panel p-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Measurement Over Time</h2>
        <div className="flex overflow-hidden rounded-lg border border-border">
          {TIME_RANGE_LABELS.map((r) => (
            <button
              key={r}
              onClick={() => onTimeRangeChange(r)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                timeRange === r
                  ? 'bg-accent text-white'
                  : 'text-muted hover:bg-surface hover:text-fg'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Chart canvas */}
      <div className="relative h-56">
        <canvas ref={canvasRef} />
      </div>
    </section>
  );
}
