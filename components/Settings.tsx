'use client';

import { useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Toggle } from '@/components/Toggle';
import {
  clampHysteresisPct,
  clampStabilityCount,
  MAX_HYSTERESIS_PCT,
  MIN_HYSTERESIS_PCT,
  MIN_STABILITY_COUNT,
} from '@/lib/settings';

// Question-mark affordance: reveals its explanation on hover AND keyboard focus
// (focus-within covers the focused trigger), so the help is not pointer-only.
function InfoTooltip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-describedby={id}
        aria-label="More information"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted transition-colors hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <HelpCircle size={14} />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-10 w-64 -translate-x-1/2 rounded-md border border-border bg-surface p-2.5 text-xs leading-relaxed text-muted opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-fg">{label}</span>
        <InfoTooltip text={help} />
      </div>
      {children}
    </div>
  );
}

// Numeric setting with a local draft so typing isn't fought by per-keystroke clamping;
// the clamped value is committed to the parent on blur or Enter.
function NumberSetting({
  value,
  onCommit,
  clamp,
  min,
  max,
  step,
  suffix,
}: {
  value: number;
  onCommit: (v: number) => void;
  clamp: (n: number) => number;
  min: number;
  max?: number;
  step: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  // Keep the draft in sync if `value` ever changes from outside this field (e.g. a
  // future reset elsewhere). Adjusting during render — React's recommended pattern for
  // this — avoids the extra paint an effect would cause; a commit-driven change is a
  // no-op here since `draft` already holds the committed string.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="w-20 rounded-md border border-border bg-surface px-2.5 py-1.5 text-right text-xs font-mono text-fg focus:border-accent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix && <span className="w-4 text-xs text-muted">{suffix}</span>}
    </div>
  );
}

const HELP = {
  stability:
    'How many consecutive equal readings the meter must report before a value counts as "stable" for the "Stable values only" log filter. Higher means stricter confirmation and fewer logged points. Minimum 2 (two readings are needed to confirm equality).',
  hysteresis:
    'When logging is auto-started by the trigger, how far below the trigger threshold the reading must fall before logging auto-stops. A wider dead-band stops a signal hovering near the threshold from flapping logging on and off.',
  preserve:
    'Off (default): switching the meter’s measurement mode clears all logged data. On: the recorded table and CSV are kept across a mode change (each row keeps its own mode/unit), while the live chart and statistics still reset — they show a single unit and can’t mix.',
  noDataWarning:
    'Shows a full-screen warning when the port is connected but no measurements arrive for a few seconds — usually the meter is off or the cable between the adapter and the meter is unplugged/broken (the adapter itself is fine). Purely informational: dismiss it with OK and the connection keeps running. It returns if data resumes and then stops again.',
  noDataAudio:
    'Plays a repeating beep while the no-data warning is on screen, so you notice it without watching the display. Stops as soon as the warning is dismissed or data resumes. Requires the warning above to be enabled.',
} as const;

export function Settings({
  stabilityCount,
  onStabilityCountChange,
  hysteresisPct,
  onHysteresisPctChange,
  preserveOnModeChange,
  onPreserveOnModeChangeChange,
  noDataWarning,
  onNoDataWarningChange,
  noDataAudio,
  onNoDataAudioChange,
}: {
  stabilityCount: number;
  onStabilityCountChange: (v: number) => void;
  hysteresisPct: number;
  onHysteresisPctChange: (v: number) => void;
  preserveOnModeChange: boolean;
  onPreserveOnModeChangeChange: (v: boolean) => void;
  noDataWarning: boolean;
  onNoDataWarningChange: (v: boolean) => void;
  noDataAudio: boolean;
  onNoDataAudioChange: (v: boolean) => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-1 text-lg font-semibold text-fg">Settings</h2>
        <p className="mb-5 text-xs text-muted">
          Tune logging behavior. Changes are saved automatically and persist across reloads.
        </p>

        <section className="rounded-lg border border-border bg-panel">
          <header className="border-b border-border px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Logging</h3>
          </header>
          <div className="divide-y divide-border px-4">
            <SettingRow label="Stable readings to confirm" help={HELP.stability}>
              <NumberSetting
                value={stabilityCount}
                onCommit={onStabilityCountChange}
                clamp={clampStabilityCount}
                min={MIN_STABILITY_COUNT}
                step={1}
              />
            </SettingRow>
            <SettingRow label="Trigger hysteresis" help={HELP.hysteresis}>
              <NumberSetting
                value={hysteresisPct}
                onCommit={onHysteresisPctChange}
                clamp={clampHysteresisPct}
                min={MIN_HYSTERESIS_PCT}
                max={MAX_HYSTERESIS_PCT}
                step={1}
                suffix="%"
              />
            </SettingRow>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-border bg-panel">
          <header className="border-b border-border px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Data</h3>
          </header>
          <div className="px-4">
            <SettingRow label="Keep log on mode change" help={HELP.preserve}>
              <Toggle checked={preserveOnModeChange} onChange={onPreserveOnModeChangeChange} />
            </SettingRow>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-border bg-panel">
          <header className="border-b border-border px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Alerts</h3>
          </header>
          <div className="divide-y divide-border px-4">
            <SettingRow label="Warn when connected but no data" help={HELP.noDataWarning}>
              <Toggle checked={noDataWarning} onChange={onNoDataWarningChange} />
            </SettingRow>
            <SettingRow label="Sound an audio alert" help={HELP.noDataAudio}>
              <Toggle checked={noDataAudio} onChange={onNoDataAudioChange} disabled={!noDataWarning} />
            </SettingRow>
          </div>
        </section>
      </div>
    </main>
  );
}
