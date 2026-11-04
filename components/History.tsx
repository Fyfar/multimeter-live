'use client';

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { exportSamplesCsv } from '@/lib/csv';
import { exportVerdictsCsv } from '@/lib/passfail';
import { HISTORY_MAX_AGE_MS, type SessionSummary } from '@/lib/persist';
import { SampleStore } from '@/lib/samples';
import { reasonOf, type SaveStatus, type SessionPersister } from '@/lib/sessionPersister';
import { ConfirmDialog } from './ConfirmDialog';
import { focusMain, modeLabel, sessionButton, sessionName } from './SessionNotices';

const KEEP_DAYS = HISTORY_MAX_AGE_MS / 86_400_000;

// Reads the session back into a scratch store, so the live one is never touched, and writes the
// same file the Data Log / Pass/Fail export would.
async function exportSession(persister: SessionPersister, s: SessionSummary, verdicts: boolean) {
  const a = await persister.readSession(s.id);
  if (verdicts) return exportVerdictsCsv(a.verdicts);
  const store = new SampleStore();
  store.load(a.loadable);
  exportSamplesCsv(store);
}

const SessionRow = memo(function SessionRow({ s, disabled, onRestore, onExport, onDelete }: {
  s: SessionSummary;
  disabled: boolean;
  onRestore: (s: SessionSummary) => void;
  onExport: (s: SessionSummary, verdicts: boolean) => void;
  onDelete: (s: SessionSummary) => void;
}) {
  const name = sessionName(s);
  const hasVerdicts = (s.verdicts ?? 0) > 0;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 text-sm">
        <p className="text-fg">
          {new Date(s.startTs).toLocaleString()}
          {s.mode && <span className="text-muted"> · {modeLabel(s.mode)}</span>}
        </p>
        <p className="text-xs text-muted">
          {s.count.toLocaleString()} samples
          {hasVerdicts && ` · ${s.verdicts} Pass/Fail rows`} · last activity{' '}
          {new Date(s.lastTs).toLocaleString()}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => onRestore(s)} disabled={disabled} aria-label={`Restore ${name}`}
          className={sessionButton('primary')}>
          Restore
        </button>
        <button onClick={() => onExport(s, false)} disabled={disabled} aria-label={`Export CSV of ${name}`}
          className={sessionButton('neutral')}>
          Export CSV
        </button>
        {hasVerdicts && (
          <button onClick={() => onExport(s, true)} disabled={disabled} aria-label={`Export Pass/Fail CSV of ${name}`}
            className={sessionButton('neutral')}>
            Export Pass/Fail CSV
          </button>
        )}
        <button onClick={() => onDelete(s)} disabled={disabled} aria-label={`Delete ${name}`}
          className={sessionButton('danger')}>
          Delete
        </button>
      </div>
    </li>
  );
});

// The kept sessions, re-read whenever storage changes them or this page's hold on it changes.
// null: storage not open yet. Never shown as "no sessions".
function useSessions(persister: SessionPersister, historyRev: number, statusKind: SaveStatus['kind'], onError: (m: string) => void) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  useEffect(() => {
    let current = true;
    persister.list().then(
      (list) => { if (current) setSessions(list); },
      (e: unknown) => { if (current) onError(`Saved sessions could not be read: ${reasonOf(e)}.`); },
    );
    return () => { current = false; };
  }, [persister, historyRev, statusKind, onError]);
  return sessions;
}

function Listing({ status, sessions, children }: {
  status: SaveStatus;
  sessions: SessionSummary[] | null;
  children: (sessions: SessionSummary[]) => ReactNode;
}) {
  const muted = (text: string) => <p className="text-sm text-muted">{text}</p>;
  if (status.kind === 'other-tab') return muted('Sessions are managed by the app open in another tab. Close it to see them here.');
  if (status.kind === 'unavailable') return muted('Sessions are not being saved in this browser, so there is no history.');
  if (sessions === null) return muted('Loading saved sessions…');
  if (sessions.length === 0) return muted('No saved sessions.');
  return children(sessions);
}

// Every kept session but the live one. Restore goes through the page's restore flow (same
// confirmations as the notice) and lands on the Dashboard; export and delete happen here.
export function History({ persister, status, historyRev, restoring, onRestore, onNavigate }: {
  persister: SessionPersister;
  status: SaveStatus;
  historyRev: number;
  restoring: boolean;
  onRestore: (s: SessionSummary, onRestored: () => void) => void;
  onNavigate: (id: 'dashboard') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const sessions = useSessions(persister, historyRev, status.kind, setError);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus goes once a list without the deleted session arrives (an older list can land first).
  const focusAt = useRef<{ index: number; id: number } | null>(null);

  useEffect(() => {
    const at = focusAt.current;
    if (at === null || sessions === null || sessions.some((s) => s.id === at.id)) return;
    focusAt.current = null;
    const rows = listRef.current?.querySelectorAll('li');
    const next = rows?.[Math.min(at.index, rows.length - 1)]?.querySelector('button');
    (next ?? headingRef.current)?.focus();
  }, [sessions]);

  // Focus goes to the Dashboard's content, not lost with the button that started the restore.
  const restore = useCallback((s: SessionSummary) => onRestore(s, () => {
    flushSync(() => onNavigate('dashboard'));
    focusMain();
  }), [onRestore, onNavigate]);

  const handleExport = useCallback(async (s: SessionSummary, verdicts: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await exportSession(persister, s, verdicts);
    } catch (e) {
      setError(`Could not export ${sessionName(s)}: ${reasonOf(e)}.`);
    }
    setBusy(false);
  }, [persister]);

  const confirmDelete = useCallback(async () => {
    const s = deleting;
    setDeleting(null);
    if (s === null) return;
    setBusy(true);
    setError(null);
    focusAt.current = { index: Math.max(0, sessions?.findIndex((x) => x.id === s.id) ?? 0), id: s.id };
    if (!(await persister.remove(s.id))) {
      focusAt.current = null;
      setError(`Could not delete ${sessionName(s)}.`);
    }
    setBusy(false);
  }, [deleting, sessions, persister]);

  return (
    <main tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-5 focus:outline-none">
      <div className="mx-auto max-w-3xl">
        <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-lg font-semibold text-fg focus:outline-none">History</h2>
        <p className="mb-5 text-xs text-muted">
          Sessions are kept in this browser for {KEEP_DAYS} days after their last activity.
        </p>
        {error && <p role="alert" className="mb-4 text-sm text-amber">{error}</p>}
        <Listing status={status} sessions={sessions}>
          {(list) => (
            <ul ref={listRef} className="divide-y divide-border rounded-lg border border-border bg-panel">
              {list.map((s) => (
                <SessionRow key={s.id} s={s} disabled={busy || restoring}
                  onRestore={restore} onExport={handleExport} onDelete={setDeleting} />
              ))}
            </ul>
          )}
        </Listing>
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete this session?"
          body={
            <p>
              This deletes {sessionName(deleting)}, last activity{' '}
              {new Date(deleting.lastTs).toLocaleString()}. It cannot be recovered.
            </p>
          }
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </main>
  );
}
