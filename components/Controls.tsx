'use client';

import { Download, Play, Square, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Toggle } from '@/components/Toggle';

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-xs font-semibold text-fg">{children}</h3>;
}

export function ActionButton({
  onClick,
  icon,
  label,
  variant = 'default',
  disabled,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: 'default' | 'active' | 'danger' | 'success';
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'active' && 'border-amber/30 bg-amber/10 text-amber hover:bg-amber/20',
        variant === 'danger' && 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
        variant === 'success' && 'border-success/30 bg-success/10 text-success hover:bg-success/20',
        variant === 'default' && 'border-border text-muted hover:bg-surface hover:text-fg',
      )}
    >
      {icon}
      {label}
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
  triggerThreshold,
  onTriggerThresholdChange,
  triggerArmed,
  onTriggerArmedChange,
  canArm,
  triggerUnit,
  recording,
  onToggleRecord,
  canRecord,
  stableOnly,
  onStableOnlyChange,
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
  triggerThreshold: string;
  onTriggerThresholdChange: (v: string) => void;
  triggerArmed: boolean;
  onTriggerArmedChange: (v: boolean) => void;
  canArm: boolean;
  triggerUnit: string;
  recording: boolean;
  onToggleRecord: () => void;
  canRecord: boolean;
  stableOnly: boolean;
  onStableOnlyChange: (v: boolean) => void;
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

        {/* Trigger */}
        <div>
          <SectionHeader>Trigger</SectionHeader>

          <div className="mb-3 flex items-center justify-between">
            <span className={clsx('text-xs', canArm ? 'text-muted' : 'text-border')}>
              Auto-start on trigger
            </span>
            <Toggle checked={triggerArmed} onChange={onTriggerArmedChange} disabled={!canArm} />
          </div>

          <RangeField
            label={triggerUnit ? `Threshold (${triggerUnit})` : 'Threshold'}
            value={triggerThreshold}
            onChange={onTriggerThresholdChange}
            placeholder="0"
          />
        </div>

        <hr className="border-border" />

        {/* Quick Actions */}
        <div>
          <SectionHeader>Quick Actions</SectionHeader>

          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-muted">Stable values only</span>
            <Toggle checked={stableOnly} onChange={onStableOnlyChange} />
          </div>

          <div className="space-y-1.5">
            <ActionButton
              onClick={onToggleRecord}
              icon={recording ? <Square size={12} /> : <Play size={12} />}
              label={recording ? 'Stop Logging' : 'Start Logging'}
              variant={recording ? 'danger' : 'success'}
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
              variant="danger"
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
        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-right text-xs font-mono text-fg placeholder:text-border focus:border-accent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}

