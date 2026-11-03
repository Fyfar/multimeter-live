'use client';

import { useCallback, useRef, useState } from 'react';
import type { RestoreResult } from './capture';
import type { Reading } from './parser';
import type { SessionPersister } from './sessionPersister';

/** What the open confirm dialog is about. `otherMode`: the meter's mode, when not the saved one. */
export type PendingConfirm = { kind: 'restore'; otherMode: string | null } | { kind: 'discard' } | null;

/**
 * The operator's side of Restore: ask first when there are live rows or the meter is in another
 * mode, hold the meter's readings while the restore runs, then replay them. Discard always asks.
 * `commit` applies a successful `RestoreResult` to React state; `ingest` is the page's per-batch
 * commit.
 */
export function useRestoreFlow(
  persister: SessionPersister,
  hasRows: boolean,
  commit: (result: RestoreResult) => void,
  ingest: (readings: Reading[]) => void,
) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm>(null);
  const [deferred, setDeferred] = useState(false);
  // Refs, not state: the read loop is async and must see the flag the moment it flips.
  const restoringRef = useRef(false);
  const heldRef = useRef<Reading[][]>([]);

  /** The read loop's entry point: ingests the batch, or holds it while a restore is running. */
  const feed = useCallback((readings: Reading[]) => {
    if (restoringRef.current) heldRef.current.push(readings);
    else ingest(readings);
  }, [ingest]);

  const run = useCallback(async () => {
    restoringRef.current = true;
    setRestoring(true);
    setError(null);
    const out = await persister.restore();
    if (out.ok) commit(out.result);
    else setError(out.reason);
    restoringRef.current = false;
    setRestoring(false);
    // Held readings land after the restored samples, in arrival order — also when the restore
    // failed, against the unchanged live session.
    const held = heldRef.current;
    heldRef.current = [];
    for (const batch of held) ingest(batch);
  }, [persister, commit, ingest]);

  const request = useCallback(() => {
    const otherMode = persister.otherLiveMode();
    if (hasRows || otherMode !== null) setPending({ kind: 'restore', otherMode });
    else void run();
  }, [persister, hasRows, run]);
  const confirm = useCallback(() => {
    setPending(null);
    if (pending?.kind === 'discard') void persister.discard();
    else void run();
  }, [pending, persister, run]);

  return {
    restoring,
    error,
    pending,
    deferred,
    feed,
    request,
    confirm,
    cancel: useCallback(() => setPending(null), []),
    defer: useCallback(() => setDeferred(true), []),
    dismissError: useCallback(() => setError(null), []),
    discard: useCallback(() => setPending({ kind: 'discard' }), []),
  };
}
