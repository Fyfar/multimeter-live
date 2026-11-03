// IndexedDB for the saved session: open, list, read one session, and one atomic write. It makes
// no decisions — what to write and when is `lib/persist.ts` and `lib/sessionPersister.ts` — and
// it cannot run under Node (a fake would be a new dependency), so it is exercised by the manual
// checklist in the change's tasks.md. Keep it that thin.

import type { VerdictRow } from './passfail';
import type { SessionSummary } from './persist';
import type { Segment } from './samples';

const DB_NAME = 'multimeter-live';
const DB_VERSION = 1;
const STORES = ['sessions', 'segments', 'notes', 'verdicts'] as const;

export interface Batch {
  // Every record of these sessions, summary included.
  removeSessions?: number[];
  segments?: { id: number; segment: Segment }[];
  // Segments of `id` with seq below `seq`.
  deleteBelow?: { id: number; seq: number };
  summaries?: SessionSummary[];
  notes?: { id: number; notes: [number, string][] };
  verdicts?: { id: number; rows: VerdictRow[] };
}

export interface StoredSession {
  summary: SessionSummary;
  segments: Segment[];
  notes: [number, string][];
  verdicts: VerdictRow[];
}

const request = <T,>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const sessionRange = (id: number, below = Infinity) => IDBKeyRange.bound([id, -Infinity], [id, below], false, true);

export class SessionDb {
  #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
    // A newer tab upgrading the schema must not be blocked by this one.
    db.onversionchange = () => db.close();
  }

  static open(): Promise<SessionDb> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('segments', { keyPath: ['sessionId', 'seq'] });
        db.createObjectStore('notes', { keyPath: 'sessionId' });
        db.createObjectStore('verdicts', { keyPath: 'sessionId' });
      };
      req.onsuccess = () => resolve(new SessionDb(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('database blocked by another connection'));
    });
  }

  close(): void {
    this.#db.close();
  }

  async summaries(): Promise<SessionSummary[]> {
    return request(this.#db.transaction('sessions').objectStore('sessions').getAll());
  }

  async read(id: number): Promise<StoredSession | null> {
    const tx = this.#db.transaction([...STORES]);
    const [summary, segments, notes, verdicts] = await Promise.all([
      request<SessionSummary | undefined>(tx.objectStore('sessions').get(id)),
      request<Segment[]>(tx.objectStore('segments').getAll(sessionRange(id))),
      request<{ notes: [number, string][] } | undefined>(tx.objectStore('notes').get(id)),
      request<{ rows: VerdictRow[] } | undefined>(tx.objectStore('verdicts').get(id)),
    ]);
    return summary ? { summary, segments, notes: notes?.notes ?? [], verdicts: verdicts?.rows ?? [] } : null;
  }

  // One transaction, so a summary never disagrees with the segments it describes. Resolves on
  // `complete` (committed), not on the last request.
  write(batch: Batch): Promise<void> {
    const tx = this.#db.transaction([...STORES], 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
    for (const id of batch.removeSessions ?? []) {
      tx.objectStore('sessions').delete(id);
      tx.objectStore('segments').delete(sessionRange(id));
      tx.objectStore('notes').delete(id);
      tx.objectStore('verdicts').delete(id);
    }
    for (const { id, segment } of batch.segments ?? []) {
      tx.objectStore('segments').put({ ...segment, sessionId: id });
    }
    if (batch.deleteBelow) tx.objectStore('segments').delete(sessionRange(batch.deleteBelow.id, batch.deleteBelow.seq));
    if (batch.notes) tx.objectStore('notes').put({ sessionId: batch.notes.id, notes: batch.notes.notes });
    if (batch.verdicts) tx.objectStore('verdicts').put({ sessionId: batch.verdicts.id, rows: batch.verdicts.rows });
    for (const s of batch.summaries ?? []) tx.objectStore('sessions').put(s);
    return done;
  }
}
