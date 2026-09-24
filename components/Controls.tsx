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
  rangeInvalid,
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
  canClear,
  onExportCsv,
  canExport,
}: {
  rangeMin: string;
  rangeMax: string;
  /** Minimum is not below maximum. The chart ignores the range while this is true; say so
   *  rather than silently auto-scaling and leaving the operator to wonder. */
  rangeInvalid: boolean;
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
  /** Whether the session holds anything to clear. Matches the Data Log's Clear Log, which
   *  has always been gated this way. NOT gated on the connection: a session captured and
   *  then unplugged is exactly when an operator wants to clear it. */
  canClear: boolean;
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
              invalid={rangeInvalid}
            />
            <RangeField
              label="Maximum"
              value={rangeMax}
              onChange={onRangeMaxChange}
              placeholder="auto"
              invalid={rangeInvalid}
            />
            {rangeInvalid && (
              <p className="text-[11px] text-danger">
                Minimum must be below maximum — auto-scaling until it is.
              </p>
            )}
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

          <div className="mb-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Log distinct parts only</span>
              <Toggle checked={stableOnly} onChange={onStableOnlyChange} />
            </div>
            {/* The behaviour surprised an operator who expected every settled reading to be
                recorded: a second gate suppresses changes under 50%, so measuring ONE part
                records exactly one entry and nothing appears to happen. Say so here rather
                than leaving it to be discovered. */}
            <p className="mt-1 pr-10 text-[11px] leading-relaxed text-muted/70">
              Records one entry each time a reading settles on a <em>new</em> part: measure,
              swap the component, measure again. A settled value within 50% of the last one
              is treated as the same part and not recorded, so a single part logs once.
            </p>
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
              disabled={!canClear}
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
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
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
        className={clsx(
          'mt-1 w-full rounded-md border bg-surface px-2.5 py-1.5 text-right text-xs font-mono text-fg placeholder:text-border focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          invalid ? 'border-danger focus:border-danger' : 'border-border focus:border-accent',
        )}
      />
    </div>
  );
}

