'use client';

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { MODE_LABELS, type Mode } from '@/lib/parser';
import type { SessionSummary } from '@/lib/persist';
import type { SaveStatus } from '@/lib/sessionPersister';
import type { PendingConfirm } from '@/lib/useRestoreFlow';
import { ConfirmDialog } from './ConfirmDialog';

// A stored mode is a string; an unknown one (newer app version) shows as stored.
export const modeLabel = (m: string): string => MODE_LABELS[m as Mode] ?? m;

/** Names a kept session in dialogs and accessible names. */
export const sessionName = (s: SessionSummary): string =>
  `the session from ${new Date(s.startTs).toLocaleString()} (${s.count.toLocaleString()} samples)`;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
};

// Local to the indicator, so its once-a-second tick re-renders one span, not the page.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// Says whether the session is being saved. Absent while nothing has been recorded. Below `sm`
// only the dot shows; the text stays in the DOM for assistive tech.
export function SaveIndicator({ status }: { status: SaveStatus }) {
  const now = useNow(status.kind === 'saved');
  if (status.kind === 'idle') return null;
  const saved = status.kind === 'saved';
  const label = saved
    ? `Saved ${ago(now - status.at)}`
    : status.kind === 'other-tab' ? 'Saved by another tab' : 'Not saved';
  return (
    <span title={label} className="flex items-center gap-1.5 text-xs">
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', saved ? 'bg-success' : 'bg-amber')} />
      <span className={clsx('max-sm:sr-only', saved ? 'text-muted' : 'text-amber')}>{label}</span>
    </span>
  );
}

const BUTTON = 'rounded-md border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';
const VARIANT = {
  primary: 'border-accent bg-accent text-white hover:brightness-110',
  neutral: 'border-border bg-surface text-fg hover:brightness-110',
  danger: 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
};
export const sessionButton = (v: keyof typeof VARIANT) => clsx(BUTTON, VARIANT[v]);

export const focusMain = () => document.querySelector<HTMLElement>('main')?.focus();

export function SessionNotices({
  previous, deferred, status, restoring, restoreError, onRestore, onLater, onDiscard, onDismissError,
}: {
  previous: SessionSummary | null;
  deferred: boolean;
  status: SaveStatus;
  restoring: boolean;
  restoreError: string | null;
  onRestore: (s: SessionSummary) => void;
  onLater: () => void;
  onDiscard: () => void;
  onDismissError: () => void;
}) {
  const otherTab = status.kind === 'other-tab';
  const offer = deferred ? null : previous;
  // The offer's buttons unmount with it (Restore, Later, Discard), which drops
  // keyboard focus to <body>; hand it to the visible view instead.
  const offered = useRef(false);
  useEffect(() => {
    if (offer) offered.current = true;
    else if (offered.current) {
      offered.current = false;
      if (document.activeElement === document.body) focusMain();
    }
  }, [offer]);
  if (!offer && !restoreError && !otherTab) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-panel px-5 py-2 text-sm max-sm:px-3">
      {offer && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 text-muted">
            <strong className="text-fg">Previous session saved:</strong>{' '}
            {offer.count.toLocaleString()} samples{offer.mode && ` in ${modeLabel(offer.mode)}`}, last recorded{' '}
            {new Date(offer.lastTs).toLocaleString()}. Discard keeps it in History.
          </p>
          <div className="flex gap-2">
            <button onClick={() => onRestore(offer)} disabled={restoring}
              className={sessionButton('primary')}>
              {restoring ? 'Restoring…' : 'Restore'}
            </button>
            <button onClick={onLater} disabled={restoring}
              className={sessionButton('neutral')}>
              Later
            </button>
            <button onClick={onDiscard} disabled={restoring}
              className={sessionButton('danger')}>
              Discard
            </button>
          </div>
        </div>
      )}
      {restoreError && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p role="alert" className="min-w-0 flex-1 text-amber">
            The session could not be restored: {restoreError}. It is still kept in History.
          </p>
          <button onClick={onDismissError} className={sessionButton('neutral')}>
            OK
          </button>
        </div>
      )}
      {otherTab && (
        <p role="status" className="text-amber">
          This session is saved by another tab, so nothing recorded in this tab is saved and no
          earlier session is offered here.
        </p>
      )}
    </div>
  );
}

// Restore asks first when it replaces a live session or the meter is in another mode. `keep`:
// whether ending the live session now would keep it in History.
export function SessionConfirm({ pending, samples, verdictRows, keep, onConfirm, onCancel }: {
  pending: PendingConfirm;
  samples: number;
  verdictRows: number;
  keep: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (pending === null) return null;
  const replaces = samples > 0 || verdictRows > 0;
  const { target, otherMode } = pending;
  return (
    <ConfirmDialog
      title={replaces ? 'Replace the current session?' : 'Restore in another mode?'}
      body={
        <>
          <p>
            Restore {sessionName(target)}, last recorded {new Date(target.lastTs).toLocaleString()}.
          </p>
          {replaces && (
            <p className="mt-3">
              The current session holds{' '}
              <strong className="text-fg">{samples.toLocaleString()} recorded samples</strong>
              {verdictRows > 0 && ` and ${verdictRows} Pass/Fail rows`}.{' '}
              {keep
                ? 'Restoring replaces them; they move to History.'
                : 'Restoring replaces them; they will not be kept and cannot be recovered. Export a CSV first if you need them.'}
            </p>
          )}
          {otherMode !== null && target.mode !== null && (
            <p className="mt-3">
              The meter is in <strong className="text-fg">{modeLabel(otherMode)}</strong>, but the
              saved session was recorded in{' '}
              <strong className="text-fg">{modeLabel(target.mode)}</strong>. Its rows stay in
              the Data Log and the CSV, but the chart and statistics start empty from the next
              reading.
            </p>
          )}
        </>
      }
      confirmLabel="Restore"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

// Clear Data and Clear Log share it. Promises History only when the session will really be kept.
export function ClearConfirm({ samples, keep, onConfirm, onCancel }: {
  samples: number;
  keep: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const n = <strong className="text-fg">{samples.toLocaleString()} recorded samples</strong>;
  return (
    <ConfirmDialog
      title="Clear all recorded data?"
      body={keep ? (
        <p>
          This clears {n} from the chart, statistics and Data Log. They move to History, where
          you can restore or export them.
        </p>
      ) : (
        <p>
          This removes {n} from the chart, statistics and Data Log. They will not be kept and
          cannot be recovered. Export a CSV first if you need them.
        </p>
      )}
      confirmLabel="Clear data"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
