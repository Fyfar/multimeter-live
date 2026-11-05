'use client';

import { useCallback, useRef, useState } from 'react';
import type { Reading } from './parser';
import type { SessionSummary } from './persist';
import type { SessionPersister } from './sessionPersister';

/** The restore awaiting confirmation. `otherMode`: the meter's mode, when not the target's. */
export type PendingConfirm = {
  target: SessionSummary;
  otherMode: string | null;
  onRestored?: () => void;
} | null;

/**
 * The operator's side of Restore, from the notice or History: ask first when there are live rows
 * or the meter is in another mode, hold the meter's readings while the restore runs, then replay
 * them. `commit` publishes a successful restore to React state; `ingest` is the page's per-batch
 * commit.
 */
export function useRestoreFlow(
  persister: SessionPersister,
  hasRows: boolean,
  commit: () => void,
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

  // A second run while one is in flight would reset the flag early and replay held readings into
  // a store about to be replaced.
  const run = useCallback(async (target: SessionSummary, onRestored?: () => void) => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    setError(null);
    // Never left pending on a throw: `restoringRef` would then hold every later reading.
    const out = await persister.restore(target.id).catch((e: unknown) => ({ ok: false as const, reason: String(e) }));
    if (out.ok) { commit(); onRestored?.(); }
    else setError(out.reason);
    restoringRef.current = false;
    setRestoring(false);
    // Held readings land after the restored samples, in arrival order — also when the restore
    // failed, against the unchanged live session.
    const held = heldRef.current;
    heldRef.current = [];
    for (const batch of held) ingest(batch);
  }, [persister, commit, ingest]);

  const request = useCallback((target: SessionSummary, onRestored?: () => void) => {
    if (restoringRef.current) return;
    const otherMode = persister.otherLiveMode(target.mode);
    if (hasRows || otherMode !== null) setPending({ target, otherMode, onRestored });
    else void run(target, onRestored);
  }, [persister, hasRows, run]);
  const confirm = useCallback(() => {
    setPending(null);
    if (pending !== null) void run(pending.target, pending.onRestored);
  }, [pending, run]);

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
    discard: useCallback(() => { void persister.discard(); }, [persister]),
  };
}
