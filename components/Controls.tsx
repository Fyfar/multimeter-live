'use client';

import { Download, Play, Square, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-xs font-semibold text-fg">{children}</h3>;
}

function ActionButton({
  onClick,
  icon,
  label,
  variant = 'default',
  disabled,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: 'default' | 'active' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'active' && 'border-amber/30 bg-amber/10 text-amber hover:bg-amber/20',
        variant === 'danger' && 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
        variant === 'default' && 'border-border text-muted hover:bg-surface hover:text-fg',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 flex-shrink-0 rounded-full transition-colors',
        checked ? 'bg-accent' : 'border border-border bg-surface',
      )}
    >
      <span
        className={clsx(
          'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Controls({
  rangeMin,
  rangeMax,
  onRangeMinChange,
  onRangeMaxChange,
  autoScale,
  onAutoScaleChange,
  recording,
  onToggleRecord,
  canRecord,
  onClear,
  onExportCsv,
  canExport,
}: {
  rangeMin: string;
  rangeMax: string;
  onRangeMinChange: (v: string) => void;
  onRangeMaxChange: (v: string) => void;
  autoScale: boolean;
  onAutoScaleChange: (v: boolean) => void;
  recording: boolean;
  onToggleRecord: () => void;
  canRecord: boolean;
  onClear: () => void;
  onExportCsv: () => void;
  canExport: boolean;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-l border-border bg-canvas">
      <div className="space-y-5 p-4">

        {/* Chart Range */}
        <div>
          <SectionHeader>Chart Range</SectionHeader>

          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-muted">Auto Scale</span>
            <Toggle checked={autoScale} onChange={onAutoScaleChange} />
          </div>

          <div className={`space-y-2.5 transition-opacity ${autoScale ? 'pointer-events-none opacity-35' : ''}`}>
            <RangeField
              label="Minimum"
              value={rangeMin}
              onChange={onRangeMinChange}
              placeholder="0"
            />
            <RangeField
              label="Maximum"
              value={rangeMax}
              onChange={onRangeMaxChange}
              placeholder="auto"
            />
          </div>
        </div>

        <hr className="border-border" />

        {/* Quick Actions */}
        <div>
          <SectionHeader>Quick Actions</SectionHeader>
          <div className="space-y-1.5">
            <ActionButton
              onClick={onToggleRecord}
              icon={recording ? <Square size={12} /> : <Play size={12} />}
              label={recording ? 'Stop Logging' : 'Start Logging'}
              variant={recording ? 'active' : 'default'}
              disabled={!recording && !canRecord}
            />
            <ActionButton
              onClick={onExportCsv}
              icon={<Download size={12} />}
              label="Export CSV"
              disabled={!canExport}
            />
            <ActionButton
              onClick={onClear}
              icon={<Trash2 size={12} />}
              label="Clear Data"
            />
          </div>
        </div>

      </div>
    </aside>
  );
}

function RangeField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="block text-xs text-muted">{label}</label>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-right text-xs font-mono text-fg placeholder:text-border focus:border-accent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}

