'use client';

import { useEffect, useRef } from 'react';
import { Keyboard } from 'lucide-react';

const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: 'Space', does: 'Start / stop logging (Dashboard, Data Log)' },
  { keys: '1 – 5', does: 'Dashboard, Data Log, Pass/Fail, History, Settings' },
  { keys: 'H', does: 'Chart: Line / Histogram (Dashboard)' },
  { keys: '?', does: 'Show or hide this list' },
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <ShortcutHelpDialog onClose={onClose} /> : null;
}

// Separate so the focus capture below is mount-only.
function ShortcutHelpDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Mount-only, like ConfirmDialog: the page re-renders at serial rate, and re-running this
  // would capture the Close button itself as the "opener".
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        // One focusable control: keep focus on it.
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-panel p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Keyboard size={20} />
          </span>
          <h2 id="shortcut-title" className="text-base font-semibold text-fg">
            Keyboard shortcuts
          </h2>
        </div>

        <dl className="mt-4 space-y-2 text-sm">
          {SHORTCUTS.map(({ keys, does }) => (
            <div key={keys} className="flex items-baseline gap-4">
              <dt className="w-16 shrink-0">
                <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-fg">
                  {keys}
                </kbd>
              </dt>
              <dd className="text-muted">{does}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted">
          Shortcuts are off while you type in a field or while a dialog is open.
        </p>

        <button
          ref={closeRef}
          onClick={onClose}
          className="mt-6 w-full rounded-md border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg transition-colors hover:brightness-125"
        >
          Close
        </button>
      </div>
    </div>
  );
}
