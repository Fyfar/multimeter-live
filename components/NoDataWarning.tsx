'use client';

import { AlertTriangle } from 'lucide-react';

// Whole-page, dismissible warning shown when the port is connected but no measurement
// data is arriving. Purely informational — dismissing it changes nothing about the
// connection or recording; it only hides this overlay (see page.tsx re-arm logic).
export function NoDataWarning({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="no-data-title"
      aria-describedby="no-data-body"
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-amber/40 bg-panel p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber/15 text-amber">
            <AlertTriangle size={20} />
          </span>
          <h2 id="no-data-title" className="text-base font-semibold text-fg">
            Connected, but no data received
          </h2>
        </div>

        <div id="no-data-body" className="mt-4 space-y-2 text-sm leading-relaxed text-muted">
          <p>
            The USB-to-UART adapter is connected and working, but no measurements are
            coming through. The likely causes:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>The multimeter is turned off.</li>
            <li>The cable between the adapter and the meter is unplugged or broken.</li>
          </ul>
          <p>Check the meter and the lead, then continue. The connection stays open.</p>
        </div>

        <button
          onClick={onDismiss}
          autoFocus
          className="mt-6 w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          OK
        </button>
      </div>
    </div>
  );
}
