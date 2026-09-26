'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

// Modal confirm for destructive actions. Cancel holds initial focus so a stray Enter or
// Space right after opening cannot confirm.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Mount-only, separate from the key handler: the parent re-renders at the serial rate,
  // and re-running this would capture Cancel itself as the "opener".
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Two focusable controls: cycle between them; also recovers focus lost to a click
      // on the panel text.
      e.preventDefault();
      const first = cancelRef.current;
      const last = confirmRef.current;
      const goBack = e.shiftKey;
      const at = document.activeElement;
      (goBack ? (at === first ? last : first) : at === last ? first : last)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-danger/40 bg-panel p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
            <AlertTriangle size={20} />
          </span>
          <h2 id="confirm-title" className="text-base font-semibold text-fg">
            {title}
          </h2>
        </div>

        <div id="confirm-body" className="mt-4 text-sm leading-relaxed text-muted">
          {body}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="flex-1 rounded-md border border-border bg-surface py-2 text-sm font-medium text-fg transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="flex-1 rounded-md border border-danger/30 bg-danger/10 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
