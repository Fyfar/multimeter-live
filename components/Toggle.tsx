'use client';

import { clsx } from 'clsx';

// Shared switch control. Extracted from Controls.tsx so the Settings view can reuse
// the exact same affordance (and so there is a single source of truth for its style).
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
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
