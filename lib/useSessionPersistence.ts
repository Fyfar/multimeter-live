'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { Reading } from './parser';
import type { PersistSnapshot, SessionPersister } from './sessionPersister';
import { useRestoreFlow } from './useRestoreFlow';
import { useUnloadGuard } from './useUnloadGuard';

/**
 * The page's whole saved-session wiring: starts the persister on mount, exposes its status,
 * guards unload while there are rows, and runs the Restore flow (`commit`/`ingest`: see
 * `useRestoreFlow`). `status`, `previous` and `historyRev` change at flush rate, never per sample, so reading
 * them does not put the hot path back into render.
 */
export function useSessionPersistence(
  persister: SessionPersister,
  hasRows: boolean,
  commit: () => void,
  ingest: (readings: Reading[]) => void,
): PersistSnapshot & { restore: ReturnType<typeof useRestoreFlow> } {
  useEffect(() => {
    void persister.start();
    return () => persister.dispose();
  }, [persister]);
  const snap = useSyncExternalStore(persister.subscribe, persister.getSnapshot, persister.getSnapshot);
  useUnloadGuard(hasRows);
  const restore = useRestoreFlow(persister, hasRows, commit, ingest);
  return { ...snap, restore };
}
