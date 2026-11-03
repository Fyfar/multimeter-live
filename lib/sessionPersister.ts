// Keeps a durable copy of the live session in IndexedDB, behind it: RAM (`SampleStore`) stays the
// working set and nothing here is read by the chart, the Data Log or `ingest`. No React; the hook
// is `useSessionPersistence`. Decisions are `lib/persist.ts`, I/O is `lib/sessionDb.ts`.
//
// Never harms capture: every storage error becomes a status, nothing throws into the caller,
// and nothing runs inside `ingest`. The page calls `tick()` once per batch, which only reads the
// clock.

import type { CaptureEngine, RestoreResult } from './capture';
import type { VerdictRow } from './passfail';
import {
  adoptedMark, assembleSession, planFlush, planLoad,
  type FlushMark, type FlushPlan, type FlushView, type SessionSummary,
} from './persist';
import { MODES, type SampleStore } from './samples';
import { SessionDb, type Batch } from './sessionDb';

const FLUSH_MS = 5000;
// A reload can race the old document's teardown, which releases the lock only when it dies.
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 200;
const LOCK_RETRY_MS = 5000;
const OPEN_TIMEOUT_MS = 4000;
const RESTORE_TIMEOUT_MS = 5000;
// Every write is bounded, so one that never completes cannot stall the queue (and a Restore
// waiting behind it) for good. A 7-day session rewritten whole took ~1 s in Chrome.
const WRITE_TIMEOUT_MS = 10_000;
const LOCK_NAME = 'multimeter-live:session';

export type SaveStatus =
  | { kind: 'idle' } // nothing recorded, or not started yet
  | { kind: 'saved'; at: number }
  | { kind: 'failed' }
  | { kind: 'other-tab' }
  | { kind: 'unavailable' };

export interface PreviousSession {
  count: number;
  lastTs: number;
  mode: string | null;
}

export interface PersistSnapshot {
  status: SaveStatus;
  previous: PreviousSession | null;
}

export type RestoreOutcome = { ok: true; result: RestoreResult } | { ok: false; reason: string };

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('storage did not respond')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The lock's release once granted, or null if another page holds it. Held until this page
// dies (or dispose): the browser releases it with the page.
const requestLock = (): Promise<(() => void) | null> =>
  new Promise((resolve, reject) => {
    navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock === null) { resolve(null); return; }
      return new Promise<void>((r) => resolve(r));
    }).catch(reject);
  });
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class SessionPersister {
  private readonly store: SampleStore;
  private readonly engine: CaptureEngine;
  private snap: PersistSnapshot = { status: { kind: 'idle' }, previous: null };
  private readonly listeners = new Set<() => void>();

  private db: SessionDb | null = null;
  private previousSummary: SessionSummary | null = null;
  // What the last successful write left in storage; null until something has been saved.
  private last: FlushMark | null = null;
  private notesDirty = false;
  // The verdict rows last written. The engine replaces the array on every change, never
  // mutates it, so a different reference is a change.
  private savedRows: VerdictRow[] | null = null;
  // A session a failed Restore write left `active` in storage; removed by the next write.
  private orphan: number | null = null;
  private lastFlushAt = 0;
  private persistAsked = false;
  // Flushes, Discard and Restore share one chain, so only one operation is ever in flight.
  private chain: Promise<unknown> = Promise.resolve();
  private flushQueued = false;
  // Bumped by every start() and dispose(): a start that was abandoned (React StrictMode mounts
  // twice) sees a different epoch after each await and stops instead of arming.
  private epoch = 0;
  private releaseLock: (() => void) | null = null;
  private teardown: (() => void)[] = [];

  constructor(store: SampleStore, engine: CaptureEngine) {
    this.store = store;
    this.engine = engine;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snap;

  private publish(patch: Partial<PersistSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setStatus(status: SaveStatus) {
    this.publish({ status });
  }

  async start(): Promise<void> {
    const epoch = ++this.epoch;
    const alive = () => this.epoch === epoch;
    // Without exclusive ownership two pages would interleave segments, so no Web Locks means
    // no saving rather than unsafe saving.
    if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) {
      this.setStatus({ kind: 'unavailable' });
      return;
    }
    let loading: Promise<{ db: SessionDb; previous: SessionSummary | null }> | null = null;
    try {
      // Local until this start is known to be current: a stale start must never release the
      // lock a newer one holds.
      const release = await this.acquireLock(alive);
      if (release === null) return; // disposed while waiting
      if (!alive()) { release(); return; }
      this.releaseLock = release;
      // A page that waited behind another tab takes over its saving now that it has closed.
      if (this.snap.status.kind === 'other-tab') this.setStatus({ kind: 'idle' });
      loading = this.load();
      const { db, previous } = await withTimeout(loading, OPEN_TIMEOUT_MS);
      if (!alive()) { db.close(); return; } // dispose() released the lock
      this.db = db;
      this.previousSummary = previous;
      this.arm();
      this.publish({ previous: previous && { count: previous.count, lastTs: previous.lastTs, mode: previous.mode } });
    } catch {
      if (!alive()) return;
      // Not saving, so not holding the lock either: another tab may save instead. A load that
      // timed out is still running and may still write, so the lock goes once it settles.
      const release = this.releaseLock;
      this.releaseLock = null;
      void (loading ?? Promise.reject()).then(({ db }) => db.close()).catch(() => {}).finally(() => release?.());
      this.setStatus({ kind: 'unavailable' });
    }
  }

  dispose(): void {
    this.epoch++;
    this.teardown.forEach((f) => f());
    this.teardown = [];
    this.releaseLock?.();
    this.releaseLock = null;
    this.db?.close();
    this.db = null;
    this.last = null;
    this.savedRows = null;
    this.orphan = null;
    this.previousSummary = null;
    this.flushQueued = false;
  }

  // Resolves the lock's release; null only when this start was abandoned. Polls fast at first so
  // a reload's old document can let go without the new page reporting another tab, then slowly
  // for as long as another tab owns it, reporting `other-tab` meanwhile. Polled, not queued: a
  // queued request would be granted ahead of the owner's own page when the owner reloads.
  private async acquireLock(alive: () => boolean): Promise<(() => void) | null> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (alive()) {
      const release = await requestLock();
      if (release !== null) return release;
      const waited = Date.now() >= deadline;
      if (waited && this.snap.status.kind !== 'other-tab') this.setStatus({ kind: 'other-tab' });
      await sleep(waited ? LOCK_RETRY_MS : LOCK_POLL_MS);
    }
    return null;
  }

  private write(db: SessionDb, batch: Batch): Promise<void> {
    return withTimeout(db.write(batch), WRITE_TIMEOUT_MS);
  }

  // Whatever a dead page left active becomes THE previous session; anything older is deleted.
  private async load(): Promise<{ db: SessionDb; previous: SessionSummary | null }> {
    const db = await SessionDb.open();
    const rows = await db.summaries();
    const plan = planLoad(rows);
    const keep = rows.find((r) => r.id === plan.keep) ?? null;
    const previous = keep && { ...keep, state: 'previous' as const };
    if (plan.relabel || plan.remove.length > 0) {
      await db.write({ removeSessions: plan.remove, summaries: plan.relabel && previous ? [previous] : [] });
    }
    return { db, previous };
  }

  // Three triggers, because timers alone are not enough: Chrome throttles background-tab timers.
  // The third is `tick()`, driven by the data path, which is not a timer.
  private arm() {
    const flush = () => this.requestFlush();
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    const timer = setInterval(flush, FLUSH_MS);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flush);
    this.teardown.push(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flush);
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Cheap enough to call per batch: reads the clock, and the generation so a clear goes now. */
  tick(): void {
    const cleared = this.last !== null && this.store.generation !== this.last.generation;
    if (cleared || Date.now() - this.lastFlushAt >= FLUSH_MS) this.requestFlush();
  }

  markNotesDirty(): void {
    this.notesDirty = true;
  }

  /** Coalesced: a request while one is already waiting adds nothing. */
  requestFlush(): void {
    if (this.db === null || this.flushQueued) return;
    this.flushQueued = true;
    void this.enqueue(async () => {
      this.flushQueued = false;
      await this.flush();
    });
  }

  private viewOf(now: number): FlushView {
    const ctx = this.engine.context;
    const count = this.store.count;
    return {
      now,
      count,
      firstSeq: this.store.firstSeq,
      generation: this.store.generation,
      firstTs: count > 0 ? this.store.tsAt(0) : null,
      lastTs: count > 0 ? this.store.tsAt(count - 1) : null,
      verdictRows: this.engine.passFailRows.length,
      mode: ctx.mode,
      unit: ctx.unit,
      chartFromSeq: ctx.chartFromSeq,
      modes: [...MODES],
      units: this.store.unitDictionary,
      notesDirty: this.notesDirty,
      verdictsDirty: this.engine.passFailRows !== this.savedRows,
    };
  }

  // Reads the store now, synchronously: the plan describes this instant, and the write is async.
  private batchOf(plan: FlushPlan, rows: VerdictRow[]): Batch {
    const s = plan.summary;
    const batch: Batch = {
      removeSessions: [plan.removeSession, this.orphan].filter((id) => id !== null),
      summaries: s ? [s] : [],
    };
    if (s === null) return batch;
    batch.segments = plan.segments.map(({ seq, n }) => ({
      id: s.id,
      segment: this.store.segment(seq - this.store.firstSeq, n),
    }));
    if (plan.deleteBelow !== null) batch.deleteBelow = { id: s.id, seq: plan.deleteBelow };
    if (plan.writeNotes) batch.notes = { id: s.id, notes: this.store.notes };
    if (plan.writeVerdicts) batch.verdicts = { id: s.id, rows };
    return batch;
  }

  private async flush(): Promise<void> {
    const db = this.db;
    if (db === null) return;
    const now = Date.now();
    this.lastFlushAt = now;
    const view = this.viewOf(now);
    const plan = planFlush(view, this.last);
    if (plan === null) {
      // Only a change is published: a fresh object every 5 s would re-render the page while idle.
      const next: SaveStatus = this.last ? { kind: 'saved', at: now } : { kind: 'idle' };
      if (next.kind !== this.snap.status.kind) this.setStatus(next);
      return;
    }

    const rows = this.engine.passFailRows;
    const batch = this.batchOf(plan, rows);
    // Cleared before the write and merged back on failure: an edit during the await must not
    // be erased by a flag reset after it.
    const notesDirty = this.notesDirty;
    this.notesDirty = false;
    try {
      await this.write(db, batch);
    } catch {
      this.notesDirty ||= notesDirty;
      this.setStatus({ kind: 'failed' });
      return;
    }
    this.savedRows = rows;
    this.orphan = null;
    const s = plan.summary;
    this.last = s ? { summary: s, generation: view.generation } : null;
    this.setStatus(s ? { kind: 'saved', at: Date.now() } : { kind: 'idle' });
    if (s) this.askForPersistentStorage();
  }

  // Best-effort and silent, once: without it storage may be evicted under disk pressure, which
  // the failed and empty-offer paths already tolerate.
  private askForPersistentStorage() {
    if (this.persistAsked) return;
    this.persistAsked = true;
    void navigator.storage?.persist?.().catch(() => undefined);
  }

  /**
   * Replace the live session with the previous one. Any failure before the live session is
   * touched (read, timeout, assembly, an unknown mode) changes nothing — live or stored — and the
   * saved data stays for Discard.
   */
  restore(): Promise<RestoreOutcome> {
    return this.enqueue(async (): Promise<RestoreOutcome> => {
      const db = this.db;
      const prev = this.previousSummary;
      if (db === null || prev === null) return { ok: false, reason: 'no saved session is available' };
      let result: RestoreResult;
      let remapped: boolean;
      try {
        const stored = await withTimeout(db.read(prev.id), RESTORE_TIMEOUT_MS);
        if (stored === null) throw new Error('the saved session is no longer in storage');
        const a = assembleSession(stored.summary, stored.segments, stored.notes, stored.verdicts);
        remapped = this.store.load(a.loadable);
        result = this.engine.restore({ ...a.context, verdicts: a.verdicts });
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
      // The restored session continues as the active one under its own id; this page's own
      // session, now replaced, is deleted in the same transaction. If that write fails, storage
      // still holds the replaced session as `active` — which the next load would offer in place
      // of this one — so the next flush rewrites this one whole and removes it.
      const old = this.last;
      const generation = this.store.generation;
      this.previousSummary = null;
      this.notesDirty = false;
      this.savedRows = this.engine.passFailRows;
      try {
        await this.write(db, { removeSessions: old ? [old.summary.id] : [], summaries: [{ ...prev, state: 'active' }] });
        this.last = adoptedMark(prev, generation, remapped);
        this.publish({ previous: null, status: { kind: 'saved', at: Date.now() } });
      } catch {
        this.last = adoptedMark(prev, generation, true);
        this.orphan = old?.summary.id ?? null;
        this.publish({ previous: null, status: { kind: 'failed' } });
      }
      return { ok: true, result };
    });
  }

  /** The meter's current mode when a reading has set one and it is not the previous session's. */
  otherLiveMode(): string | null {
    const live = this.engine.context.mode;
    const saved = this.previousSummary?.mode ?? null;
    return live !== null && saved !== null && live !== saved ? live : null;
  }

  /** Delete the previous session. Resolves false when storage refused (the offer stays). */
  discard(): Promise<boolean> {
    return this.enqueue(async () => {
      const db = this.db;
      const prev = this.previousSummary;
      if (db === null || prev === null) return false;
      try {
        await this.write(db, { removeSessions: [prev.id] });
      } catch {
        return false;
      }
      this.previousSummary = null;
      this.publish({ previous: null });
      return true;
    });
  }
}
